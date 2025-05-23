import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import { ProxyRequest, RequestRecord, requestStatus } from '../models';

// Initialize clients
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Get environment variables
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const REQUEST_TABLE_NAME = process.env.REQUEST_TABLE_NAME!;
  const RESPONSES_BUCKET_NAME = process.env.RESPONSES_BUCKET_NAME!;

  // Default CORS headers to include in all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // Handle OPTIONS preflight request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Max-Age': '86400' // 24 hours
      },
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Parse request body
    const body: ProxyRequest = JSON.parse(event.body || '{}');
    const { cookie, dea } = body;

    // Validate inputs
    if (!cookie || !dea) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }

    // Create hash of cookie + dea combination
    const requestId = crypto
      .createHash('sha256')
      .update(`${cookie}:${dea}`)
      .digest('hex');

    // Check if request already exists in DynamoDB
    const getCommand = new GetCommand({
      TableName: REQUEST_TABLE_NAME,
      Key: { requestId }
    });

    const existingRecord = await docClient.send(getCommand);

    if (existingRecord.Item) {
      const record = existingRecord.Item as RequestRecord;

      switch (record.status) {
        case requestStatus.complete:
          // Get the response data from S3
          if (!record.s3Key) {
            return {
              statusCode: 500,
              headers: corsHeaders,
              body: JSON.stringify({ error: 'Response data not found' })
            };
          }

          try {
            const s3Response = await s3Client.send(new GetObjectCommand({
              Bucket: RESPONSES_BUCKET_NAME,
              Key: record.s3Key
            }));

            const responseData = await s3Response.Body?.transformToString() || '';

            // Clean up - delete both DynamoDB record and S3 object
            await Promise.all([
              docClient.send(new DeleteCommand({
                TableName: REQUEST_TABLE_NAME,
                Key: { requestId }
              })),
              s3Client.send(new DeleteObjectCommand({
                Bucket: RESPONSES_BUCKET_NAME,
                Key: record.s3Key
              }))
            ]);

            return {
              statusCode: 200,
              headers: {
                ...corsHeaders,
                'Content-Type': 'text/html'
              },
              body: responseData
            };

          } catch (s3Error) {
            console.error('Error retrieving response from S3:', s3Error);
            return {
              statusCode: 500,
              headers: corsHeaders,
              body: JSON.stringify({ error: 'Failed to retrieve response data' })
            };
          }

        case requestStatus.inProgress:
          return {
            statusCode: 202,
            headers: corsHeaders,
            body: JSON.stringify({
              status: requestStatus.inProgress,
              message: 'Request is being processed',
              requestId
            })
          };

        case requestStatus.queued:
          return {
            statusCode: 202,
            headers: corsHeaders,
            body: JSON.stringify({
              status: requestStatus.queued,
              message: 'Request is queued for processing',
              requestId
            })
          };
      }
    }

    // Record doesn't exist, create a new one
    const now = Math.floor(Date.now() / 1000);
    const ttl = now + (60 * 60); // 1 hours TTL

    const newRecord: RequestRecord = {
      requestId,
      status: requestStatus.queued,
      cookie,
      dea,
      createdAt: now,
      ttl
    };

    await docClient.send(new PutCommand({
      TableName: REQUEST_TABLE_NAME,
      Item: newRecord
    }));

    return {
      statusCode: 202,
      headers: corsHeaders,
      body: JSON.stringify({
        status: requestStatus.queued,
        message: 'Request has been queued for processing',
        requestId
      })
    };

  } catch (error) {
    console.error('Error processing request:', error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Failed to process request',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
