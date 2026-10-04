// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Per-service Valkey users. config/redis-acl-rules.conf is a verbatim copy of
// evtivity-csms-private docker/redis/acl-rules.conf (synced by that repo's
// internal-scripts/sync-redis-acl.sh): one "user <name> <rules>" line per
// service, Redis ACL syntax without "on" or passwords. ElastiCache sets
// passwords through the API, so the access string is "on <rules>".

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_CATALOG, SERVICE_NAMES } from './catalog.js';
import type { Config } from './config/index.js';

export const CACHE_USERS = ['api', 'ocpp', 'ocpi', 'worker', 'css'] as const;
export type CacheUserName = (typeof CACHE_USERS)[number];

export const REDIS_ACL_RULES_FILE = join(import.meta.dirname, '../config/redis-acl-rules.conf');

/** Parses the rules file into the ElastiCache access string of each user. */
export function parseRedisAclRules(text: string): Record<CacheUserName, string> {
  const rules = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [keyword, name, ...parts] = line.split(/\s+/);
    if (keyword !== 'user' || name == null || parts.length === 0) {
      throw new Error(`redis-acl-rules.conf: unexpected line "${line}"`);
    }
    for (const part of parts) {
      // Passwords, on/off and reset rules are managed by ElastiCache, never by the file.
      if (/^(on|off|nopass|reset.*|[<>#!].*)$/.test(part)) {
        throw new Error(`redis-acl-rules.conf: rule "${part}" of user ${name} is not allowed`);
      }
    }
    if (rules.has(name)) throw new Error(`redis-acl-rules.conf: user ${name} is defined twice`);
    rules.set(name, `on ${parts.join(' ')}`);
  }
  const names = [...rules.keys()].sort();
  const expected = [...CACHE_USERS].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `redis-acl-rules.conf: expected users ${expected.join(', ')}, found ${names.join(', ')}`,
    );
  }
  return Object.fromEntries(rules) as Record<CacheUserName, string>;
}

export function loadRedisAclRules(file = REDIS_ACL_RULES_FILE): Record<CacheUserName, string> {
  return parseRedisAclRules(readFileSync(file, 'utf8'));
}

/** Cache users needed by the enabled services, in a stable order. */
export function enabledCacheUsers(config: Config): CacheUserName[] {
  const users = new Set<CacheUserName>();
  for (const name of SERVICE_NAMES) {
    const user = SERVICE_CATALOG[name].cacheUser;
    if (user != null && config.services[name].enabled) users.add(user);
  }
  return CACHE_USERS.filter((u) => users.has(u));
}
