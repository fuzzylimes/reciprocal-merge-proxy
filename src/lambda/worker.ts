import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import fetch from 'node-fetch';

// Initialize clients
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

// Interface for DynamoDB record
interface RequestRecord {
  requestId: string;
  status: 'queued' | 'in-progress' | 'complete';
  cookie: string;
  dea: string;
  s3Key?: string; // S3 key where response data is stored
  createdAt: number;
  ttl: number;
}

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
      if (requestRecord.status !== 'queued') {
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
          ':status': 'in-progress'
        }
      }));

      // Set up timeout to delete record after 60 seconds
      const timeoutId = setTimeout(async () => {
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

      try {
        // Process the API request
        const result = await processApiRequest(requestRecord.cookie, requestRecord.dea);

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
            ':status': 'complete',
            ':s3Key': s3Key
          }
        }));

        console.log(`Successfully processed request ${requestRecord.requestId}`);

      } catch (error) {
        // Clear the timeout
        clearTimeout(timeoutId);

        console.error(`Error processing request ${requestRecord.requestId}:`, error);

        // Delete the record so it can be retried
        await docClient.send(new DeleteCommand({
          TableName: REQUEST_TABLE_NAME,
          Key: { requestId: requestRecord.requestId }
        }));
      }

    } catch (error) {
      console.error('Error processing DynamoDB stream record:', error);
      // Continue processing other records even if one fails
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

  // Check for other error status codes
  if (!response.ok) {
    throw new Error(`API request failed with status: ${response.status}`);
  }

  // Get response text
  const responseText = await response.text();

  return responseText;
}
