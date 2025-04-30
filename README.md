# Reciprocal Merge (Proxy)

This is a companion project for the [Reciprocal Merge](https://github.com/fuzzylimes/reciprocal-merge) tool, used to proxy requests to the 3rd party service that handles DEA lookups.

If none of that means anything to you, then there's most likely nothing here of value for you.

## About

Simple AWS CDK app that sets up an API gateway and a single lambda. That's seriously all it is.

## Useful commands
* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
