#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SecureFileDropStack } from '../lib/secure-file-drop-stack';

const app = new cdk.App();
new SecureFileDropStack(app, 'SecureFileDropStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
