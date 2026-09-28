// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Scripts the database job runs inside the migrate image. The image's
// entrypoint builds DATABASE_URL from the DB_* fields, which come from the
// master secret, so every step connects as the cluster owner.

/** Group role that holds every application privilege. */
export const APP_GROUP_ROLE = 'evtivity_app_group';

/**
 * Creates the application login role if it does not exist and grants the
 * group role its privileges. Multi-user rotation clones the login role's
 * memberships onto `<user>_clone`, so both alternating users inherit the
 * group. Migrations run as the owner, and default privileges extend the
 * grants to tables that future migrations create.
 *
 * Existing roles keep their password: the rotation function owns it.
 */
export const BOOTSTRAP_JS = `
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const group = '${APP_GROUP_ROLE}';
const owner = process.env.DB_USER;
const database = process.env.DB_NAME;
const appUser = process.env.APP_DB_USER;
const appPassword = process.env.APP_DB_PASSWORD;

// format() quotes identifiers (%I) and literals (%L) server side.
async function run(fmt, ...args) {
  const params = args.map((a) => String(a));
  const placeholders = params.map((_, i) => '$' + String(i + 2) + '::text').join(', ');
  const [row] = await sql.unsafe('SELECT format($1::text, ' + placeholders + ') AS stmt', [fmt, ...params]);
  await sql.unsafe(row.stmt);
}
async function roleExists(name) {
  const [row] = await sql.unsafe('SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present', [name]);
  return row.present;
}

try {
  if (!(await roleExists(group))) await run('CREATE ROLE %I NOLOGIN', group);
  if (!(await roleExists(appUser))) {
    await run('CREATE ROLE %I WITH LOGIN PASSWORD %L', appUser, appPassword);
    console.log('[roles] created ' + appUser);
  }
  await run('GRANT %I TO %I', group, appUser);
  await run('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', database, group);
  await run('GRANT USAGE ON SCHEMA public TO %I', group);
  await run('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO %I', group);
  await run('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', group);
  await run('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', group);
  await run('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO %I', owner, group);
  await run('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', owner, group);
  await run('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', owner, group);
  await run('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE ON TYPES TO %I', owner, group);
  console.log('[roles] grants applied to ' + group);
} finally {
  await sql.end();
}
`;

/**
 * Upserts the non-secret settings from SETTINGS_JSON. Same behavior as the
 * Helm seed-settings job: keys ending in Enc are encrypted with the
 * application's own encryptString.
 */
export const SEED_SETTINGS_JS = `
import postgres from 'postgres';
import { encryptString } from '@evtivity/lib';

const settings = JSON.parse(process.env.SETTINGS_JSON ?? '{}');
const key = process.env.SETTINGS_ENCRYPTION_KEY;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  let count = 0;
  for (const [name, value] of Object.entries(settings)) {
    if (value === '' || value === null || value === undefined) continue;
    const stored = name.endsWith('Enc') && typeof value === 'string' ? encryptString(value, key) : value;
    const json = JSON.stringify(stored);
    await sql.unsafe(
      'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ' +
        'ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()',
      [name, json],
    );
    count++;
  }
  console.log('[settings] upserted ' + String(count) + ' settings');
} finally {
  await sql.end();
}
`;

/** Shell steps of the database job, in order. Stops at the first failure. */
export const DB_JOB_SH = [
  'set -eu',
  'cd /app/packages/database',
  'echo "[db-job] migrations"',
  'npm run migrate',
  'echo "[db-job] roles and grants"',
  'node --input-type=module -e "$BOOTSTRAP_JS"',
  'echo "[db-job] initial admin"',
  'npm run seed:admin',
  'echo "[db-job] settings"',
  'node --input-type=module -e "$SEED_SETTINGS_JS"',
  'echo "[db-job] done"',
].join('\n');

/**
 * Runs after the demo seed. Replaces the demo seed's well-known passwords
 * (admin123, driver123) with DEMO_PASSWORD, makes every dashboard account
 * the seed touched change its password at first sign-in, and caps how many
 * seeded simulator stations the css service boots. TLS stations stay
 * disabled when the OCPP TLS listener is off.
 */
export const SEED_DEMO_POST_JS = `
import postgres from 'postgres';
import argon2 from 'argon2';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const limit = Number(process.env.DEMO_STATION_LIMIT ?? '0');
const plainUrl = process.env.SEED_CSS_TARGET_URL;
const tlsUrl = process.env.SEED_CSS_TLS_TARGET_URL;
const tlsEnabled = process.env.DEMO_TLS_ENABLED === 'true';

try {
  const hash = await argon2.hash(process.env.DEMO_PASSWORD);
  const ops = await sql.unsafe(
    "UPDATE users SET password_hash = $1, must_reset_password = true, updated_at = now() " +
      "WHERE email LIKE 'operator%@evtivity.local'",
    [hash],
  );
  const admin = await sql.unsafe(
    'UPDATE users SET must_reset_password = true, updated_at = now() WHERE email = $1',
    [process.env.INITIAL_ADMIN_EMAIL],
  );
  const drivers = await sql.unsafe(
    "UPDATE drivers SET password_hash = $1, updated_at = now() WHERE email = 'driver@evtivity.local'",
    [hash],
  );
  console.log('[demo] demo password set on ' + String(ops.count) + ' operators and ' +
    String(drivers.count) + ' driver, ' + String(ops.count + admin.count) + ' accounts must reset');

  if (!tlsEnabled) {
    await sql.unsafe(
      'UPDATE css_stations SET enabled = false, updated_at = now() WHERE target_url = $1',
      [tlsUrl],
    );
  }
  const urls = tlsEnabled ? [plainUrl, tlsUrl] : [plainUrl];
  const off = await sql.unsafe(
    'UPDATE css_stations SET enabled = false, updated_at = now() ' +
      'WHERE enabled AND target_url = ANY($1::text[]) AND id NOT IN (' +
      'SELECT id FROM css_stations WHERE enabled AND target_url = ANY($1::text[]) ' +
      'ORDER BY station_id LIMIT $2)',
    [urls, limit],
  );
  console.log('[demo] simulator stations capped at ' + String(limit) + ', ' + String(off.count) + ' disabled');
} finally {
  await sql.end();
}
`;

/** Shell steps of the one-time demo seed job. */
export const SEED_DEMO_SH = [
  'set -eu',
  'cd /app/packages/database',
  'echo "[demo] seed"',
  'SEED_DEMO=true npm run seed',
  'echo "[demo] passwords and simulator limit"',
  'node --input-type=module -e "$SEED_DEMO_POST_JS"',
  // The seed overwrites every default setting. Put the configured ones back.
  'echo "[demo] settings"',
  'node --input-type=module -e "$SEED_SETTINGS_JS"',
  'echo "[demo] done"',
].join('\n');
