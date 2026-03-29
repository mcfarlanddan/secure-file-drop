import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RETENTION_DAYS } from '../shared';

// Note: Reserved concurrency is NOT set by default because:
// - AWS requires at least 100 unreserved concurrent executions per account
// - New accounts often have only 10 total concurrency quota
// - Setting reserved concurrency would fail deployment on these accounts
// See: https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html
// To enable: deploy with -c reservedConcurrency=10 (requires quota >= 110)

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

    // CORS Strategy:
    // - S3 CORS uses '*' because presigned URLs are already authenticated (signed, time-limited)
    // - Lambda Function URL CORS uses '*' but is only accessed via CloudFront (same-origin)
    // - When accessed through CloudFront /api/*, requests are same-origin (no CORS needed)
    // - Direct Lambda URL access is allowed for development/testing only
    // For custom domains: S3 CORS still uses '*' (presigned URLs are secure), no changes needed

    // S3 Bucket (single bucket for uploads and static website)
    // Let CloudFormation generate a unique name (avoids exposing account ID)
    const bucket = new s3.Bucket(this, 'SecureFileDropBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,

      // CORS for browser uploads via presigned URLs
      // Using '*' is secure here because:
      // 1. Presigned URLs are cryptographically signed with expiry
      // 2. Only valid presigned URLs can write to the bucket
      // 3. CORS doesn't add security beyond what presigned URLs already provide
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3600,
      }],

      // Lifecycle rules for cost optimization and cleanup
      lifecycleRules: [
        {
          id: 'AbortIncompleteMultipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(RETENTION_DAYS),
        },
        {
          id: 'CleanupIdempotencyMetadata',
          prefix: 'uploads/_idempotency/',
          expiration: cdk.Duration.days(RETENTION_DAYS),
        },
        {
          id: 'IntelligentTieringForUploads',
          prefix: 'uploads/',
          transitions: [
            {
              // Move to Intelligent-Tiering after 30 days for automatic cost optimization
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // SNS Topic for notifications
    // Let CloudFormation generate a unique name to avoid conflicts on redeploy
    const topic = new sns.Topic(this, 'NotificationTopic');

    topic.addSubscription(
      new snsSubscriptions.EmailSubscription(notificationEmail)
    );

    // Lambda Function
    // Using 512MB for faster cold starts (more CPU allocated)
    const reservedConcurrency = this.node.tryGetContext('reservedConcurrency');
    const uploadLambda = new nodejs.NodejsFunction(this, 'UploadHandler', {
      entry: 'lambda/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      // Reserved concurrency is optional - only set if account has sufficient quota (>= 110)
      // Deploy with: -c reservedConcurrency=10
      ...(reservedConcurrency !== undefined && {
        reservedConcurrentExecutions: Number(reservedConcurrency),
      }),
      environment: {
        BUCKET_NAME: bucket.bucketName,
        SNS_TOPIC_ARN: topic.topicArn,
        NODE_OPTIONS: '--enable-source-maps',
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
    //
    // CORS uses '*' because this API has no ambient credentials (no cookies, no sessions).
    // Without ambient credentials, CORS provides no security value - an attacker's server
    // can make the same requests a browser can. See SECURITY.md for threat analysis.
    const functionUrl = uploadLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ['Content-Type'],
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
    // RemovalPolicy.DESTROY ensures cleanup on stack deletion (prevents orphaned resources)
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
    oac.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

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
    // Uses pay-as-you-go pricing (1TB data transfer + 10M requests/month free tier)
    const distribution = new cloudfront.Distribution(this, 'CDN', {
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
    // Uses the Vite build output from frontend/dist
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./frontend/dist')],
      destinationBucket: bucket,
      destinationKeyPrefix: 'www',
      distribution,
      distributionPaths: ['/*'],
    });

    // =========================================================================
    // CLOUDWATCH ALARMS
    // =========================================================================

    // Lambda error rate alarm - triggers when errors exceed threshold
    // Let CloudFormation generate unique alarm names to avoid conflicts on redeploy
    const errorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmDescription: 'Lambda function error rate exceeded threshold',
      metric: uploadLambda.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

    // Lambda throttle alarm - indicates capacity issues
    const throttleAlarm = new cloudwatch.Alarm(this, 'LambdaThrottleAlarm', {
      alarmDescription: 'Lambda function is being throttled',
      metric: uploadLambda.metricThrottles({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    throttleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

    // Lambda duration alarm - warns of slow responses
    const durationAlarm = new cloudwatch.Alarm(this, 'LambdaDurationAlarm', {
      alarmDescription: 'Lambda function duration approaching timeout',
      metric: uploadLambda.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p99',
      }),
      threshold: 25000, // 25 seconds (timeout is 30s)
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    durationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

    // CloudFront 5xx error rate alarm
    const cloudfront5xxAlarm = new cloudwatch.Alarm(this, 'CloudFront5xxAlarm', {
      alarmDescription: 'CloudFront 5xx error rate exceeded threshold',
      metric: distribution.metricTotalErrorRate({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 5, // 5% error rate
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cloudfront5xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

    // =========================================================================
    // STACK OUTPUTS
    // =========================================================================

    new cdk.CfnOutput(this, 'WebsiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the website',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionUrl', {
      value: functionUrl.url,
      description: 'Lambda Function URL (direct access, bypasses CloudFront)',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket name',
    });

    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: topic.topicArn,
      description: 'SNS Topic ARN for notifications',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID (for cache invalidation)',
    });
  }
}
