import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export class ReciprocalMergeProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // GitHub Pages domain - you'll need to update this
    const allowedOrigin = process.env.ALLOWED_ORIGIN!;

    // Create Lambda function
    const proxyFunction = new lambda.Function(this, 'ProxyFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'dist/proxy.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda'), {
        // Bundle the Lambda code using esbuild to handle TypeScript and ESM modules
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c', [
              'npm install',
              'npm run build',
              'cp -r dist/* /asset-output/',
              'cp package.json /asset-output/',
              'cd /asset-output',
              'npm install --production'
            ].join(' && ')
          ],
        },
      }),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        ALLOWED_ORIGIN: allowedOrigin,
        NODE_OPTIONS: '--enable-source-maps',
      }
    });

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'ProxyApi', {
      restApiName: ' Proxy API',
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
