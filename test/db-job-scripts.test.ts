// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as scripts from '../lib/db-job-scripts.js';

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
});
