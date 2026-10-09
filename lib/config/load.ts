// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { configSchema, type Config, type EnvName } from './schema.js';
import { isSizingPreset, sizingOf, type SizingPreset } from './sizing.js';

const VALID_ENVS: EnvName[] = ['dev', 'qa', 'prod'];

export function isValidEnv(env: string): env is EnvName {
  return (VALID_ENVS as readonly string[]).includes(env);
}

function readYaml(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  // An empty or fully commented file overrides nothing. js-yaml throws on a
  // document with no content, and returns null for a bare `---`.
  if (raw.split(/\r?\n/).every((line) => /^\s*(#.*|---)?\s*$/.test(line))) return {};
  const parsed = load(raw);
  if (parsed == null) return {};
  if (typeof parsed !== 'object') {
    throw new Error(`${path}: top-level YAML must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deep-merge override onto base. Plain objects merge recursively; arrays and
// primitives in `override` replace the corresponding base value entirely. An
// undefined value in `override` removes the key (YAML never produces one; the
// sizing preset uses it for values prod leaves unset).
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const removed = new Set(
    Object.entries(override)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k),
  );
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(base).filter(([k]) => !removed.has(k)),
  );
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface LoadConfigOptions {
  /** Read config/<env>.local.yaml. Default true. */
  includeLocal?: boolean;
  /** Sizing preset from the command line (`--context sizing=prod`). Wins over the files. */
  sizing?: string;
}

export function loadConfig(
  env: EnvName,
  configDir = 'config',
  options: LoadConfigOptions = {},
): Config {
  const basePath = resolve(process.cwd(), configDir, `${env}.yaml`);
  const localPath = resolve(process.cwd(), configDir, `${env}.local.yaml`);

  const base = readYaml(basePath);
  const sources = [basePath];
  let local: Record<string, unknown> = {};
  if ((options.includeLocal ?? true) && existsSync(localPath)) {
    local = readYaml(localPath);
    sources.push(localPath);
  }

  // Order: <env>.yaml, then the sizing preset, then <env>.local.yaml, so an
  // explicit local value still wins over the preset.
  let merged = base;
  const sizing = options.sizing ?? local['sizing'] ?? base['sizing'];
  if (sizing != null) {
    if (typeof sizing !== 'string' || !isSizingPreset(sizing)) {
      throw new Error(`Invalid sizing preset ${JSON.stringify(sizing)}: use prod`);
    }
    if (env !== 'prod') {
      merged = deepMerge(merged, presetValues(sizing, configDir));
      sources.push(`sizing preset ${sizing}`);
    }
  }
  merged = deepMerge(merged, local);
  if (sizing != null) merged = { ...merged, sizing };

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config (sources: ${sources.join(', ')}):\n${issues}`);
  }
  return result.data;
}

/** Sizing and topology of the preset's environment, from its committed file only. */
function presetValues(preset: SizingPreset, configDir: string): Record<string, unknown> {
  return sizingOf(loadConfig(preset, configDir, { includeLocal: false }));
}
