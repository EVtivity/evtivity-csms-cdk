// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  RemovalPolicy,
  Duration,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface SecureBucketProps {
  bucketName?: string;
  versioned?: boolean;
  removalPolicy?: RemovalPolicy;
  lifecycleDays?: number;
  serverAccessLogsPrefix?: string;
  serverAccessLogsBucket?: s3.IBucket;
}

/**
 * S3 bucket pre-configured to satisfy SecurityHub controls:
 * - Block all public access
 * - Default encryption (SSE-S3, AWS-managed)
 * - SSL/TLS required (enforceSSL bucket policy)
 * - Object ownership: BUCKET_OWNER_ENFORCED (ACLs disabled)
 * - Versioning enabled by default
 * - Auto-delete incomplete multipart uploads after 7 days
 */
export class SecureBucket extends s3.Bucket {
  constructor(scope: Construct, id: string, props: SecureBucketProps = {}) {
    super(scope, id, {
      bucketName: props.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: props.versioned ?? true,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.RETAIN,
      autoDeleteObjects: props.removalPolicy === RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        ...(props.lifecycleDays != null
          ? [
              {
                id: 'expire',
                expiration: Duration.days(props.lifecycleDays),
              },
            ]
          : []),
      ],
      serverAccessLogsBucket: props.serverAccessLogsBucket,
      serverAccessLogsPrefix: props.serverAccessLogsPrefix,
    });
  }
}
