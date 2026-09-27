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
import type { Config } from '../config/index.js';
import { BOOTSTRAP_JS, DB_JOB_SH, SEED_SETTINGS_JS } from '../db-job-scripts.js';
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
  settings: Record<string, string | number | boolean>;
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

  constructor(scope: Construct, id: string, props: DbJobProps) {
    super(scope, id);
    const { config } = props;
    tagService(this, 'db-job');

    const logGroup = (this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/evtivity/${config.env}/db-job`,
      retention: config.logs.retentionDays,
      removalPolicy: removalPolicyOf(config.logs.removal),
    }));

    const taskDef = new ecs.FargateTaskDefinition(this, 'Task', {
      family: `evtivity-${config.env}-db-job`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDef.addVolume({ name: 'tmp' });

    const settingsJson = JSON.stringify(props.settings);
    const container = taskDef.addContainer('app', {
      image: props.image,
      user: '1000',
      readonlyRootFilesystem: true,
      command: ['sh', '-c', DB_JOB_SH],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'db-job', logGroup }),
      environment: {
        NODE_ENV: 'production',
        HOME: '/tmp',
        npm_config_cache: '/tmp/.npm',
        npm_config_update_notifier: 'false',
        DB_HOST: props.dbHost,
        DB_PORT: props.dbPort,
        DB_NAME: props.dbName,
        DB_SSLMODE: 'require',
        BOOTSTRAP_JS,
        SEED_SETTINGS_JS,
        SETTINGS_JSON: settingsJson,
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(props.masterSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.masterSecret, 'password'),
        APP_DB_USER: ecs.Secret.fromSecretsManager(props.appDbSecret, 'username'),
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, 'password'),
        SETTINGS_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.settingsKeySecret),
        INITIAL_ADMIN_EMAIL: ecs.Secret.fromSecretsManager(props.initialAdminSecret, 'email'),
        INITIAL_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(props.initialAdminSecret, 'password'),
      },
    });
    container.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });

    const fnProps: Omit<lambdaNodejs.NodejsFunctionProps, 'handler'> = {
      entry: join(import.meta.dirname, '../../lambda/run-task.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(1),
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

    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [taskDef.taskDefinitionArn],
        conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
      }),
    );
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [taskDef.taskRole.roleArn, taskDef.obtainExecutionRole().roleArn],
      }),
    );
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTasks'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ecs',
            resource: 'task',
            resourceName: `${namePrefix(config)}/*`,
          }),
        ],
      }),
    );

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

    this.resource = new CustomResource(this, 'Run', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::EvtivityDbJob',
      properties: {
        ClusterArn: props.cluster.clusterArn,
        // A new revision (image tag, env, settings, secrets) triggers a new run.
        TaskDefinitionArn: taskDef.taskDefinitionArn,
        Subnets: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
          .subnetIds,
        SecurityGroups: [props.securityGroup.securityGroupId],
        ContainerName: 'app',
        LogGroupName: logGroup.logGroupName,
      },
    });
    // Keep the task definition revision alive until the job has run.
    this.resource.node.addDependency(taskDef);
  }
}
