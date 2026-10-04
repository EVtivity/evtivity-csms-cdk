// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { join } from 'node:path';
import {
  CustomResource,
  Stack,
  Duration,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_stepfunctions as sfn,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { AppSettingValue, Config } from '../config/index.js';
import {
  BOOTSTRAP_JS,
  DB_JOB_SH,
  SEED_DEMO_POST_JS,
  SEED_DEMO_SH,
  SEED_SETTINGS_JS,
  SETTINGS_SNAPSHOT_JS,
  SIMULATOR_TARGETS_JS,
} from '../db-job-scripts.js';
import { tagService } from '../tagging.js';
import { namePrefix, removalPolicyOf } from '../util.js';

export interface DbJobProps {
  config: Config;
  cluster: ecs.ICluster;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  image: ecs.ContainerImage;
  dbHost: string;
  dbPort: string;
  dbName: string;
  masterSecret: secretsmanager.ISecret;
  appDbSecret: secretsmanager.ISecret;
  settingsKeySecret: secretsmanager.ISecret;
  initialAdminSecret: secretsmanager.ISecret;
  settings: Record<string, AppSettingValue>;
  /** Internal OCPP URLs that simulator stations connect to. */
  simulator: { ocppUrl: string; ocppTlsUrl: string };
  /** Present when seedDemo.enabled. */
  demo?: { tlsEnabled: boolean };
}

/**
 * Runs migrations, role bootstrap, the initial admin seed, and the settings
 * upsert as one Fargate task during every deployment that changes the task
 * definition or the settings. Services depend on this construct, so they
 * only start or update after the job exits 0.
 */
export class DbJob extends Construct {
  readonly resource: CustomResource;
  readonly logGroup: logs.LogGroup;
  /** The one-time demo seed, when enabled. Runs after `resource`. */
  readonly demoResource?: CustomResource;

  constructor(scope: Construct, id: string, props: DbJobProps) {
    super(scope, id);
    const { config } = props;
    tagService(this, 'db-job');

    const logGroup = (this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/evtivity/${config.env}/db-job`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    }));

    const fnProps: Omit<lambdaNodejs.NodejsFunctionProps, 'handler'> = {
      entry: join(import.meta.dirname, '../../lambda/run-task.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // RunTask retries wait up to 35 seconds for Fargate capacity.
      timeout: Duration.minutes(2),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, target: 'node24' },
    };
    const onEvent = new lambdaNodejs.NodejsFunction(this, 'OnEvent', {
      ...fnProps,
      handler: 'onEvent',
    });
    const isComplete = new lambdaNodejs.NodejsFunction(this, 'IsComplete', {
      ...fnProps,
      handler: 'isComplete',
    });
    const clusterTasks = Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'task',
      resourceName: `${namePrefix(config)}/*`,
    });
    // Finds and stops a run left over from a deployment that timed out.
    // ListTasks takes no task resource, so it is scoped by cluster.
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:ListTasks'],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
      }),
    );
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ecs:StopTask'], resources: [clusterTasks] }),
    );
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ecs:DescribeTasks'], resources: [clusterTasks] }),
    );

    // Both jobs run the migrate image as the node user with a read-only root
    // and a /tmp scratch volume, connecting as the database owner.
    const settingsJson = JSON.stringify(props.settings);
    const jobTask = (
      id: string,
      o: {
        family: string;
        cpu: number;
        memoryLimitMiB: number;
        command: string;
        streamPrefix: string;
        environment: Record<string, string>;
        secrets: Record<string, ecs.Secret>;
        /** `revision` allows only this revision, `family` any revision of it. */
        runs: 'revision' | 'family';
      },
    ): ecs.FargateTaskDefinition => {
      const task = new ecs.FargateTaskDefinition(this, id, {
        family: o.family,
        cpu: o.cpu,
        memoryLimitMiB: o.memoryLimitMiB,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      task.addVolume({ name: 'tmp' });
      task
        .addContainer('app', {
          image: props.image,
          user: '1000',
          readonlyRootFilesystem: true,
          command: ['sh', '-c', o.command],
          logging: ecs.LogDrivers.awsLogs({ streamPrefix: o.streamPrefix, logGroup }),
          environment: {
            NODE_ENV: 'production',
            HOME: '/tmp',
            npm_config_cache: '/tmp/.npm',
            npm_config_update_notifier: 'false',
            DB_HOST: props.dbHost,
            DB_PORT: props.dbPort,
            DB_NAME: props.dbName,
            DB_SSLMODE: 'require',
            SEED_SETTINGS_JS,
            SETTINGS_JSON: settingsJson,
            ...o.environment,
          },
          secrets: {
            DB_USER: ecs.Secret.fromSecretsManager(props.masterSecret, 'username'),
            DB_PASSWORD: ecs.Secret.fromSecretsManager(props.masterSecret, 'password'),
            INITIAL_ADMIN_EMAIL: ecs.Secret.fromSecretsManager(props.initialAdminSecret, 'email'),
            INITIAL_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(
              props.initialAdminSecret,
              'password',
            ),
            ...o.secrets,
          },
        })
        .addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });
      onEvent.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecs:RunTask'],
          resources: [
            o.runs === 'revision'
              ? task.taskDefinitionArn
              : Stack.of(this).formatArn({
                  service: 'ecs',
                  resource: 'task-definition',
                  resourceName: `${o.family}:*`,
                }),
          ],
          conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
        }),
      );
      onEvent.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [task.taskRole.roleArn, task.obtainExecutionRole().roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      );
      return task;
    };

    const dbFamily = `evtivity-${config.env}-db-job`;
    const taskDef = jobTask('Task', {
      family: dbFamily,
      cpu: 512,
      memoryLimitMiB: 1024,
      command: DB_JOB_SH,
      streamPrefix: 'db-job',
      environment: {
        BOOTSTRAP_JS,
        SIMULATOR_TARGETS_JS,
        SIM_OCPP_URL: props.simulator.ocppUrl,
        SIM_OCPP_TLS_URL: props.simulator.ocppTlsUrl,
      },
      secrets: {
        APP_DB_USER: ecs.Secret.fromSecretsManager(props.appDbSecret, 'username'),
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, 'password'),
      },
      runs: 'revision',
    });

    // One-time demo seed. The custom resource references the task family,
    // not a revision, so image or setting changes do not rerun it. Only a
    // new seedDemo.revision does. RunTask on a family uses its latest revision.
    let demoTask: ecs.FargateTaskDefinition | undefined;
    if (props.demo != null) {
      const demoPassword = new secretsmanager.Secret(this, 'DemoPassword', {
        secretName: `evtivity/${config.env}/demo-password`,
        description:
          'Password of the demo operators and driver. Operators change it at first sign-in.',
        generateSecretString: { passwordLength: 20, excludePunctuation: true },
        removalPolicy: removalPolicyOf(config.secrets.removal),
      });
      demoTask = jobTask('DemoTask', {
        family: `evtivity-${config.env}-seed-demo`,
        cpu: 1024,
        memoryLimitMiB: 2048,
        command: SEED_DEMO_SH,
        streamPrefix: 'seed-demo',
        environment: {
          SEED_CSS_TARGET_URL: props.simulator.ocppUrl,
          SEED_CSS_TLS_TARGET_URL: props.simulator.ocppTlsUrl,
          SETTINGS_SNAPSHOT_JS,
          SETTINGS_SNAPSHOT: '/tmp/settings-snapshot.json',
          DEMO_TLS_ENABLED: String(props.demo.tlsEnabled),
          DEMO_STATION_LIMIT: String(config.seedDemo.stationLimit),
          SEED_DEMO_POST_JS,
        },
        secrets: {
          // The seed encrypts its default credential settings.
          SETTINGS_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.settingsKeySecret),
          DEMO_PASSWORD: ecs.Secret.fromSecretsManager(demoPassword),
        },
        runs: 'family',
      });
    }
    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: Duration.seconds(15),
      totalTimeout: Duration.minutes(30),
      logGroup: new logs.LogGroup(this, 'ProviderLogs', {
        retention: config.logs.retentionDays,
        removalPolicy: removalPolicyOf(config.logs.removal),
      }),
      disableWaiterStateMachineLogging: false,
      waiterStateMachineLogOptions: {
        destination: new logs.LogGroup(this, 'WaiterLogs', {
          retention: config.logs.retentionDays,
          removalPolicy: removalPolicyOf(config.logs.removal),
        }),
        level: sfn.LogLevel.ALL,
        includeExecutionData: false,
      },
    });

    const subnets = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;
    this.resource = new CustomResource(this, 'Run', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::EvtivityDbJob',
      properties: {
        ClusterArn: props.cluster.clusterArn,
        // A new revision (image tag, env, settings, secrets) triggers a new run.
        TaskDefinitionArn: taskDef.taskDefinitionArn,
        Subnets: subnets,
        SecurityGroups: [props.securityGroup.securityGroupId],
        ContainerName: 'app',
        LogGroupName: logGroup.logGroupName,
        Family: dbFamily,
      },
    });

    if (demoTask != null) {
      this.demoResource = new CustomResource(this, 'Demo', {
        serviceToken: provider.serviceToken,
        resourceType: 'Custom::EvtivitySeedDemo',
        properties: {
          ClusterArn: props.cluster.clusterArn,
          TaskDefinitionArn: demoTask.family,
          Revision: String(config.seedDemo.revision),
          Subnets: subnets,
          SecurityGroups: [props.securityGroup.securityGroupId],
          ContainerName: 'app',
          LogGroupName: logGroup.logGroupName,
          JobName: 'seed-demo',
          Family: demoTask.family,
        },
      });
      // Demo data needs the migrated schema, and the settings it rewrites
      // must be the ones this deploy wrote.
      this.demoResource.node.addDependency(this.resource, demoTask);
    }
  }
}
