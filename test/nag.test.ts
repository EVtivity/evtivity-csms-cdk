// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Runs cdk-nag the same way `cdk synth` does, so an unacknowledged finding
// fails `npm test` and not only the CI synth.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildApp } from '../lib/build-app.js';
import { loadConfig } from '../lib/config/load.js';
import { applyNagSuppressions } from '../lib/nag-suppressions.js';

const CDK_CONTEXT = (
  JSON.parse(readFileSync('cdk.json', 'utf-8')) as { context: Record<string, unknown> }
).context;

void describe('cdk-nag', () => {
  for (const env of ['dev', 'qa', 'prod'] as const) {
    void it(`${env}: no unacknowledged AwsSolutions findings`, () => {
      const config = loadConfig(env, 'config', { includeLocal: false });
      const outdir = mkdtempSync(join(tmpdir(), 'evt-nag-'));
      const app = new App({
        outdir,
        context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] },
      });
      buildApp(app, config, '2026-01-01');
      Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
      applyNagSuppressions(app, config);
      try {
        assert.doesNotThrow(() => app.synth());
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });
  }
});
