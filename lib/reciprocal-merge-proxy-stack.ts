import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export class ReciprocalMergeProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const allowedOrigin = process.env.ALLOWED_ORIGIN!;
    // const allowedOrigin = '*'; // Uncomment for local testing

    // Create Lambda function
    const proxyFunction = new NodejsFunction(this, 'ProxyFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../src/lambda/proxy.ts'), // Point directly to your TS file
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        ALLOWED_ORIGIN: allowedOrigin,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,           // Minify code for production
        sourceMap: true,        // Include source maps for better debugging
        externalModules: [      // Modules that should be excluded from bundling
          'aws-sdk',            // AWS SDK is available in the Lambda environment
        ],
        forceDockerBundling: false, // Prefer local bundling with esbuild
      },
    });

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'ProxyApi', {
      restApiName: 'Proxy API',
      description: 'API to proxy requests to 3rd party service',
      defaultCorsPreflightOptions: {
        allowOrigins: [allowedOrigin],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.days(1),
      },
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false, // Set to true for debugging, but false in production for security
        metricsEnabled: true,
      }
    });

    // Add a resource and POST method
    const proxy = api.root.addResource('proxy');
    proxy.addMethod('POST', new apigateway.LambdaIntegration(proxyFunction));

    // Output the API URL
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.url}proxy`,
      description: 'The URL of the proxy API',
    });
  }
}
