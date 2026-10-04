// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The per-service Valkey users come from config/redis-acl-rules.conf. A bad
// line must fail the synth instead of creating a user with the wrong rights.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { userIdOf } from '../lambda/valkey-rotation.js';
import { loadConfig } from '../lib/config/load.js';
import {
  CACHE_USERS,
  enabledCacheUsers,
  loadRedisAclRules,
  parseRedisAclRules,
} from '../lib/redis-acl.js';

const VALID = CACHE_USERS.map((u) => `user ${u} &${u}_channel +@all -@dangerous +info`).join('\n');

void describe('redis ACL rules', () => {
  void it('loads the committed rules file into one access string per service', () => {
    const rules = loadRedisAclRules();
    assert.deepEqual(Object.keys(rules).sort(), [...CACHE_USERS].sort());
    for (const user of CACHE_USERS) {
      assert.match(rules[user], /^on /);
      assert.match(rules[user], / -@dangerous \+info$/);
    }
    assert.match(rules.worker, / ~bull:\* /);
    assert.match(rules.ocpp, / ~ocpp:conn:\* /);
    assert.doesNotMatch(rules.css, /~|ocpp_commands/);
  });

  void it('skips comments and blank lines', () => {
    const rules = parseRedisAclRules(`# header\n\n${VALID}\n`);
    assert.equal(rules.api, 'on &api_channel +@all -@dangerous +info');
  });

  void it('rejects a missing, unknown, or duplicate user', () => {
    const lines = VALID.split('\n');
    assert.throws(() => parseRedisAclRules(lines.slice(1).join('\n')), /expected users/);
    assert.throws(() => parseRedisAclRules(`${VALID}\nuser extra &x`), /expected users/);
    assert.throws(() => parseRedisAclRules(`${VALID}\n${lines[0] ?? ''}`), /defined twice/);
    assert.throws(() => parseRedisAclRules('api &x'), /unexpected line/);
  });

  void it('rejects rules that ElastiCache manages (passwords, on/off, reset)', () => {
    for (const bad of ['>secret', '#abcd', 'nopass', 'on', 'off', 'reset', 'resetchannels']) {
      assert.throws(
        () => parseRedisAclRules(VALID.replace('user api ', `user api ${bad} `)),
        /not allowed/,
        bad,
      );
    }
  });

  void it('creates users only for enabled services that use Valkey', () => {
    const config = loadConfig('dev', 'config', { includeLocal: false });
    const all = enabledCacheUsers(config);
    assert.ok(all.includes('api') && all.includes('worker'));
    const noCss = enabledCacheUsers({
      ...config,
      services: { ...config.services, css: { ...config.services.css, enabled: false } },
    });
    assert.ok(!noCss.includes('css'));
  });

  void it('rotation reads the user id from the secret user_arn', () => {
    assert.equal(
      userIdOf('arn:aws:elasticache:us-east-1:123456789012:user:evtivity-dev-api'),
      'evtivity-dev-api',
    );
    assert.throws(() => userIdOf('arn:aws:elasticache:us-east-1:123456789012:usergroup:x'));
    assert.throws(() => userIdOf('arn:aws:elasticache:us-east-1:123456789012:user:'));
  });
});
