// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { load } from 'js-yaml';
import { buildApp } from '../lib/build-app.js';
import { loadConfig } from '../lib/config/load.js';
import * as scripts from '../lib/db-job-scripts.js';

const CDK_CONTEXT = (
  JSON.parse(readFileSync('cdk.json', 'utf8')) as { context: Record<string, unknown> }
).context;

/** The environment of the database job container, synthesized from dev.yaml plus `local`. */
function dbJobEnvironment(local: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'evt-dbjob-'));
  const base = load(readFileSync('config/dev.yaml', 'utf-8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'dev.yaml'), JSON.stringify(base));
  writeFileSync(join(dir, 'dev.local.yaml'), local);
  const config = loadConfig('dev', dir);
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  const stacks = buildApp(app, config, '2026-01-01');
  const tasks = Template.fromStack(stacks.app).findResources('AWS::ECS::TaskDefinition');
  for (const task of Object.values(tasks)) {
    const props = task['Properties'] as {
      ContainerDefinitions: { Environment?: { Name: string; Value: unknown }[] }[];
    };
    for (const container of props.ContainerDefinitions) {
      const env = Object.fromEntries((container.Environment ?? []).map((e) => [e.Name, e.Value]));
      if ('SETTINGS_JSON' in env) return env;
    }
  }
  throw new Error('no task definition carries SETTINGS_JSON');
}

/**
 * Resolves the CloudFormation value of SETTINGS_JSON. Cross-stack references
 * (the bucket name) become a placeholder string.
 */
function resolveText(value: unknown): string {
  if (typeof value === 'string') return value;
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (join == null) return 'token';
  return join[1].map((part) => resolveText(part)).join(join[0]);
}

/**
 * Runs SEED_SETTINGS_JS against a stub of postgres.js and returns the bound
 * parameters of each statement.
 */
function runSeedSettings(source: string, settingsJson: string): unknown[][] {
  const dir = mkdtempSync(join(tmpdir(), 'evt-seed-settings-'));
  const stub = join(dir, 'node_modules', 'postgres');
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, 'package.json'), '{"type":"module","main":"index.js"}');
  writeFileSync(
    join(stub, 'index.js'),
    "import { appendFileSync } from 'node:fs';\n" +
      'export default () => ({\n' +
      '  unsafe: async (query, params) => {\n' +
      "    appendFileSync(process.env.CALLS_FILE, JSON.stringify({ query, params }) + '\\n');\n" +
      '    return [];\n' +
      '  },\n' +
      '  end: async () => {},\n' +
      '});\n',
  );
  const script = join(dir, 'seed-settings.mjs');
  writeFileSync(script, source);
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(calls, '');
  execFileSync(process.execPath, [script], {
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: 'postgres://stub',
      SETTINGS_JSON: settingsJson,
      CALLS_FILE: calls,
    },
    stdio: 'pipe',
  });
  return readFileSync(calls, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const call = JSON.parse(line) as { query: string; params: unknown[] };
      assert.match(call.query, /\$2::text::jsonb/);
      return call.params;
    });
}

// postgres.js serializes a parameter it sees as jsonb with JSON.stringify. The
// scripts pass JSON text, so binding it straight to $n::jsonb stores every
// value as a string. Binding it as text and casting stores the real type.
void describe('database job scripts', () => {
  const sources = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

  void it('bind JSON text as text before casting to jsonb', () => {
    const withJsonb = sources.filter(([, source]) => source.includes('jsonb'));
    assert.ok(withJsonb.length > 0, 'some script writes jsonb');
    for (const [name, source] of withJsonb) {
      assert.doesNotMatch(source, /\$\d+::jsonb/, `${name} binds a parameter straight to jsonb`);
    }
  });

  // The API's getMobileAppConfig() reads a jsonb array of strings and treats
  // anything else as no app. The value bound as text is what `::jsonb` stores.
  void it('stores the mobile app lists from appSettings as JSON arrays', () => {
    const env = dbJobEnvironment(
      'appSettings:\n  mobile.app.urlSchemes: [evtivity, acme]\n' +
        '  mobile.app.androidPackageNames: [com.evtivity.driver]\n' +
        '  company.currency: EUR\n',
    );
    assert.equal(typeof env['SEED_SETTINGS_JS'], 'string');
    const params = runSeedSettings(
      env['SEED_SETTINGS_JS'] as string,
      resolveText(env['SETTINGS_JSON']),
    );
    const stored = Object.fromEntries(
      params.map(([key, json]) => [key as string, JSON.parse(json as string) as unknown]),
    );
    assert.deepEqual(stored['mobile.app.urlSchemes'], ['evtivity', 'acme']);
    assert.deepEqual(stored['mobile.app.androidPackageNames'], ['com.evtivity.driver']);
    assert.equal(stored['company.currency'], 'EUR');
  });

  // The CSMS seed only adds missing settings (it never overwrites), so the
  // demo job keeps no settings save/restore around it. The configured
  // settings are applied again after the seed.
  void it('runs the demo seed without a settings snapshot, then the configured settings', () => {
    const steps = scripts.SEED_DEMO_SH.split('\n');
    const seed = steps.indexOf('SEED_DEMO=true npm run seed');
    const settings = steps.findIndex((step) => step.includes('$SEED_SETTINGS_JS'));
    assert.ok(seed >= 0, 'demo job runs the seed');
    assert.ok(settings > seed, 'configured settings are applied after the seed');
    assert.doesNotMatch(scripts.SEED_DEMO_SH, /SNAPSHOT/);
    assert.equal('SETTINGS_SNAPSHOT_JS' in scripts, false);
  });
});
