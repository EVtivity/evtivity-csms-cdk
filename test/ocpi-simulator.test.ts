// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPI simulators call only their configured target, so both get the OCPI
// URL the CSMS advertises as OCPI_TARGET_URL.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/build-app.js';
import { loadConfig } from '../lib/config/load.js';
import { configSchema } from '../lib/config/schema.js';

const CDK_CONTEXT = (
  JSON.parse(readFileSync('cdk.json', 'utf8')) as { context: Record<string, unknown> }
).context;

type Env = Record<string, unknown>;

function containerEnvs(): Env[] {
  const config = structuredClone(loadConfig('dev', 'config', { includeLocal: false }));
  config.services.ocpiSim.enabled = true;
  config.services.ocpiCpoSim.enabled = true;
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  const stacks = buildApp(app, configSchema.parse(config), '2026-01-01');
  const envs: Env[] = [];
  for (const task of Object.values(
    Template.fromStack(stacks.app).findResources('AWS::ECS::TaskDefinition'),
  )) {
    const props = task['Properties'] as {
      ContainerDefinitions: { Environment?: { Name: string; Value: unknown }[] }[];
    };
    for (const container of props.ContainerDefinitions) {
      envs.push(Object.fromEntries((container.Environment ?? []).map((e) => [e.Name, e.Value])));
    }
  }
  return envs;
}

void describe('OCPI simulators', () => {
  void it('target the OCPI URL the CSMS advertises', () => {
    const envs = containerEnvs();
    const ocpiBaseUrl = envs.find((e) => e['OCPI_BASE_URL'] != null)?.['OCPI_BASE_URL'];
    assert.ok(typeof ocpiBaseUrl === 'string' && ocpiBaseUrl.startsWith('https://'));
    const sims = envs.filter((e) => e['OCPI_SIM_ROLE'] != null);
    assert.deepEqual(sims.map((e) => e['OCPI_SIM_ROLE']).sort(), ['cpo', 'emsp']);
    for (const sim of sims) assert.equal(sim['OCPI_TARGET_URL'], ocpiBaseUrl);
  });
});
