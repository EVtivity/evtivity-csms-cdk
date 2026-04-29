// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { configSchema, type Config, type EnvName } from './schema.js';

const VALID_ENVS: EnvName[] = ['dev', 'qa', 'prod'];

export function isValidEnv(env: string): env is EnvName {
  return (VALID_ENVS as readonly string[]).includes(env);
}

export function loadConfig(env: EnvName, configDir = 'config'): Config {
  const path = resolve(process.cwd(), configDir, `${env}.yaml`);
  const raw = readFileSync(path, 'utf-8');
  const parsed = load(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path}: top-level YAML must be an object`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`${path}: invalid config\n${issues}`);
  }
  return result.data;
}
