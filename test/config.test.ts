// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Invalid configs must fail to load instead of deploying something unintended.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import { loadConfig } from '../lib/config/load.js';

const BASE = load(readFileSync('config/dev.yaml', 'utf-8')) as Record<string, unknown>;

/** Writes dev.yaml plus the given dev.local.yaml into a temp dir and loads it. */
function loadWith(local: string, base: Record<string, unknown> = BASE): () => unknown {
  const dir = mkdtempSync(join(tmpdir(), 'evt-config-'));
  writeFileSync(join(dir, 'dev.yaml'), JSON.stringify(base));
  writeFileSync(join(dir, 'dev.local.yaml'), local);
  return () => loadConfig('dev', dir);
}

void describe('config validation', () => {
  void it('loads the committed dev config with an empty local file', () => {
    assert.doesNotThrow(loadWith(''));
    assert.doesNotThrow(loadWith('# nothing here\n'));
    assert.doesNotThrow(loadWith('# windows line endings\r\n# still nothing\r\n'));
    assert.doesNotThrow(loadWith('---\n'));
  });

  void it('rejects misspelled keys at any depth', () => {
    assert.throws(loadWith('waf:\n  enable: true\n'), /enable/);
    assert.throws(loadWith('aurora:\n  deletionProtecton: true\n'), /deletionProtecton/);
    assert.throws(loadWith('services:\n  api:\n    desiredcount: 3\n'), /desiredcount/);
  });

  void it('rejects the removed currency settings and unsupported company currencies', () => {
    assert.throws(loadWith('appSettings:\n  stripe.currency: EUR\n'), /one currency/);
    assert.throws(loadWith('appSettings:\n  pricing.currency: EUR\n'), /one currency/);
    assert.throws(loadWith('appSettings:\n  company.currency: JPY\n'), /unsupported currency/);
    assert.doesNotThrow(loadWith('appSettings:\n  company.currency: EUR\n'));
  });

  void it('rejects credentials in appSettings', () => {
    assert.throws(loadWith('appSettings:\n  smtp.passwordEnc: secret\n'), /dashboard/);
  });

  void it('rejects availability zones outside the region', () => {
    assert.throws(
      loadWith('vpc:\n  availabilityZones: [eu-west-1a, eu-west-1b]\n'),
      /not in region/,
    );
  });

  void it('rejects demo data in prod', () => {
    assert.throws(
      loadWith('seedDemo:\n  enabled: true\n', { ...BASE, env: 'prod' }),
      /demo data is not allowed in prod/,
    );
  });

  void it('rejects redeploys less often than credentials rotate', () => {
    assert.throws(
      loadWith('ecs:\n  redeployEveryDays: 30\nrotation:\n  databaseDays: 7\n'),
      /redeployEveryDays/,
    );
  });

  void it('rejects a desiredCount that autoscaling would ignore', () => {
    assert.throws(
      loadWith(
        'services:\n  api:\n    desiredCount: 3\n    autoscaling:\n      min: 1\n      max: 4\n',
      ),
      /autoscaling.min/,
    );
  });

  void it('rejects OCPP TLS without its secret', () => {
    assert.throws(loadWith('ocppTls:\n  enabled: true\n'), /secretName/);
  });
});
