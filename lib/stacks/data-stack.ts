// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { join } from 'node:path';
import {
  ArnFormat,
  Stack,
  type StackProps,
  Duration,
  CfnOutput,
  aws_ec2 as ec2,
  aws_rds as rds,
  aws_elasticache as elasticache,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/index.js';
import { enabledCacheUsers, loadRedisAclRules, type CacheUserName } from '../redis-acl.js';
import { namePrefix, removalPolicyOf, secretPrefix } from '../util.js';

export interface DataStackProps extends StackProps {
  config: Config;
  vpc: ec2.IVpc;
  ecsSg: ec2.ISecurityGroup;
  rotationSg: ec2.ISecurityGroup;
}

/** Characters left out of generated passwords so they survive URLs and shells. */
const PASSWORD_EXCLUDE = ' %+~`#$&*()|[]{}:;<>?!\'/@"\\,=^';

// The cluster's owner role. Migrations run as this role so it owns every table.
const MASTER_USERNAME = 'evtivity_admin';
// Application login. Rotation alternates between this role and <name>_clone.
const APP_USERNAME = 'evtivity_app';
// Legacy shared Valkey user, unused since the per-service users (removed next release).
const CACHE_USERNAME = 'evtivity';

/**
 * Aurora PostgreSQL, ElastiCache Valkey, and the application secrets.
 *
 * Credential model:
 * - `db-master`: cluster owner. Used only by the database job (migrations,
 *   role bootstrap, seeds). Single-user rotation.
 * - `db-app`: what the services use. Multi-user rotation alternates between
 *   two roles that share one group role, so the previous credential stays
 *   valid for one full interval while tasks restart.
 * - `cache-<service>`: one Valkey RBAC user per service, permissions from
 *   config/redis-acl-rules.conf. A custom rotation function keeps the current
 *   and pending passwords active on the user at the same time. `cache-app`
 *   is the legacy shared user, kept unused for one release.
 * - `jwt`, `settings-encryption-key`, `initial-admin`: static (EXC-003).
 */
export class DataStack extends Stack {
  readonly cluster: rds.DatabaseCluster;
  readonly masterSecret: rds.DatabaseSecret;
  readonly appDbSecret: secretsmanager.ISecret;
  /** Valkey credentials of each enabled service that uses Valkey. */
  readonly cacheSecrets: Partial<Record<CacheUserName, secretsmanager.Secret>> = {};
  readonly cacheHost: string;
  readonly cachePort = 6379;
  readonly jwtSecret: secretsmanager.Secret;
  readonly settingsKeySecret: secretsmanager.Secret;
  readonly initialAdminSecret: secretsmanager.Secret;
  readonly databaseName = 'evtivity';
  /** Aurora's exported PostgreSQL log and the Valkey slow log. */
  readonly postgresLogs: logs.LogGroup;
  readonly valkeySlowLog: logs.LogGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc, ecsSg, rotationSg } = props;
    const prefix = namePrefix(config);
    const sp = secretPrefix(config);
    const a = config.aurora;
    const rotationSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    const secretRemoval = removalPolicyOf(config.secrets.removal);

    const auroraSg = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      description: 'EVtivity Aurora PostgreSQL',
      allowAllOutbound: false,
    });
    const valkeySg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc,
      description: 'EVtivity ElastiCache Valkey',
      allowAllOutbound: false,
    });
    // Tasks and the database job connect as clients. Rotation functions
    // connect to verify new credentials.
    for (const source of [ecsSg, rotationSg]) {
      auroraSg.addIngressRule(source, ec2.Port.tcp(5432), 'Postgres');
      valkeySg.addIngressRule(source, ec2.Port.tcp(this.cachePort), 'Valkey');
    }

    // --- Aurora PostgreSQL ---

    const major = a.engineVersion.split('.')[0] ?? a.engineVersion;
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.of(a.engineVersion, major),
    });

    const parameterGroup = new rds.ParameterGroup(this, 'ClusterParams', {
      engine,
      description: `${prefix} Aurora PostgreSQL`,
      parameters: {
        // Reject unencrypted client connections.
        'rds.force_ssl': '1',
      },
    });

    this.masterSecret = new rds.DatabaseSecret(this, 'MasterSecret', {
      secretName: `${sp}/db-master`,
      username: MASTER_USERNAME,
      excludeCharacters: PASSWORD_EXCLUDE,
    });

    // Readers go to the AZs after the first, so they do not all land next
    // to a writer that RDS placed in the first AZ. The writer stays
    // unpinned: setting the AZ on an existing writer replaces it.
    const azs = config.vpc.availabilityZones;
    const placement = (index: number): { availabilityZone?: string } =>
      index > 0 ? { availabilityZone: azs[index % azs.length] ?? '' } : {};
    const instance = (name: string, isReader: boolean, index: number): rds.IClusterInstance =>
      a.mode === 'serverless'
        ? rds.ClusterInstance.serverlessV2(name, {
            publiclyAccessible: false,
            autoMinorVersionUpgrade: true,
            scaleWithWriter: isReader,
            enablePerformanceInsights: a.performanceInsights,
            ...placement(index),
          })
        : rds.ClusterInstance.provisioned(name, {
            instanceType: new ec2.InstanceType(a.instanceClass),
            publiclyAccessible: false,
            autoMinorVersionUpgrade: true,
            enablePerformanceInsights: a.performanceInsights,
            ...placement(index),
          });

    // Aurora writes its exported log here. Owning the group sets its
    // retention and deletes it with the stack. Otherwise RDS creates it on
    // first write with no retention, and it outlives the environment.
    this.postgresLogs = new logs.LogGroup(this, 'PostgresLogs', {
      logGroupName: `/aws/rds/cluster/${prefix}/postgresql`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    });

    this.cluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine,
      clusterIdentifier: prefix,
      credentials: rds.Credentials.fromSecret(this.masterSecret),
      defaultDatabaseName: this.databaseName,
      parameterGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [auroraSg],
      writer: instance('writer', false, 0),
      readers: Array.from({ length: a.readers }, (_, i) =>
        instance(`reader${String(i + 1)}`, true, i + 1),
      ),
      ...(a.mode === 'serverless' && {
        serverlessV2MinCapacity: a.minCapacity,
        serverlessV2MaxCapacity: a.maxCapacity,
        ...(a.minCapacity === 0 && {
          serverlessV2AutoPauseDuration: Duration.seconds(a.autoPauseSeconds),
        }),
      }),
      backup: {
        retention: Duration.days(a.backupRetentionDays),
        ...(a.preferredBackupWindow != null && { preferredWindow: a.preferredBackupWindow }),
      },
      ...(a.preferredMaintenanceWindow != null && {
        preferredMaintenanceWindow: a.preferredMaintenanceWindow,
      }),
      storageEncrypted: true,
      copyTagsToSnapshot: true,
      deletionProtection: a.deletionProtection,
      removalPolicy: removalPolicyOf(a.removal),
      iamAuthentication: a.iamAuthentication,
      cloudwatchLogsExports: ['postgresql'],
      enablePerformanceInsights: a.performanceInsights,
      ...(a.monitoringIntervalSeconds > 0 && {
        monitoringInterval: Duration.seconds(a.monitoringIntervalSeconds),
      }),
    });

    this.cluster.node.addDependency(this.postgresLogs);

    const appSecret = new rds.DatabaseSecret(this, 'AppDbSecret', {
      secretName: `${sp}/db-app`,
      username: APP_USERNAME,
      masterSecret: this.masterSecret,
      excludeCharacters: PASSWORD_EXCLUDE,
    });
    this.appDbSecret = appSecret.attach(this.cluster);
    // With secrets.removal: retain, a retained database snapshot keeps its
    // roles. Keep their passwords too, or a rebuild needs manual resets.
    this.masterSecret.applyRemovalPolicy(secretRemoval);
    appSecret.applyRemovalPolicy(secretRemoval);

    if (config.rotation.enabled) {
      const automaticallyAfter = Duration.days(config.rotation.databaseDays);
      // Secrets Manager hosted rotation: AWS deploys and maintains the
      // rotation function through the AWS::SecretsManager transform.
      const clusterSecret = this.cluster.secret;
      if (clusterSecret == null) throw new Error('Aurora cluster has no attached master secret');
      const network = {
        vpc,
        vpcSubnets: rotationSubnets,
        securityGroups: [rotationSg],
        excludeCharacters: PASSWORD_EXCLUDE,
      };
      // The hosted rotation functions log to /aws/lambda/<functionName>.
      // Own those groups so they get retention and go away with the stack.
      const rotationLogs = (name: string): logs.LogGroup =>
        new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${prefix}-${name}`,
          retention: config.logs.retentionDays,
          removalPolicy: removalPolicyOf(config.logs.removal),
        });
      const masterLogs = rotationLogs('db-master-rotation');
      const appLogs = rotationLogs('db-app-rotation');
      const masterRotation = clusterSecret.addRotationSchedule('MasterRotation', {
        hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
          ...network,
          functionName: `${prefix}-db-master-rotation`,
        }),
        automaticallyAfter,
      });
      masterRotation.node.addDependency(masterLogs);
      const appRotation = this.appDbSecret.addRotationSchedule('AppDbRotation', {
        hostedRotation: secretsmanager.HostedRotation.postgreSqlMultiUser({
          ...network,
          masterSecret: clusterSecret,
          functionName: `${prefix}-db-app-rotation`,
        }),
        automaticallyAfter,
        // The app role does not exist until the database job creates it, and
        // the rotation copies that role's memberships to the clone. Rotating
        // before the job runs would give the clone no privileges.
        rotateImmediatelyOnUpdate: false,
      });
      appRotation.node.addDependency(appLogs);
    }

    // --- ElastiCache Valkey ---

    const cacheUserId = `${prefix}-app`;
    const cacheUserArn = this.formatArn({
      service: 'elasticache',
      resource: 'user',
      resourceName: cacheUserId,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    // Legacy shared user (`cache-app`, `on ~* &* ...`). No service uses it
    // since the per-service users below. It stays for one release: the user
    // group update ends the connections of a removed user before AppStack has
    // replaced the tasks that still use it, and AppStack of the previous
    // release imports this secret. The next release deletes the user, the
    // secret, and the exportValue below (docs/todo in the CSMS repo).
    const legacyCacheSecret = new secretsmanager.Secret(this, 'CacheSecret', {
      secretName: `${sp}/cache-app`,
      description: 'Legacy shared Valkey RBAC user (unused, removed in the next release)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: CACHE_USERNAME, user_arn: cacheUserArn }),
        generateStringKey: 'password',
        passwordLength: 64,
        excludeCharacters: PASSWORD_EXCLUDE,
      },
      removalPolicy: secretRemoval,
    });

    const cacheUser = new elasticache.CfnUser(this, 'CacheUser', {
      userId: cacheUserId,
      userName: CACHE_USERNAME,
      engine: 'valkey',
      // Unchanged from the previous release, so tasks still running it keep
      // working until AppStack replaces them.
      accessString: 'on ~* &* +@all -@dangerous +info',
      passwords: [legacyCacheSecret.secretValueFromJson('password').unsafeUnwrap()],
    });
    // Keeps the export the previous release's AppStack imports.
    this.exportValue(legacyCacheSecret.secretArn);

    // One Valkey user per service (config/redis-acl-rules.conf): its own keys,
    // channels, and commands, so a leaked credential of one service cannot
    // command stations or touch another service's data. Commands: everything
    // except @dangerous (FLUSHALL, CONFIG, DEBUG, KEYS, ...), plus INFO, which
    // BullMQ reads for the server version.
    const aclRules = loadRedisAclRules();
    const serviceUsers: elasticache.CfnUser[] = [];
    const cacheUserArns = [cacheUserArn];
    for (const user of enabledCacheUsers(config)) {
      const userId = `${prefix}-${user}`;
      const userArn = this.formatArn({
        service: 'elasticache',
        resource: 'user',
        resourceName: userId,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      });
      const secret = new secretsmanager.Secret(this, `CacheSecret-${user}`, {
        secretName: `${sp}/cache-${user}`,
        description: `Valkey RBAC user of the EVtivity ${user} service`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: user, user_arn: userArn }),
          generateStringKey: 'password',
          passwordLength: 64,
          excludeCharacters: PASSWORD_EXCLUDE,
        },
        removalPolicy: secretRemoval,
      });
      serviceUsers.push(
        new elasticache.CfnUser(this, `CacheUser-${user}`, {
          userId,
          userName: user,
          engine: 'valkey',
          // Changing this updates the user, which also resets its passwords to
          // the current secret: redeploy services after a change.
          accessString: aclRules[user],
          // Initial password only. After a rotation the user holds the current
          // and pending passwords, set by the rotation function.
          passwords: [secret.secretValueFromJson('password').unsafeUnwrap()],
        }),
      );
      this.cacheSecrets[user] = secret;
      cacheUserArns.push(userArn);
    }
    const rotatedCacheSecrets = [legacyCacheSecret, ...Object.values(this.cacheSecrets)];

    const userGroup = new elasticache.CfnUserGroup(this, 'CacheUserGroup', {
      userGroupId: `${prefix}-app`,
      engine: 'valkey',
      userIds: [cacheUserId, ...serviceUsers.map((u) => u.userId)],
    });
    userGroup.addResourceDependency(cacheUser);
    for (const u of serviceUsers) userGroup.addResourceDependency(u);

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'ValkeySubnets', {
      cacheSubnetGroupName: prefix,
      description: `${prefix} Valkey`,
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    const valkeyMajor = config.valkey.engineVersion.split('.')[0] ?? config.valkey.engineVersion;
    const params = new elasticache.CfnParameterGroup(this, 'ValkeyParams', {
      cacheParameterGroupFamily: `valkey${valkeyMajor}`,
      description: `${prefix} Valkey`,
      properties: {
        ...config.valkey.parameters,
        // BullMQ requires noeviction. Evicted keys silently lose queued jobs.
        'maxmemory-policy': 'noeviction',
      },
    });

    const slowLog = (this.valkeySlowLog = new logs.LogGroup(this, 'ValkeySlowLog', {
      logGroupName: `/evtivity/${config.env}/valkey-slow-log`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    }));

    const replicated = config.valkey.replicas > 0;
    const valkey = new elasticache.CfnReplicationGroup(this, 'Valkey', {
      replicationGroupId: prefix,
      replicationGroupDescription: `${prefix} Valkey`,
      engine: 'valkey',
      engineVersion: config.valkey.engineVersion,
      cacheNodeType: config.valkey.nodeType,
      numCacheClusters: 1 + config.valkey.replicas,
      automaticFailoverEnabled: replicated,
      multiAzEnabled: replicated,
      cacheSubnetGroupName: subnetGroup.ref,
      cacheParameterGroupName: params.ref,
      securityGroupIds: [valkeySg.securityGroupId],
      port: this.cachePort,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      transitEncryptionMode: 'required',
      userGroupIds: [userGroup.ref],
      snapshotRetentionLimit: config.valkey.snapshotRetentionDays,
      ...(config.valkey.snapshotWindow != null && { snapshotWindow: config.valkey.snapshotWindow }),
      ...(config.valkey.maintenanceWindow != null && {
        preferredMaintenanceWindow: config.valkey.maintenanceWindow,
      }),
      autoMinorVersionUpgrade: true,
      logDeliveryConfigurations: [
        {
          logType: 'slow-log',
          logFormat: 'json',
          destinationType: 'cloudwatch-logs',
          destinationDetails: { cloudWatchLogsDetails: { logGroup: slowLog.logGroupName } },
        },
      ],
    });
    valkey.addResourceDependency(subnetGroup);
    valkey.addResourceDependency(userGroup);
    this.cacheHost = valkey.attrPrimaryEndPointAddress;

    if (config.rotation.enabled) {
      const fnLogs = new logs.LogGroup(this, 'CacheRotationLogs', {
        logGroupName: `/evtivity/${config.env}/cache-rotation`,
        retention: config.logs.retentionDays,
        removalPolicy: removalPolicyOf(config.logs.removal),
      });
      const fn = new lambdaNodejs.NodejsFunction(this, 'CacheRotationFn', {
        entry: join(import.meta.dirname, '../../lambda/valkey-rotation.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        // ModifyUser takes several minutes to propagate to the cache nodes.
        timeout: Duration.minutes(12),
        memorySize: 256,
        vpc,
        vpcSubnets: rotationSubnets,
        securityGroups: [rotationSg],
        logGroup: fnLogs,
        // The user to rotate comes from each secret's user_arn.
        environment: {
          CACHE_HOST: this.cacheHost,
          CACHE_PORT: String(this.cachePort),
        },
        bundling: { minify: true, sourceMap: false, target: 'node24' },
      });
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['elasticache:DescribeUsers', 'elasticache:ModifyUser'],
          resources: cacheUserArns,
        }),
      );
      for (const secret of rotatedCacheSecrets) {
        secret.addRotationSchedule('Rotation', {
          rotationLambda: fn,
          automaticallyAfter: Duration.days(config.rotation.cacheDays),
          rotateImmediatelyOnUpdate: false,
        });
      }
    }

    // --- Application secrets ---

    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: `${sp}/jwt`,
      description: 'JWT and cookie signing key for the EVtivity API',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: secretRemoval,
    });
    this.settingsKeySecret = new secretsmanager.Secret(this, 'SettingsKeySecret', {
      secretName: `${sp}/settings-encryption-key`,
      description:
        'SETTINGS_ENCRYPTION_KEY: encrypts *Enc settings at rest. Losing it loses those settings.',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: secretRemoval,
    });
    this.initialAdminSecret = new secretsmanager.Secret(this, 'InitialAdminSecret', {
      secretName: `${sp}/initial-admin`,
      description: 'First dashboard login. The admin must change the password on first sign-in.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ email: config.initialAdmin.email }),
        generateStringKey: 'password',
        passwordLength: 24,
        excludeCharacters: PASSWORD_EXCLUDE,
      },
      removalPolicy: secretRemoval,
    });

    new CfnOutput(this, 'AuroraEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new CfnOutput(this, 'ValkeyEndpoint', { value: this.cacheHost });
    new CfnOutput(this, 'InitialAdminSecretName', { value: this.initialAdminSecret.secretName });
  }
}
