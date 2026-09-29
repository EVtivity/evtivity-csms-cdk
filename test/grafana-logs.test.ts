// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Grafana logs dashboard the CDK generates for CloudWatch Logs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { grafanaLogsDashboard } from '../lib/constructs/log-queries.js';

interface Target {
  datasource: { type: string; uid: string };
  queryMode: string;
  logGroupNames: string[];
  expression: string;
}
interface Panel {
  type: string;
  title: string;
  targets?: Target[];
  panels?: Panel[];
}

const groups = {
  api: '/evtivity/dev/api',
  ocpp: '/evtivity/dev/ocpp',
  simulator: '/evtivity/dev/css',
  postgres: '/aws/rds/cluster/evtivity-dev/postgresql',
  'ocpi-simulator': '/evtivity/dev/ocpiSim',
};
const dashboard = grafanaLogsDashboard(groups) as { uid: string; panels: Panel[] };
const logPanels = dashboard.panels
  .flatMap((p) => [p, ...(p.panels ?? [])])
  .filter((p) => p.type === 'logs');

void describe('Grafana logs dashboard', () => {
  void it('keeps the Helm dashboard UID so links keep working', () => {
    assert.equal(dashboard.uid, 'logs');
  });

  void it('queries CloudWatch Logs Insights, never Loki', () => {
    assert.ok(logPanels.length > 0);
    for (const p of logPanels) {
      for (const t of p.targets ?? []) {
        assert.deepEqual(t.datasource, { type: 'cloudwatch', uid: 'cloudwatch' }, p.title);
        assert.equal(t.queryMode, 'Logs', p.title);
        assert.match(t.expression, /^fields @timestamp/, p.title);
      }
    }
    assert.doesNotMatch(JSON.stringify(dashboard), /loki/i);
  });

  void it('covers every log group: all errors, then errors and logs per service', () => {
    const [allErrors] = logPanels;
    assert.deepEqual(
      new Set(allErrors?.targets?.[0]?.logGroupNames),
      new Set(Object.values(groups)),
    );
    for (const name of Object.values(groups)) {
      const own = logPanels.filter((p) => p.targets?.[0]?.logGroupNames.join() === name);
      assert.equal(own.length, 2, `${name} has an errors panel and an all-logs panel`);
    }
  });

  void it('orders known services like the Helm chart and puts unknown ones last', () => {
    const rows = dashboard.panels.filter((p) => p.type === 'row').map((p) => p.title);
    assert.deepEqual(rows, [
      'Errors (All Services)',
      'API',
      'OCPP',
      'Simulator',
      'PostgreSQL',
      'ocpi-simulator',
    ]);
  });
});
