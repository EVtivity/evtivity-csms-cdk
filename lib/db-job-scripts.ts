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
