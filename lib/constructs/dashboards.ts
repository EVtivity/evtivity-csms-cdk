// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Duration, aws_cloudwatch as cw, type aws_logs as logs } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { ServiceName } from '../catalog.js';
import type { Config } from '../config/index.js';
import type { AppService } from './app-service.js';
import { ALL_QUERY, ERROR_QUERY, orderedLogGroups } from './log-queries.js';
import type { EnvMetrics } from './metrics.js';

export interface DashboardsProps {
  config: Config;
  metrics: EnvMetrics;
  services: Partial<Record<ServiceName, AppService>>;
  /** Log groups by the service label the Grafana logs dashboard uses. */
  logGroups: Record<string, logs.ILogGroup>;
  /** Alarms to list on the alerts dashboard. */
  alarms: cw.IAlarm[];
  /** Grafana, for application and business metrics. */
  grafanaUrl?: string;
}

/**
 * CloudWatch dashboards built only from AWS data: system (load balancer,
 * services, Aurora, Valkey, NAT), logs (Logs Insights over every service),
 * and alerts (CloudWatch alarm status). Application and business metrics
 * stay in Grafana.
 */
export class Dashboards extends Construct {
  constructor(scope: Construct, id: string, props: DashboardsProps) {
    super(scope, id);
    const { config, metrics: m } = props;
    const prefix = m.prefix;
    const services = Object.entries(props.services) as [ServiceName, AppService][];
    const heading = (text: string): cw.IWidget =>
      new cw.TextWidget({ markdown: text, width: 24, height: 1 });
    const cache = (metricName: string, statistic?: string): cw.Metric[] =>
      m.cacheNodes.map((node) => m.cache(metricName, node, statistic));
    const fckNat = m.fckNat;

    // --- System ---

    const system = new cw.Dashboard(this, 'System', {
      dashboardName: `${prefix}-system`,
      defaultInterval: Duration.hours(3),
    });
    if (props.grafanaUrl != null) {
      system.addWidgets(
        heading(
          `Application and business metrics (sessions, stations, revenue, OCPP health) are in [Grafana](${props.grafanaUrl}).`,
        ),
      );
    }
    system.addWidgets(heading('## Load balancer'));
    system.addWidgets(
      new cw.GraphWidget({
        title: 'Requests per minute',
        width: 8,
        left: [m.alb('RequestCount', 'Sum', 'requests')],
      }),
      new cw.GraphWidget({
        title: 'Errors per minute',
        width: 8,
        left: [
          m.alb('HTTPCode_Target_4XX_Count', 'Sum', 'service 4xx'),
          m.alb('HTTPCode_Target_5XX_Count', 'Sum', 'service 5xx'),
          m.alb('HTTPCode_ELB_5XX_Count', 'Sum', 'load balancer 5xx'),
        ],
      }),
      new cw.GraphWidget({
        title: 'Response time (p50 / p95 / p99, seconds)',
        width: 8,
        left: [
          m.alb('TargetResponseTime', 'p50', 'p50'),
          m.alb('TargetResponseTime', 'p95', 'p95'),
          m.alb('TargetResponseTime', 'p99', 'p99'),
        ],
      }),
    );
    system.addWidgets(
      new cw.GraphWidget({
        title: 'Open connections (OCPP WebSockets included)',
        width: 12,
        left: [
          m.alb('ActiveConnectionCount', 'Sum', 'active'),
          m.alb('NewConnectionCount', 'Sum', 'new'),
        ],
      }),
      new cw.GraphWidget({
        title: 'Rejected connections and TLS errors',
        width: 12,
        left: [
          m.alb('RejectedConnectionCount', 'Sum', 'rejected'),
          m.alb('ClientTLSNegotiationErrorCount', 'Sum', 'client TLS errors'),
        ],
      }),
    );
    system.addWidgets(heading('## Services'));
    system.addWidgets(
      new cw.GraphWidget({
        title: 'CPU %',
        width: 8,
        left: services.map(([n, s]) => m.service('CPUUtilization', s, n)),
      }),
      new cw.GraphWidget({
        title: 'Memory %',
        width: 8,
        left: services.map(([n, s]) => m.service('MemoryUtilization', s, n)),
      }),
      new cw.GraphWidget({
        title: 'Running tasks',
        width: 8,
        left: services.map(([n, s]) =>
          m.service('RunningTaskCount', s, n, 'ECS/ContainerInsights'),
        ),
      }),
    );
    system.addWidgets(heading('## Aurora PostgreSQL'));
    system.addWidgets(
      new cw.GraphWidget({
        title: config.aurora.mode === 'serverless' ? 'Capacity (ACU) and utilization %' : 'CPU %',
        width: 8,
        left:
          config.aurora.mode === 'serverless'
            ? [m.rds('ServerlessDatabaseCapacity', 'Average', 'ACU')]
            : [m.rds('CPUUtilization', 'Average', 'CPU %')],
        ...(config.aurora.mode === 'serverless' && {
          right: [m.rds('ACUUtilization', 'Average', 'ACU utilization %')],
        }),
      }),
      new cw.GraphWidget({
        title: 'Connections',
        width: 8,
        left: [m.rds('DatabaseConnections', 'Maximum', 'connections')],
      }),
      new cw.GraphWidget({
        title: 'Latency (seconds)',
        width: 8,
        left: [m.rds('ReadLatency', 'Average', 'read'), m.rds('WriteLatency', 'Average', 'write')],
      }),
    );
    system.addWidgets(heading('## Valkey'));
    system.addWidgets(
      new cw.GraphWidget({ title: 'Engine CPU %', width: 8, left: cache('EngineCPUUtilization') }),
      new cw.GraphWidget({
        title: 'Memory %',
        width: 8,
        left: cache('DatabaseMemoryUsagePercentage'),
      }),
      new cw.GraphWidget({
        title: 'Connections',
        width: 8,
        left: cache('CurrConnections', 'Maximum'),
      }),
    );
    system.addWidgets(heading(fckNat ? '## NAT instance' : '## NAT gateways'));
    system.addWidgets(
      new cw.GraphWidget({
        title: 'Bytes out to the internet',
        width: 12,
        left: fckNat ? m.nat('NetworkOut', 'Sum') : m.nat('BytesOutToDestination', 'Sum'),
      }),
      new cw.GraphWidget({
        title: fckNat
          ? 'Status check failures and CPU %'
          : 'Port allocation errors and dropped packets',
        width: 12,
        left: fckNat ? m.nat('StatusCheckFailed', 'Maximum') : m.nat('ErrorPortAllocation', 'Sum'),
        right: fckNat ? m.nat('CPUUtilization', 'Average') : m.nat('PacketsDropCount', 'Sum'),
      }),
    );

    // --- Logs ---

    const logDashboard = new cw.Dashboard(this, 'Logs', {
      dashboardName: `${prefix}-logs`,
      defaultInterval: Duration.hours(1),
    });
    const groups = orderedLogGroups(props.logGroups);
    logDashboard.addWidgets(
      new cw.LogQueryWidget({
        title: 'Errors in every service',
        width: 24,
        height: 8,
        logGroupNames: groups.map(([, , g]) => g.logGroupName),
        queryString: ERROR_QUERY,
        view: cw.LogQueryVisualizationType.TABLE,
      }),
    );
    for (const [, title, group] of groups) {
      logDashboard.addWidgets(
        new cw.LogQueryWidget({
          title: `${title}: errors`,
          width: 12,
          height: 6,
          logGroupNames: [group.logGroupName],
          queryString: ERROR_QUERY,
          view: cw.LogQueryVisualizationType.TABLE,
        }),
        new cw.LogQueryWidget({
          title: `${title}: all logs`,
          width: 12,
          height: 6,
          logGroupNames: [group.logGroupName],
          queryString: ALL_QUERY,
          view: cw.LogQueryVisualizationType.TABLE,
        }),
      );
    }

    // --- Alerts ---

    const alerts = new cw.Dashboard(this, 'Alerts', {
      dashboardName: `${prefix}-alerts`,
      defaultInterval: Duration.hours(6),
    });
    if (props.alarms.length > 0) {
      alerts.addWidgets(
        new cw.AlarmStatusWidget({
          title: 'CloudWatch alarms',
          width: 24,
          height: Math.min(20, 2 + Math.ceil(props.alarms.length / 4)),
          alarms: props.alarms,
          sortBy: cw.AlarmStatusWidgetSortBy.STATE_UPDATED_TIMESTAMP,
        }),
      );
    } else {
      alerts.addWidgets(
        heading('CloudWatch alarms are off in this environment (`monitoring.alarms: false`).'),
      );
    }
    if (props.grafanaUrl != null) {
      alerts.addWidgets(
        heading(
          `Application alert rules (5xx rate, OCPP stations, sessions) run in [Grafana](${props.grafanaUrl}).`,
        ),
      );
    }
  }
}
