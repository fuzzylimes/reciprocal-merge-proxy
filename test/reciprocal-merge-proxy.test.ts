import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ReciprocalMergeProxyStack } from '../lib/reciprocal-merge-proxy-stack';

describe('ReciprocalMergeProxyStack', () => {
  let template: Template;

  beforeAll(() => {
    process.env.ALLOWED_ORIGIN = 'https://example.com';
    const app = new cdk.App();
    const stack = new ReciprocalMergeProxyStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  test('synthesizes without throwing', () => {
    expect(template).toBeDefined();
  });

  test('creates the request queue table and responses bucket', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  test('creates both lambda functions', () => {
    // 3, not 2: CDK inserts its own LogRetention custom-resource function
    // alongside WorkerFunction and ProcessRequestFunction (via the deprecated
    // `logRetention` prop).
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  test('exposes a POST /proxy endpoint', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
  });
});
