import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class SecureFileDropStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get notification email from context (required on first deploy)
    const notificationEmail = this.node.tryGetContext('notificationEmail');
    if (!notificationEmail) {
      throw new Error(
        'notificationEmail context parameter is required. ' +
        'Deploy with: npx cdk deploy -c notificationEmail=your@email.com'
      );
    }

    // S3 Bucket (single bucket for uploads and static website)
    // Let CloudFormation generate a unique name (avoids exposing account ID)
    const bucket = new s3.Bucket(this, 'SecureFileDropBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,

      // CORS for browser uploads via presigned URLs
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3600,
      }],

      // Auto-cleanup incomplete multipart uploads after 7 days
      lifecycleRules: [{
        id: 'AbortIncompleteMultipart',
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
    });

    // SNS Topic for notifications
    const topic = new sns.Topic(this, 'NotificationTopic', {
      topicName: 'secure-file-drop-notifications',
    });

    topic.addSubscription(
      new snsSubscriptions.EmailSubscription(notificationEmail)
    );

    // Lambda Function
    const uploadLambda = new nodejs.NodejsFunction(this, 'UploadHandler', {
      entry: 'lambda/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        SNS_TOPIC_ARN: topic.topicArn,
        CHUNK_SIZE: '67108864', // 64MB
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Grant Lambda permissions for S3 multipart operations
    bucket.grantReadWrite(uploadLambda);
    uploadLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:CreateMultipartUpload',
        's3:UploadPart',
        's3:CompleteMultipartUpload',
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
      ],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
    }));
    topic.grantPublish(uploadLambda);

    // Lambda Function URL (simple, no API Gateway needed)
    const functionUrl = uploadLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ['*'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Since October 2025, Lambda Function URLs require BOTH permissions:
    // 1. lambda:InvokeFunctionUrl (added by addFunctionUrl with authType NONE)
    // 2. lambda:InvokeFunction with InvokedViaFunctionUrl condition (added below)
    // See: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
    uploadLambda.addPermission('PublicInvokeViaFunctionUrl', {
      principal: new iam.ArnPrincipal('*'),
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
    });

    // CloudFront Origin Access Control for S3
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // Lambda Function URL origin (for /api/*)
    // Extract domain from function URL (format: https://xxx.lambda-url.region.on.aws/)
    const lambdaUrlDomain = cdk.Fn.select(2, cdk.Fn.split('/', functionUrl.url));
    const lambdaOrigin = new origins.HttpOrigin(lambdaUrlDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // S3 origin (for static files from www/ prefix)
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket, {
      originAccessControl: oac,
      originPath: '/www',
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'CDN', {
      // Free flat-rate plan requires Web ACL and doesn't allow custom price class
      webAclId: 'arn:aws:wafv2:us-east-1:954016962717:global/webacl/CreatedByCloudFront-9cb4ba0f/c5f2f7b6-1ae9-4491-b5e4-21dcc942c22d',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: lambdaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // CRITICAL: Must exclude Host header or Lambda Function URL returns 403
          // Lambda Function URLs validate the Host header matches their domain
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [{
        httpStatus: 404,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
      }],
    });

    // Bucket policy for CloudFront OAC access to www/ prefix
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [`${bucket.bucketArn}/www/*`],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${distribution.distributionId}`,
        },
      },
    }));

    // Deploy frontend to S3 www/ prefix
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./frontend')],
      destinationBucket: bucket,
      destinationKeyPrefix: 'www',
      distribution,
      distributionPaths: ['/*'],
    });

    // Stack Outputs
    new cdk.CfnOutput(this, 'WebsiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the website',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionUrl', {
      value: functionUrl.url,
      description: 'Lambda Function URL (direct access)',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket name',
    });

    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: topic.topicArn,
      description: 'SNS Topic ARN for notifications',
    });
  }
}
