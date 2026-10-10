// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// AI assistant: settings validation (TC-AI-C-04), the upload quarantine
// lifecycle rule, and an ALB idle timeout that outlasts the SSE heartbeat.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { load } from 'js-yaml';
import { buildApp, type EvtivityStacks } from '../lib/build-app.js';
import { loadConfig } from '../lib/config/load.js';
import { configSchema, type Config, type EnvName } from '../lib/config/schema.js';
import { AI_UPLOAD_QUARANTINE_PREFIX } from '../lib/stacks/storage-stack.js';

const BASE = load(readFileSync('config/dev.yaml', 'utf-8')) as Record<string, unknown>;
const CDK_CONTEXT = (
  JSON.parse(readFileSync('cdk.json', 'utf8')) as { context: Record<string, unknown> }
).context;

/** Writes dev.yaml plus the given dev.local.yaml into a temp dir and loads it. */
function loadWith(local: string): () => unknown {
  const dir = mkdtempSync(join(tmpdir(), 'evt-ai-config-'));
  writeFileSync(join(dir, 'dev.yaml'), JSON.stringify(BASE));
  writeFileSync(join(dir, 'dev.local.yaml'), local);
  return () => loadConfig('dev', dir);
}

const setting = (key: string, value: string): (() => unknown) =>
  loadWith(`appSettings:\n  ${key}: ${value}\n`);

function build(env: EnvName, edit: (c: Config) => void = () => undefined): EvtivityStacks {
  const config = structuredClone(loadConfig(env, 'config', { includeLocal: false }));
  edit(config);
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  return buildApp(app, configSchema.parse(config), '2026-01-01');
}

void describe('AI assistant settings', () => {
  void it('rejects the removed sampling keys and names effort', () => {
    for (const surface of ['chatbotAi', 'supportAi']) {
      for (const key of ['temperature', 'topP', 'topK']) {
        assert.throws(setting(`${surface}.${key}`, '0.5'), new RegExp(`set ${surface}\\.effort`));
      }
    }
  });

  void it('rejects the removed per-surface API keys and names the per-provider key', () => {
    assert.throws(setting('chatbotAi.apiKey', 'abc'), /ai\.<provider>\.apiKeyEnc/);
    assert.throws(setting('supportAi.apiKey', 'abc'), /ai\.<provider>\.apiKeyEnc/);
    assert.throws(setting('ai.deepseek.apiKeyEnc', 'abc'), /entered in the dashboard/);
    assert.throws(setting('chatbotAi.apiKeyEnc', 'abc'), /entered in the dashboard/);
  });

  void it('validates effort and provider', () => {
    for (const surface of ['chatbotAi', 'supportAi']) {
      for (const effort of ['low', 'medium', 'high']) {
        assert.doesNotThrow(setting(`${surface}.effort`, effort));
      }
      assert.throws(setting(`${surface}.effort`, 'max'), /use low, medium, high/);
      for (const provider of ['anthropic', 'openai', 'gemini', 'deepseek', '""']) {
        assert.doesNotThrow(setting(`${surface}.provider`, provider));
      }
      assert.throws(setting(`${surface}.provider`, 'mistral'), /unsupported AI provider mistral/);
    }
  });

  void it('accepts only an empty or https base URL without credentials', () => {
    for (const provider of ['anthropic', 'openai', 'gemini', 'deepseek']) {
      const key = `ai.${provider}.baseUrl`;
      assert.doesNotThrow(setting(key, '""'));
      assert.doesNotThrow(setting(key, 'https://api.example.com/v1'));
      assert.throws(setting(key, 'http://api.example.com'), /https URL without credentials/);
      assert.throws(setting(key, 'https://user:pw@api.example.com'), /without credentials/);
      assert.throws(setting(key, 'https://api.example.com/v1?key=x'), /query, or fragment/);
      assert.throws(setting(key, 'https://api.example.com/v1#x'), /query, or fragment/);
      assert.throws(setting(key, 'not a url'), /https URL/);
      assert.throws(setting(key, '42'), /https URL/);
    }
  });

  void it('validates the limits as whole numbers in the API ranges', () => {
    const ranges: [string, number, number][] = [
      ['ai.rateLimit.userPerMinute', 1, 1000],
      ['ai.rateLimit.sitePerMinute', 1, 100_000],
      ['ai.budget.userDailyTokens', 0, 10_000_000_000],
      ['ai.maxToolCallsPerTurn', 1, 100],
      ['ai.conversationRetentionDays', 1, 3650],
      ['ai.attachments.maxBytes', 1, 33_554_432],
      ['ai.attachments.maxPerMessage', 1, 20],
    ];
    for (const [key, min, max] of ranges) {
      assert.doesNotThrow(setting(key, String(min)));
      assert.doesNotThrow(setting(key, String(max)));
      assert.throws(setting(key, String(min - 1)), /whole number/);
      assert.throws(setting(key, String(max + 1)), /whole number/);
      assert.throws(setting(key, '2.5'), /whole number/);
      assert.throws(setting(key, '"10"'), /whole number/);
    }
  });

  void it('validates the support tone', () => {
    for (const tone of ['professional', 'friendly', 'formal']) {
      assert.doesNotThrow(setting('supportAi.tone', tone));
    }
    assert.throws(setting('supportAi.tone', 'casual'), /use professional, friendly, formal/);
  });
});

