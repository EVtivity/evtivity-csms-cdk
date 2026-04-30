// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { configSchema, type Config, type EnvName } from './schema.js';

const VALID_ENVS: EnvName[] = ['dev', 'qa', 'prod'];

export function isValidEnv(env: string): env is EnvName {
  return (VALID_ENVS as readonly string[]).includes(env);
}

function readYaml(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  const parsed = load(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path}: top-level YAML must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deep-merge override onto base. Plain objects merge recursively; arrays and
// primitives in `override` replace the corresponding base value entirely.
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(env: EnvName, configDir = 'config'): Config {
  const basePath = resolve(process.cwd(), configDir, `${env}.yaml`);
  const localPath = resolve(process.cwd(), configDir, `${env}.local.yaml`);

  let merged = readYaml(basePath);
  const sources = [basePath];
  if (existsSync(localPath)) {
    merged = deepMerge(merged, readYaml(localPath));
    sources.push(localPath);
  }

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config (sources: ${sources.join(', ')}):\n${issues}`);
  }
  return result.data;
}
