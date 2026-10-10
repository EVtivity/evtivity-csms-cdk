// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RemovalPolicy, Duration, aws_s3 as s3 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface SecureBucketProps {
  bucketName: string;
  versioned: boolean;
  removalPolicy: RemovalPolicy;
  /** Delete current objects after this many days. */
  expirationDays?: number;
  /** Delete noncurrent versions after this many days. */
  noncurrentVersionExpirationDays?: number;
  serverAccessLogsBucket?: s3.IBucket;
  serverAccessLogsPrefix?: string;
  cors?: s3.CorsRule[];
  /** Rules added after the standard ones, for example a prefix that expires early. */
  extraLifecycleRules?: s3.LifecycleRule[];
}

/**
 * S3 bucket that meets the Security Hub S3 controls:
 * - Block Public Access on (S3.8)
 * - SSE-S3 default encryption. ALB access logs only support SSE-S3.
 * - TLS-only bucket policy (S3.5)
 * - ACLs disabled with BucketOwnerEnforced (S3.12)
 * - Lifecycle rules (S3.13), including cleanup of incomplete uploads
 * - Server access logging when a target bucket is given (S3.9)
 */
export class SecureBucket extends s3.Bucket {
  constructor(scope: Construct, id: string, props: SecureBucketProps) {
    const lifecycleRules: s3.LifecycleRule[] = [
      { id: 'abort-incomplete-multipart', abortIncompleteMultipartUploadAfter: Duration.days(7) },
    ];
    if (props.expirationDays != null) {
      lifecycleRules.push({ id: 'expire', expiration: Duration.days(props.expirationDays) });
    }
    if (props.versioned && props.noncurrentVersionExpirationDays != null) {
      lifecycleRules.push({
        id: 'expire-noncurrent',
        noncurrentVersionExpiration: Duration.days(props.noncurrentVersionExpirationDays),
        expiredObjectDeleteMarker: true,
      });
    }
    lifecycleRules.push(...(props.extraLifecycleRules ?? []));
    super(scope, id, {
      bucketName: props.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: props.versioned,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.removalPolicy === RemovalPolicy.DESTROY,
      lifecycleRules,
      serverAccessLogsBucket: props.serverAccessLogsBucket,
      serverAccessLogsPrefix: props.serverAccessLogsPrefix,
      cors: props.cors,
    });
  }
}
