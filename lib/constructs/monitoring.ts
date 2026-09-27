// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Duration,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  aws_elasticloadbalancingv2 as elbv2,
  aws_kms as kms,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { ServiceName } from '../catalog.js';
import type { Config } from '../config/index.js';
import { namePrefix } from '../util.js';
import type { AppService } from './app-service.js';

export interface MonitoringProps {
  config: Config;
  clusterName: string;
  alb: elbv2.IApplicationLoadBalancer;
  services: Partial<Record<ServiceName, AppService>>;
}

/** CloudWatch dashboard and alarms for the environment. */
export class Monitoring extends Construct {
  readonly topic?: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    const { config, clusterName, services } = props;
    const prefix = namePrefix(config);
    const albName = (props.alb as elbv2.ApplicationLoadBalancer).loadBalancerFullName;
    const period = Duration.minutes(1);
    const entries = Object.entries(services) as [ServiceName, AppService][];

    const ecsMetric = (metricName: string, svc: AppService, label: string): cw.Metric =>
      new cw.Metric({
        namespace: 'AWS/ECS',
        metricName,
        dimensionsMap: { ClusterName: clusterName, ServiceName: svc.service.serviceName },
        statistic: 'Average',
        period,
        label,
      });
    const rds = (metricName: string, statistic = 'Average'): cw.Metric =>
      new cw.Metric({
        namespace: 'AWS/RDS',
        metricName,
        dimensionsMap: { DBClusterIdentifier: prefix },
        statistic,
        period,
      });
    const cache = (metricName: string): cw.Metric =>
      new cw.Metric({
        namespace: 'AWS/ElastiCache',
        metricName,
        dimensionsMap: { CacheClusterId: `${prefix}-001` },
        statistic: 'Average',
        period,
      });
    const albMetric = (metricName: string, statistic: string): cw.Metric =>
      new cw.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName,
        dimensionsMap: { LoadBalancer: albName },
        statistic,
        period,
      });

    if (config.monitoring.dashboard) {
      const dashboard = new cw.Dashboard(this, 'Dashboard', {
        dashboardName: prefix,
        defaultInterval: Duration.hours(3),
      });
      dashboard.addWidgets(
        new cw.GraphWidget({
          title: 'Service CPU %',
          width: 12,
          left: entries.map(([n, s]) => ecsMetric('CPUUtilization', s, n)),
        }),
        new cw.GraphWidget({
          title: 'Service memory %',
          width: 12,
          left: entries.map(([n, s]) => ecsMetric('MemoryUtilization', s, n)),
        }),
      );
      dashboard.addWidgets(
        new cw.GraphWidget({
          title: 'ALB requests and 5xx',
          width: 12,
          left: [albMetric('RequestCount', 'Sum')],
          right: [
            albMetric('HTTPCode_ELB_5XX_Count', 'Sum'),
            albMetric('HTTPCode_Target_5XX_Count', 'Sum'),
          ],
        }),
        new cw.GraphWidget({
          title: 'ALB target response time p95',
          width: 12,
          left: [albMetric('TargetResponseTime', 'p95')],
        }),
      );
      dashboard.addWidgets(
        new cw.GraphWidget({
          title: 'Aurora capacity and connections',
          width: 12,
          left: [rds('ServerlessDatabaseCapacity'), rds('ACUUtilization')],
          right: [rds('DatabaseConnections', 'Sum')],
        }),
        new cw.GraphWidget({
          title: 'Valkey CPU and memory %',
          width: 12,
          left: [cache('EngineCPUUtilization'), cache('DatabaseMemoryUsagePercentage')],
          right: [cache('CurrConnections')],
        }),
      );
    }

    if (!config.monitoring.alarms) return;

    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: `${prefix}-alarms`,
      masterKey: kms.Alias.fromAliasName(this, 'SnsKey', 'alias/aws/sns'),
      enforceSSL: true,
    });
    if (config.monitoring.alarmEmail != null) {
      this.topic.addSubscription(new subs.EmailSubscription(config.monitoring.alarmEmail));
    }
    const action = new cwActions.SnsAction(this.topic);
    const alarm = (
      idSuffix: string,
      metric: cw.IMetric,
      threshold: number,
      description: string,
      periods = 5,
    ): void => {
      const a = new cw.Alarm(this, `Alarm-${idSuffix}`, {
        alarmName: `${prefix}-${idSuffix}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: periods,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(action);
      a.addOkAction(action);
    };

    alarm(
      'alb-target-5xx',
      albMetric('HTTPCode_Target_5XX_Count', 'Sum'),
      20,
      'Services returned 5xx responses',
    );
    alarm(
      'alb-elb-5xx',
      albMetric('HTTPCode_ELB_5XX_Count', 'Sum'),
      20,
      'ALB returned 5xx (no healthy targets?)',
    );
    for (const [name, svc] of entries) {
      alarm(`${name}-cpu`, ecsMetric('CPUUtilization', svc, name), 85, `${name} CPU above 85%`, 10);
      alarm(
        `${name}-memory`,
        ecsMetric('MemoryUtilization', svc, name),
        85,
        `${name} memory above 85%`,
        10,
      );
      if (svc.targetGroup != null) {
        alarm(
          `${name}-unhealthy`,
          svc.targetGroup.metrics.unhealthyHostCount({ period, statistic: 'Maximum' }),
          1,
          `${name} has unhealthy targets`,
          5,
        );
      }
    }
    if (config.aurora.mode === 'serverless') {
      alarm('aurora-acu', rds('ACUUtilization'), 90, 'Aurora near its maximum capacity', 10);
    } else {
      alarm('aurora-cpu', rds('CPUUtilization'), 85, 'Aurora CPU above 85%', 10);
    }
    // noeviction: writes fail once memory is full, so warn well before.
    alarm(
      'valkey-memory',
      cache('DatabaseMemoryUsagePercentage'),
      80,
      'Valkey memory above 80%',
      5,
    );
    alarm('valkey-cpu', cache('EngineCPUUtilization'), 80, 'Valkey engine CPU above 80%', 10);
  }
}
