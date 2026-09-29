// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Logs Insights queries shared by the CloudWatch logs dashboard and the
// Grafana logs dashboard, so both show the same errors.

/** Errors, fatals, and panics, without OCPP `faultCode` fields that are not errors. */
export const ERROR_QUERY =
  'fields @timestamp, @logStream, @message\n' +
  '| filter @message like /(?i)(error|fatal|panic)/ and @message not like /faultCode/\n' +
  '| sort @timestamp desc\n' +
  '| limit 100';

export const ALL_QUERY = 'fields @timestamp, @message\n| sort @timestamp desc\n| limit 100';

/** Display names for the log groups' labels, in the order the Helm chart shows them. */
const DISPLAY: [string, string][] = [
  ['api', 'API'],
  ['ocpp', 'OCPP'],
  ['worker', 'Worker'],
  ['simulator', 'Simulator'],
  ['postgres', 'PostgreSQL'],
  ['redis', 'Valkey'],
  ['csms', 'CSMS (nginx)'],
  ['portal', 'Portal (nginx)'],
  ['ocpi', 'OCPI'],
  ['migrate', 'Database job'],
];

/** Log group labels in display order, with their titles. Unknown labels go last. */
export function orderedLogGroups<T>(groups: Record<string, T>): [string, string, T][] {
  const known = DISPLAY.filter(([label]) => label in groups).map(
    ([label, title]) => [label, title, groups[label] as T] as [string, string, T],
  );
  const rest = Object.keys(groups)
    .filter((label) => !DISPLAY.some(([l]) => l === label))
    .sort()
    .map((label) => [label, label, groups[label] as T] as [string, string, T]);
  return [...known, ...rest];
}

/**
 * The Grafana logs dashboard for AWS. Same UID, title, and layout as the Helm
 * chart's Loki dashboard, with CloudWatch Logs Insights queries instead of
 * LogQL. `groups` maps each label to its log group name.
 */
export function grafanaLogsDashboard(groups: Record<string, string>): object {
  const datasource = { type: 'cloudwatch', uid: 'cloudwatch' };
  const panelOptions = {
    showTime: true,
    sortOrder: 'Descending',
    enableLogDetails: true,
    wrapLogMessage: true,
    prettifyLogMessage: false,
    dedupStrategy: 'none',
  };
  let id = 0;
  const logsPanel = (
    title: string,
    names: string[],
    query: string,
    gridPos: { h: number; w: number; x: number; y: number },
  ): object => ({
    id: ++id,
    type: 'logs',
    title,
    datasource,
    gridPos,
    options: panelOptions,
    targets: [
      {
        refId: 'A',
        datasource,
        queryMode: 'Logs',
        region: 'default',
        logGroupNames: names,
        expression: query,
      },
    ],
  });

  const ordered = orderedLogGroups(groups);
  const panels: object[] = [
    {
      id: ++id,
      type: 'row',
      title: 'Errors (All Services)',
      collapsed: false,
      gridPos: { h: 1, w: 24, x: 0, y: 0 },
      panels: [],
    },
    logsPanel(
      'All Errors',
      ordered.map(([, , name]) => name),
      ERROR_QUERY,
      { h: 10, w: 24, x: 0, y: 1 },
    ),
  ];
  ordered.forEach(([, title, name], i) => {
    const y = 11 + i;
    panels.push({
      id: ++id,
      type: 'row',
      title,
      collapsed: true,
      gridPos: { h: 1, w: 24, x: 0, y },
      panels: [
        logsPanel(`${title}: errors`, [name], ERROR_QUERY, { h: 10, w: 12, x: 0, y: y + 1 }),
        logsPanel(`${title}: all logs`, [name], ALL_QUERY, { h: 10, w: 12, x: 12, y: y + 1 }),
      ],
    });
  });

  return {
    uid: 'logs',
    title: 'Logs',
    tags: ['logs', 'cloudwatch'],
    editable: false,
    refresh: '30s',
    time: { from: 'now-1h', to: 'now' },
    schemaVersion: 39,
    panels,
  };
}
