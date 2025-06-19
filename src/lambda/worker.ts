import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import fetch from 'node-fetch';
import { RequestRecord, requestStatus } from '../models';

// Initialize clients
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  const REQUEST_TABLE_NAME = process.env.REQUEST_TABLE_NAME!;
  const RESPONSES_BUCKET_NAME = process.env.RESPONSES_BUCKET_NAME!;

  // Process each record in the stream
  for (const record of event.Records) {
    try {
      // Only process INSERT events for new records
      if (record.eventName !== 'INSERT') {
        continue;
      }

      // Extract the new record data
      if (!record.dynamodb?.NewImage) {
        console.log('No new image in record, skipping');
        continue;
      }

      const requestRecord = unmarshall(record.dynamodb.NewImage as Record<string, any>) as RequestRecord;

      // Only process records that are queued
      if (requestRecord.status !== requestStatus.queued) {
        console.log(`Record ${requestRecord.requestId} is not queued, skipping`);
        continue;
      }

      console.log(`Processing request ${requestRecord.requestId}`);

      // Update status to in-progress
      await docClient.send(new UpdateCommand({
        TableName: REQUEST_TABLE_NAME,
        Key: { requestId: requestRecord.requestId },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':status': requestStatus.inProgress
        }
      }));

      // Shared flag to prevent race conditions between timeout and completion
      let isCompleted = false;

      // In order to account for the API being slow, we create a timer that will wait for 60 seconds. The
      // function is set to run for 70 seconds. If for whatever reason we don't get a response in 60 seconds,
      // we're going to abort and cleanup.
      const timeoutId = setTimeout(async () => {
        // Check if already completed to avoid race condition
        if (isCompleted) {
          return;
        }
        isCompleted = true;

        try {
          console.log(`Timeout reached for request ${requestRecord.requestId}, deleting record`);
          await docClient.send(new DeleteCommand({
            TableName: REQUEST_TABLE_NAME,
            Key: { requestId: requestRecord.requestId }
          }));
        } catch (error) {
          console.error(`Error deleting timed out record ${requestRecord.requestId}:`, error);
        }
      }, 60000);

      // Process the API request
      try {
        const result = await processApiRequest(requestRecord.cookie, requestRecord.dea);

        // Check if timeout already fired to avoid race condition
        if (isCompleted) {
          console.log(`Request ${requestRecord.requestId} completed after timeout, ignoring result`);
          return;
        }
        isCompleted = true;

        // Clear the timeout since we got a response
        clearTimeout(timeoutId);

        // Store response in S3
        const s3Key = `responses/${requestRecord.requestId}.html`;
        await s3Client.send(new PutObjectCommand({
          Bucket: RESPONSES_BUCKET_NAME,
          Key: s3Key,
          Body: result,
          ContentType: 'text/html'
        }));

        // Update the record with the S3 key and complete status
        await docClient.send(new UpdateCommand({
          TableName: REQUEST_TABLE_NAME,
          Key: { requestId: requestRecord.requestId },
          UpdateExpression: 'SET #status = :status, #s3Key = :s3Key',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#s3Key': 's3Key'
          },
          ExpressionAttributeValues: {
            ':status': requestStatus.complete,
            ':s3Key': s3Key
          }
        }));

        console.log(`Successfully processed request ${requestRecord.requestId}`);

      } catch (error) {
        // Clear the timeout
        clearTimeout(timeoutId);

        console.error(`Error processing request ${requestRecord.requestId}:`, error);

        // Delete the record so it can be retried
        // If for whatever reason the Update command fails, the doc in s3 will automatically be cleaned up after an hour.
        await docClient.send(new DeleteCommand({
          TableName: REQUEST_TABLE_NAME,
          Key: { requestId: requestRecord.requestId }
        }));
      }

    } catch (error) {
      console.error('Error processing DynamoDB stream record:', error);
    }
  }
};

async function processApiRequest(cookie: string, dea: string): Promise<string> {
  // Sanitize DEA number (basic validation)
  const sanitizedDea = dea.replace(/[^a-zA-Z0-9]/g, '');

  // Prepare the request to API (same logic as original proxy)
  const postData = `helpmode=off&Database=Practitioner&quickSearch=&postHsiId=&postSourceId=&postSourceType=&singleSearch=&postSearchKey=&sUniverseSource=HCP-SLN&license=${sanitizedDea}&licdea_criteria=EM&last_name=&lastname_criteria=SW&first_name=&firstname_criteria=SW&middle_name=&middlename_criteria=SW&selState=States&hdnState=States&hdnSelBac=&hdnProfDesigAma=&hdnSelTaxonomyDescr=&hdnSelProfDesig=&hdnSelBestStatus=&sActiveLicense=&street_address=&street_address_criteria=SW&city=&city_criteria=SW&sAddressState=&license_zip=&hdnSelSanctionSource=&medproid=&medpromasterid=&hospital_name=&hospital_name_criteria=SW&group_practice=&group_practice_criteria=SW&customerid=&selSearchType=&SearchText2=&sSpecialty=&txtExpiresAfter=&sSamp=&sCertType=&sPrimSecSpecialty=&sTaxonomyCodeDescr=&sTaxonomyCode=&sSubset=&sRecordType=&sClassOfTradeDescr=&sClassOfTradeCode=&advsearch=inline&txtDetailCopy=`;

  // Call API
  const response = await fetch('https://www.medproid.com/WebID.asp?action=DeaQuery&advquery=inline&Database=Practitioner&resetQS=N', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie
    },
    body: postData
  });

  // Handle potential redirects
  if (response.status === 301 || response.status === 302) {
    throw new Error(`Redirect response from API: ${response.status}, Location: ${response.headers.get('location')}`);
  }

  // Even if this is an error, we want to return the text. The caller can deal with it.
  const responseText = await response.text();

  return responseText;
}
