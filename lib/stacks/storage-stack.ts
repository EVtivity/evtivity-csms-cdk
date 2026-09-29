// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Stack, type StackProps, CfnOutput, aws_s3 as s3 } from 'aws-cdk-lib';
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

export interface StorageStackProps extends StackProps {
  config: Config;
}

/**
 * `logs` receives ALB access logs and S3 server access logs. `app` holds
 * support-case attachments and station images under separate prefixes. The
 * API issues presigned URLs, so browsers upload and download directly and the
 * bucket needs CORS for the dashboard and portal origins. With observability
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
      cors:
        origins.length > 0
          ? [
              {
                allowedOrigins: origins,
                allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
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
