#!/usr/bin/env node
// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildApp } from '../lib/build-app.js';
import { isValidEnv, loadConfig } from '../lib/config/index.js';
import { applyNagSuppressions } from '../lib/nag-suppressions.js';

const app = new App();

const envContext = (app.node.tryGetContext('env') as string | undefined) ?? process.env['CDK_ENV'];
if (envContext == null || !isValidEnv(envContext)) {
  throw new Error(
    `--context env=<env> required (one of: dev, qa, prod). Got: ${String(envContext)}`,
  );
}

// --context sizing=prod gives a lower environment the prod sizing and
// topology (lib/config/sizing.ts). It wins over the config files.
const sizingContext = app.node.tryGetContext('sizing') as string | undefined;
const config = loadConfig(envContext, 'config', {
  ...(sizingContext != null && { sizing: sizingContext }),
});

// UpdatedDate is the UTC day of the synth. Pass --context updatedDate=YYYY-MM-DD
// to reproduce an earlier synth exactly (for example when diffing).
const updatedDate =
  (app.node.tryGetContext('updatedDate') as string | undefined) ??
  new Date().toISOString().slice(0, 10);

buildApp(app, config, updatedDate);

// cdk-nag runs on every synth. Unacknowledged findings fail the synth.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
applyNagSuppressions(app, config);
