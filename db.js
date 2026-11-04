'use strict';
// Postgres (Neon in production) via DATABASE_URL. One small pool; all writes go through one serial
// queue so two writes to the same row can never land out of order. Schema migrations run at startup.
// PG_DRIVER=neon-ws: Neon's serverless driver (Postgres over a WebSocket on 443). Only for networks that
// can't reach Neon on 5432 (some sandboxes: one-off scripts). Render uses plain node-pg over TCP.
const NEON_WS = process.env.PG_DRIVER === 'neon-ws';
let Pool;
if (NEON_WS) { const n = require('@neondatabase/serverless'); n.neonConfig.webSocketConstructor = require('ws'); Pool = n.Pool; }
else Pool = require('pg').Pool;

const URL0 = process.env.DATABASE_URL;
if (!URL0) { console.error('DATABASE_URL is not set'); process.exit(1); }
// node-pg already treats sslmode=require as verify-full; say so explicitly (same behaviour, no deprecation warning)
const URL_ = URL0.replace(/([?&])sslmode=(require|prefer|verify-ca)(?=&|$)/, '$1sslmode=verify-full');
const local = /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(URL_);
const pool = NEON_WS ? new Pool({ connectionString: URL0, max: 2 }) : new Pool({
  connectionString: URL_,
  // Neon needs TLS; its URL usually carries sslmode=require. Local test DBs don't.
  ssl: /sslmode=disable/.test(URL_) || (local && !/sslmode=/.test(URL_)) ? false : (/sslmode=/.test(URL_) ? undefined : { rejectUnauthorized: true }),
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: 60000,        // close idle connections so Neon can scale to zero (5 min idle)
  connectionTimeoutMillis: 15000,  // a cold Neon compute takes ~0.5-2 s to wake
  allowExitOnIdle: true,
});
pool.on('error', (e) => console.error('pg pool error:', e.message)); // idle client dropped (e.g. Neon suspend)

const q = (text, params) => pool.query(text, params);

// serial write queue
let tail = Promise.resolve(); let writeErrors = 0, lastWriteError = null;
function w(text, params) {
  const run = tail.then(() => q(text, params));
  tail = run.catch(() => {});
  return run.catch((e) => { writeErrors++; lastWriteError = { at: new Date().toISOString(), message: e.message }; console.error('db write failed:', e.message); throw e; });
}
// several statements in one transaction, still in the queue
function tx(fn) {
  const run = tail.then(async () => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn((t, p) => c.query(t, p)); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
    finally { c.release(); }
  });
  tail = run.catch(() => {});
  return run.catch((e) => { writeErrors++; lastWriteError = { at: new Date().toISOString(), message: e.message }; console.error('db tx failed:', e.message); throw e; });
}
const flush = () => tail;

const MIGRATIONS = [
  // 1: initial schema. Rows keep the exact JSON shape the API returns (data jsonb), keyed for lookups.
  `CREATE TABLE IF NOT EXISTS messages (id integer PRIMARY KEY, data jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS subscriptions (endpoint text PRIMARY KEY, data jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS chat_messages (id integer PRIMARY KEY, data jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS sessions (key text PRIMARY KEY, data jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS submissions (id text PRIMARY KEY, lesson_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
   CREATE INDEX IF NOT EXISTS submissions_lesson ON submissions (lesson_id, created_at DESC);
   CREATE TABLE IF NOT EXISTS uploads (id text PRIMARY KEY, meta jsonb NOT NULL, bytes bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS content (path text PRIMARY KEY, body text NOT NULL, sha256 text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`,
];
// Whole migration run is one transaction with a transaction-scoped advisory lock, so it is safe behind
// Neon's -pooler endpoint (PgBouncer transaction mode, where session locks would leak across backends).
async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(7310412)'); // one migrator at a time (deploy overlap)
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    const applied = [];
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const v = i + 1; if (done.has(v)) continue;
      await c.query(MIGRATIONS[i]); await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]); applied.push(v);
    }
    await c.query('COMMIT');
    for (const v of applied) console.log(`db: migration ${v} applied`);
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { c.release(); }
}

async function ping() { const t = Date.now(); await q('SELECT 1'); return Date.now() - t; }
const stats = () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, write_errors: writeErrors, last_write_error: lastWriteError });

module.exports = { pool, q, w, tx, flush, migrate, ping, stats };
