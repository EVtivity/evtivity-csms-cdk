// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Stack,
  type StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  aws_ec2 as ec2,
  aws_rds as rds,
  aws_elasticache as elasticache,
  aws_secretsmanager as secrets,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';

export interface DataStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  auroraSg: ec2.ISecurityGroup;
  redisSg: ec2.ISecurityGroup;
}

export class DataStack extends Stack {
  readonly cluster: rds.DatabaseCluster;
  readonly databaseUrlSecret: secrets.Secret;
  readonly redisUrlSecret: secrets.Secret;
  readonly redisAuthSecret: secrets.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config, vpc, auroraSg, redisSg } = props;
    const namePrefix = `evtivity/${config.env}`;
    const isProd = config.env === 'prod';

    // --- Aurora PostgreSQL Serverless v2 ---

    this.cluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      defaultDatabaseName: 'evtivity',
      credentials: rds.Credentials.fromGeneratedSecret('evtivity', {
        secretName: `${namePrefix}/aurora-master`,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [auroraSg],
      writer: rds.ClusterInstance.serverlessV2('writer', {
        autoMinorVersionUpgrade: config.aurora.autoMinorVersionUpgrade,
        publiclyAccessible: false,
        enablePerformanceInsights: isProd,
      }),
      readers:
        config.aurora.instanceCount > 1
          ? Array.from({ length: config.aurora.instanceCount - 1 }, (_, i) =>
              rds.ClusterInstance.serverlessV2(`reader${String(i + 1)}`, {
                autoMinorVersionUpgrade: config.aurora.autoMinorVersionUpgrade,
                publiclyAccessible: false,
                scaleWithWriter: true,
                enablePerformanceInsights: isProd,
              }),
            )
          : [],
      serverlessV2MinCapacity: config.aurora.minCapacity,
      serverlessV2MaxCapacity: config.aurora.maxCapacity,
      backup: { retention: Duration.days(config.aurora.backupRetentionDays) },
      iamAuthentication: config.aurora.iamAuthentication,
      storageEncrypted: true, // AWS-managed key
      deletionProtection: config.aurora.deletionProtection,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
    });

    // Composed DATABASE_URL secret (postgres://user:pass@host:port/db).
    this.databaseUrlSecret = new secrets.Secret(this, 'DatabaseUrl', {
      secretName: `${namePrefix}/database-url`,
      description: 'Composed Postgres connection URL for application use',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'placeholder',
      },
    });

    // Build URL from cluster endpoint + master secret. Done via SecretAttachment hooks below
    // would require Lambda; instead we expose endpoint and master secret to consumers and let
    // them compose the URL at runtime. To keep YAML simple, services reference the master
    // secret JSON keys via secretsFromSecretsManager: e.g., DATABASE_HOST: <secret>:host.
    // Override the placeholder once the cluster reports its endpoint:
    new CfnOutput(this, 'AuroraEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Aurora cluster writer endpoint',
    });
    new CfnOutput(this, 'AuroraMasterSecretArn', {
      value: this.cluster.secret?.secretArn ?? 'unknown',
    });

    // --- ElastiCache Redis ---

    this.redisAuthSecret = new secrets.Secret(this, 'RedisAuth', {
      secretName: `${namePrefix}/redis-auth-token`,
      description: 'Redis AUTH token',
      generateSecretString: {
        excludeCharacters: '"@/\\\'',
        passwordLength: 64,
      },
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: `EVtivity ${config.env} Redis`,
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: `EVtivity ${config.env} Redis`,
      engine: 'redis',
      cacheNodeType: config.redis.nodeType,
      numCacheClusters: 1 + config.redis.replicas,
      automaticFailoverEnabled: config.redis.automaticFailoverEnabled,
      multiAzEnabled: config.redis.multiAz,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [redisSg.securityGroupId],
      atRestEncryptionEnabled: true, // AWS-managed key
      transitEncryptionEnabled: true,
      authToken: this.redisAuthSecret.secretValue.unsafeUnwrap(),
      snapshotRetentionLimit: config.redis.snapshotRetentionLimit,
      autoMinorVersionUpgrade: true,
    });
    redis.addDependency(subnetGroup);

    // Composed REDIS_URL: rediss://:authToken@host:6379
    this.redisUrlSecret = new secrets.Secret(this, 'RedisUrl', {
      secretName: `${namePrefix}/redis-url`,
      description: 'Composed Redis connection URL for application use',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'placeholder',
      },
    });

    new CfnOutput(this, 'RedisPrimaryEndpoint', {
      value: redis.attrPrimaryEndPointAddress,
    });
    new CfnOutput(this, 'RedisAuthSecretArn', {
      value: this.redisAuthSecret.secretArn,
    });
  }
}
