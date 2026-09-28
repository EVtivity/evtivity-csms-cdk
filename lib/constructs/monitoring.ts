// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  Duration,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  type aws_lambda as lambda,
  type aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SERVICE_CATALOG, type ServiceName } from '../catalog.js';
import type { Config } from '../config/index.js';
import type { AppService } from './app-service.js';
import type { EnvMetrics } from './metrics.js';

export interface MonitoringProps {
  config: Config;
  metrics: EnvMetrics;
  services: Partial<Record<ServiceName, AppService>>;
  /** Alarm notifications. Shared with Grafana alerting. */
  alertTopic: sns.ITopic;
  /** The CloudWatch-to-Loki forwarder, when observability is on. */
  lokiForwarder?: lambda.IFunction;
}

/** CloudWatch alarms for the environment. The dashboards live in Dashboards. */
export class Monitoring extends Construct {
  /** Every alarm created here, for the alerts dashboard. */
  readonly alarms: cw.Alarm[] = [];

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    const { config, metrics: m } = props;
    const entries = Object.entries(props.services) as [ServiceName, AppService][];
    const action = new cwActions.SnsAction(props.alertTopic);

    const alarm = (
      idSuffix: string,
      metric: cw.IMetric,
      threshold: number,
      description: string,
      periods = 5,
    ): void => {
      const a = new cw.Alarm(this, `Alarm-${idSuffix}`, {
        alarmName: `${m.prefix}-${idSuffix}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: periods,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(action);
      a.addOkAction(action);
      this.alarms.push(a);
    };

    alarm(
      'alb-target-5xx',
      m.alb('HTTPCode_Target_5XX_Count', 'Sum'),
      20,
      'Services returned 5xx responses',
    );
    alarm(
      'alb-elb-5xx',
      m.alb('HTTPCode_ELB_5XX_Count', 'Sum'),
      20,
      'ALB returned 5xx (no healthy targets?)',
    );
    for (const [name, svc] of entries) {
      alarm(`${name}-cpu`, m.service('CPUUtilization', svc), 85, `${name} CPU above 85%`, 10);
      alarm(
        `${name}-memory`,
        m.service('MemoryUtilization', svc),
        85,
        `${name} memory above 85%`,
        10,
      );
      if (svc.targetGroup != null) {
        alarm(
          `${name}-unhealthy`,
          svc.targetGroup.metrics.unhealthyHostCount({ period: m.period, statistic: 'Maximum' }),
          1,
          `${name} has unhealthy targets`,
        );
      }
      // Below the desired count for 10 minutes: tasks crash on start or cannot
      // be placed. Covers services with no load balancer health check.
      alarm(
        `${name}-tasks-missing`,
        new cw.MathExpression({
          expression: 'desired - running',
          usingMetrics: {
            desired: m.service('DesiredTaskCount', svc, undefined, 'ECS/ContainerInsights'),
            running: m.service('RunningTaskCount', svc, undefined, 'ECS/ContainerInsights'),
          },
          period: m.period,
          label: `${name} missing tasks`,
        }),
        1,
        `${name} is running fewer tasks than desired`,
        10,
      );
    }

    if (config.aurora.mode === 'serverless') {
      alarm('aurora-acu', m.rds('ACUUtilization'), 90, 'Aurora near its maximum capacity', 10);
    } else {
      alarm('aurora-cpu', m.rds('CPUUtilization'), 85, 'Aurora CPU above 85%', 10);
    }
    // Connections near what the services' pools can open means requests are
    // waiting for a connection.
    const poolConnections = entries
      .filter(([n]) => SERVICE_CATALOG[n].usesData)
      .reduce((sum, [n]) => {
        const sc = config.services[n];
        return sum + config.aurora.poolMax * (sc.autoscaling?.max ?? sc.desiredCount);
      }, 0);
    if (poolConnections > 0) {
      alarm(
        'aurora-connections',
        m.rds('DatabaseConnections', 'Maximum'),
        Math.ceil(poolConnections * 0.9),
        'Aurora connections near the services pool limit',
      );
    }
    if (config.aurora.readers > 0) {
      alarm(
        'aurora-replica-lag',
        m.replicaLag(),
        2000,
        'Aurora reader more than 2 seconds behind the writer',
      );
    }
    for (const node of m.cacheNodes) {
      const n = m.nodeLabel(node);
      // noeviction: writes fail once memory is full, so warn well before.
      alarm(
        `valkey-${n}-memory`,
        m.cache('DatabaseMemoryUsagePercentage', node),
        80,
        `Valkey node ${n} memory above 80%`,
      );
      alarm(
        `valkey-${n}-cpu`,
        m.cache('EngineCPUUtilization', node),
        80,
        `Valkey node ${n} engine CPU above 80%`,
        10,
      );
    }

    const natChecks = m.fckNat
      ? m.nat('StatusCheckFailed', 'Maximum')
      : m.nat('ErrorPortAllocation', 'Sum');
    natChecks.forEach((metric, i) => {
      alarm(
        m.fckNat ? `nat-${String(i + 1)}-status` : `nat-${String(i + 1)}-port-allocation`,
        metric,
        1,
        m.fckNat
          ? 'NAT instance failing status checks: private subnets may have no internet access'
          : 'NAT gateway ran out of source ports',
        m.fckNat ? 2 : 5,
      );
    });

    if (props.lokiForwarder != null) {
      alarm(
        'loki-forwarder',
        props.lokiForwarder.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        10,
        'Log batches failing to reach Loki: Grafana log panels have gaps',
        3,
      );
    }
  }
}