void describe('AI upload quarantine', () => {
  void it('expires quarantined uploads and aborts their multipart uploads after one day', () => {
    for (const env of ['dev', 'prod'] as const) {
      const storage = Template.fromStack(build(env).storage);
      storage.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('-app-'),
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'expire-ai-upload-quarantine',
              Prefix: AI_UPLOAD_QUARANTINE_PREFIX,
              Status: 'Enabled',
              ExpirationInDays: 1,
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
              NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            }),
          ]),
        },
      });
    }
  });

  void it('lets the worker delete app bucket objects (ai-retention-prune)', () => {
    const app = Template.fromStack(build('dev').app);
    const policies = Object.entries(app.findResources('AWS::IAM::Policy')).filter(([id]) =>
      /^Svcworker.*TaskRole/.test(id),
    );
    assert.ok(policies.length > 0, 'no worker task role policy');
    const statements = policies.flatMap(
      ([, r]) =>
        (r as { Properties: { PolicyDocument: { Statement: { Action: unknown }[] } } }).Properties
          .PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s): unknown[] =>
      Array.isArray(s.Action) ? (s.Action as unknown[]) : [s.Action],
    );
    assert.ok(actions.includes('s3:DeleteObject'), JSON.stringify(actions));
    assert.ok(actions.includes('s3:ListBucket'), JSON.stringify(actions));
  });

  void it('allows presigned POST uploads from the browser', () => {
    const storage = Template.fromStack(build('dev').storage);
    storage.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('-app-'),
      CorsConfiguration: {
        CorsRules: [Match.objectLike({ AllowedMethods: Match.arrayWith(['POST']) })],
      },
    });
  });
});

void describe('ALB idle timeout', () => {
  void it('keeps the idle timeout at 60 seconds or more for SSE streams', () => {
    for (const env of ['dev', 'qa', 'prod'] as const) {
      const alb = Template.fromStack(build(env).alb).findResources(
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
      );
      const values = Object.values(alb).map((r) => {
        const attrs = (
          r as { Properties: { LoadBalancerAttributes: { Key: string; Value: string }[] } }
        ).Properties.LoadBalancerAttributes;
        return Number(attrs.find((a) => a.Key === 'idle_timeout.timeout_seconds')?.Value ?? 60);
      });
      assert.ok(values.length > 0, `${env}: no ALB`);
      for (const v of values) assert.ok(v >= 60, `${env}: idle timeout ${String(v)}`);
    }
  });

  void it('rejects a configured idle timeout under 60 seconds', () => {
    assert.throws(loadWith('alb:\n  idleTimeoutSeconds: 59\n'), /at least 60/);
    assert.doesNotThrow(loadWith('alb:\n  idleTimeoutSeconds: 60\n'));
  });
});
