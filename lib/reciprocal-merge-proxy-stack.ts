import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export class ReciprocalMergeProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const allowedOrigin = process.env.ALLOWED_ORIGIN!;

    // Create S3 bucket for storing response data
    const responsesBucket = new s3.Bucket(this, 'ResponsesBucket', {
      bucketName: undefined, // Let CDK generate a unique name
      lifecycleRules: [{
        id: 'DeleteOldResponses',
        expiration: cdk.Duration.days(1),
        enabled: true
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create DynamoDB table for request queue
    const requestTable = new dynamodb.Table(this, 'RequestQueue', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create the worker Lambda function (processes the actual API call)
    const workerFunction = new NodejsFunction(this, 'WorkerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../src/lambda/worker.ts'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(70),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        REQUEST_TABLE_NAME: requestTable.tableName,
        RESPONSES_BUCKET_NAME: responsesBucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['aws-sdk'],
        forceDockerBundling: false,
      },
    });

    // Create the process request Lambda function (handles incoming requests)
    const processRequestFunction = new NodejsFunction(this, 'ProcessRequestFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../src/lambda/processRequest.ts'),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        ALLOWED_ORIGIN: allowedOrigin,
        REQUEST_TABLE_NAME: requestTable.tableName,
        RESPONSES_BUCKET_NAME: responsesBucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['aws-sdk'],
        forceDockerBundling: false,
      },
    });

    // Grant DynamoDB permissions
    requestTable.grantReadWriteData(workerFunction);
    requestTable.grantReadWriteData(processRequestFunction);

    // Grant S3 permissions
    responsesBucket.grantReadWrite(workerFunction);
    responsesBucket.grantRead(processRequestFunction);
    responsesBucket.grantDelete(processRequestFunction);

    // Add DynamoDB stream trigger for worker function
    workerFunction.addEventSource(new DynamoEventSource(requestTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 1, // Process one record at a time
      retryAttempts: 0,
      maxBatchingWindow: cdk.Duration.seconds(0), // Process immediately
      reportBatchItemFailures: true,
    }));

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'ProxyApi', {
      restApiName: 'Proxy API',
      description: 'API to proxy requests to 3rd party service with queue',
      defaultCorsPreflightOptions: {
        allowOrigins: [allowedOrigin],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.days(1),
      },
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
      }
    });

    // Add a resource and POST method
    const proxy = api.root.addResource('proxy');
    proxy.addMethod('POST', new apigateway.LambdaIntegration(processRequestFunction));

    // Output the API URL
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.url}proxy`,
      description: 'The URL of the proxy API',
    });

    // Output the DynamoDB table name
    new cdk.CfnOutput(this, 'RequestTableName', {
      value: requestTable.tableName,
      description: 'The name of the request queue table',
    });
  }
}
