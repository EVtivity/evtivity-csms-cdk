// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Stack, type StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SecureBucket } from '../constructs/secure-bucket.js';
import type { Config } from '../config/index.js';

export interface StorageStackProps extends StackProps {
  config: Config;
}

export class StorageStack extends Stack {
  readonly supportAttachmentsBucket: SecureBucket;
  readonly stationImagesBucket: SecureBucket;
  readonly albAccessLogsBucket: SecureBucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.env === 'prod';
    const removal = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.supportAttachmentsBucket = new SecureBucket(this, 'SupportAttachments', {
      bucketName: `evtivity-${config.env}-support-attachments-${this.account}`,
      versioned: config.s3.versioned,
      removalPolicy: removal,
      ...(config.s3.lifecycleDays != null && { lifecycleDays: config.s3.lifecycleDays }),
    });

    this.stationImagesBucket = new SecureBucket(this, 'StationImages', {
      bucketName: `evtivity-${config.env}-station-images-${this.account}`,
      versioned: config.s3.versioned,
      removalPolicy: removal,
    });

    // ALB access logs bucket (separate, no versioning since rotated by retention).
    this.albAccessLogsBucket = new SecureBucket(this, 'AlbAccessLogs', {
      bucketName: `evtivity-${config.env}-alb-access-logs-${this.account}`,
      versioned: false,
      removalPolicy: removal,
      lifecycleDays: config.alb.accessLogsRetentionDays,
    });

    new CfnOutput(this, 'SupportAttachmentsBucketName', {
      value: this.supportAttachmentsBucket.bucketName,
    });
    new CfnOutput(this, 'StationImagesBucketName', {
      value: this.stationImagesBucket.bucketName,
    });
  }
}
