// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Stack, type StackProps, CfnOutput, Duration, aws_s3 as s3 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SecureBucket } from '../constructs/secure-bucket.js';
import type { Config } from '../config/index.js';
import {
  appBucketName,
  logsBucketName,
  grafanaBucketName,
  removalPolicyOf,
  serviceUrl,
} from '../util.js';

/** Where the API puts AI assistant uploads before it has checked them. */
export const AI_UPLOAD_QUARANTINE_PREFIX = 'ai-uploads/quarantine/';

export interface StorageStackProps extends StackProps {
  config: Config;
}

/**
 * `logs` receives ALB access logs and S3 server access logs. `app` holds
 * support-case attachments, station images, and AI assistant uploads under
 * separate prefixes. The API issues presigned URLs (AI uploads use presigned
 * POST), so browsers upload and download directly and the bucket needs CORS
 * for the dashboard and portal origins. AI uploads land in
 * `ai-uploads/quarantine/` until the API has checked them, and anything left
 * there expires after one day. With observability
 * enabled, `grafana` holds Grafana's provisioning files.
 */
export class StorageStack extends Stack {
  readonly logsBucket: SecureBucket;
  readonly appBucket: SecureBucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removal = removalPolicyOf(config.storage.removal);

    this.logsBucket = new SecureBucket(this, 'Logs', {
      bucketName: logsBucketName(config),
      versioned: false,
      removalPolicy: removal,
      expirationDays: config.storage.logsExpirationDays,
    });

    const origins = [
      serviceUrl(config, 'csms'),
      serviceUrl(config, 'portal'),
      ...config.storage.extraCorsOrigins,
    ].filter((o) => o !== '');

    this.appBucket = new SecureBucket(this, 'App', {
      bucketName: appBucketName(config),
      versioned: config.storage.versioned,
      removalPolicy: removal,
      noncurrentVersionExpirationDays: config.storage.noncurrentVersionExpirationDays,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 's3/app/',
      extraLifecycleRules: [
        {
          id: 'expire-ai-upload-quarantine',
          prefix: AI_UPLOAD_QUARANTINE_PREFIX,
          expiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          // Unchecked files must not linger as noncurrent versions either.
          noncurrentVersionExpiration: config.storage.versioned ? Duration.days(1) : undefined,
        },
      ],
      cors:
        origins.length > 0
          ? [
              {
                allowedOrigins: origins,
                allowedMethods: [
                  s3.HttpMethods.GET,
                  s3.HttpMethods.PUT,
                  s3.HttpMethods.POST,
                  s3.HttpMethods.HEAD,
                ],
                allowedHeaders: ['*'],
                exposedHeaders: ['ETag'],
                maxAge: 3000,
              },
            ]
          : undefined,
    });

    if (config.observability.enabled) {
      new SecureBucket(this, 'Grafana', {
        bucketName: grafanaBucketName(config),
        versioned: config.storage.versioned,
        removalPolicy: removal,
        noncurrentVersionExpirationDays: config.storage.noncurrentVersionExpirationDays,
        serverAccessLogsBucket: this.logsBucket,
        serverAccessLogsPrefix: 's3/grafana/',
      });
    }

    new CfnOutput(this, 'AppBucketName', { value: this.appBucket.bucketName });
  }
}
