'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'openbench.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',            -- user | owner | admin
  owner_verified INTEGER NOT NULL DEFAULT 0,    -- admin verifies owners before they can list
  user_type TEXT NOT NULL DEFAULT 'student',    -- student | researcher | startup | community | staff
  org TEXT DEFAULT '', credits INTEGER NOT NULL DEFAULT 20,
  strikes INTEGER NOT NULL DEFAULT 0, suspended INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, evidence TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | verified | rejected
  decided_by INTEGER, decided_at INTEGER, decision_note TEXT DEFAULT '', expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
  icon TEXT DEFAULT '🔧', location TEXT NOT NULL, description TEXT DEFAULT '', rules TEXT DEFAULT '', tags TEXT DEFAULT '',
  requires TEXT DEFAULT '[]',                   -- JSON array of credential names
  allowed_types TEXT DEFAULT '[]',              -- JSON array of user types (empty = everyone)
  checklist TEXT DEFAULT '[]',                  -- JSON array of condition checklist items
  max_hours INTEGER NOT NULL DEFAULT 4, weekly_cap INTEGER NOT NULL DEFAULT 8, max_active INTEGER NOT NULL DEFAULT 2,
  deposit INTEGER NOT NULL DEFAULT 0, supervised INTEGER NOT NULL DEFAULT 0,
  open_days TEXT DEFAULT '[1,2,3,4,5]', open_start TEXT DEFAULT '09:00', open_end TEXT DEFAULT '18:00',
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS managers (resource_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(resource_id,user_id));
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, purpose_type TEXT NOT NULL, purpose TEXT NOT NULL,
  status TEXT NOT NULL,   -- pending|waitlisted|approved|rejected|cancelled|checked_in|returned|no_show|expired
  awaiting_verification INTEGER DEFAULT 0,
  decision_reason TEXT DEFAULT '', decided_by INTEGER, decided_at INTEGER, override_reason TEXT DEFAULT '',
  score_snapshot TEXT DEFAULT '{}', eligibility_snapshot TEXT DEFAULT '[]',
  deposit_held INTEGER DEFAULT 0, deposit_status TEXT DEFAULT 'none', -- none|held|released|forfeited
  checkin_ts INTEGER, checkin_condition TEXT, checkin_notes TEXT, checkin_checklist TEXT,
  return_ts INTEGER, return_condition TEXT, return_notes TEXT, return_checklist TEXT,
  confirmed_by INTEGER, confirmed_ts INTEGER, confirm_notes TEXT, final_condition TEXT,
  ext_end_ts INTEGER, ext_status TEXT, ext_reason TEXT,
  overdue_flag INTEGER DEFAULT 0, reminder_sent INTEGER DEFAULT 0, late_minutes INTEGER DEFAULT 0,
  cancelled_by INTEGER, cancel_reason TEXT, late_cancel INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_b_res ON bookings(resource_id, start_ts);
CREATE INDEX IF NOT EXISTS ix_b_user ON bookings(user_id);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL, resource_id INTEGER NOT NULL, reporter_id INTEGER,
  type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'minor', description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', auto_flagged INTEGER DEFAULT 0,
  outcome TEXT, resolution TEXT, resolved_by INTEGER, resolved_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, message TEXT NOT NULL, link TEXT DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor_id INTEGER, actor_name TEXT, actor_role TEXT,
  action TEXT NOT NULL, booking_id INTEGER, resource_id INTEGER, target_user_id INTEGER,
  summary TEXT NOT NULL, details TEXT DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_a_b ON audit(booking_id);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const get = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? { ...r } : null; };
const run = (sql, ...p) => db.prepare(sql).run(...p);
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const setting = (k, d = null) => { const r = get('SELECT v FROM settings WHERE k=?', k); return r ? r.v : d; };
const setSetting = (k, v) => run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));

module.exports = { db, all, get, run, tx, setting, setSetting, DATA_DIR };
