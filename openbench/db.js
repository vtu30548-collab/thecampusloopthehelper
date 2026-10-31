// SQLite (built into Node 22) + tamper-evident audit log.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const { sha256 } = require('./lib');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'openbench.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode=WAL');

raw.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, pass_hash TEXT, role TEXT DEFAULT 'user',
  member_type TEXT DEFAULT 'student', org TEXT, id_number TEXT, status TEXT DEFAULT 'unverified', strikes INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS resources(id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT, category TEXT, emoji TEXT, location TEXT, description TEXT, rules TEXT, tags TEXT,
  required_cert TEXT, verified_only INTEGER DEFAULT 1, allowed_types TEXT DEFAULT '', supervised INTEGER DEFAULT 0, auto_approve INTEGER DEFAULT 0, high_demand INTEGER DEFAULT 0,
  deposit INTEGER DEFAULT 0, max_hours REAL DEFAULT 4, max_active INTEGER DEFAULT 2, weekly_quota REAL DEFAULT 8,
  open_days TEXT DEFAULT '1,2,3,4,5', open_from INTEGER DEFAULT 540, open_to INTEGER DEFAULT 1080, status TEXT DEFAULT 'active', created_at INTEGER);
CREATE TABLE IF NOT EXISTS resource_managers(resource_id INTEGER, user_id INTEGER, PRIMARY KEY(resource_id,user_id));
CREATE TABLE IF NOT EXISTS user_certs(id INTEGER PRIMARY KEY, user_id INTEGER, cert TEXT, granted_by INTEGER, granted_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS cert_requests(id INTEGER PRIMARY KEY, user_id INTEGER, resource_id INTEGER, cert TEXT, note TEXT, status TEXT DEFAULT 'pending', decided_by INTEGER, decision_note TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, resource_id INTEGER, user_id INTEGER, start_ts INTEGER, end_ts INTEGER, purpose TEXT, purpose_type TEXT, attendees INTEGER DEFAULT 1,
  status TEXT, decision_reason TEXT, decided_by INTEGER, decided_at INTEGER, priority_score REAL, deposit_status TEXT DEFAULT 'none',
  checkin_at INTEGER, checkin_by INTEGER, checkin_condition TEXT, checkin_notes TEXT, checkout_at INTEGER, checkout_condition TEXT, checkout_notes TEXT, late_minutes INTEGER DEFAULT 0,
  return_confirmed_at INTEGER, return_confirmed_by INTEGER, return_note TEXT, reminded INTEGER DEFAULT 0, overdue_notified INTEGER DEFAULT 0, cancelled_by INTEGER, late_cancel INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS extensions(id INTEGER PRIMARY KEY, booking_id INTEGER, new_end_ts INTEGER, reason TEXT, status TEXT DEFAULT 'pending', decided_by INTEGER, decision_reason TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY, booking_id INTEGER, resource_id INTEGER, user_id INTEGER, reporter_id INTEGER, type TEXT, severity TEXT, description TEXT, summary TEXT,
  status TEXT DEFAULT 'open', resolution TEXT, resolved_by INTEGER, penalty TEXT DEFAULT 'none', appeal TEXT, appeal_decision TEXT, auto INTEGER DEFAULT 0, created_at INTEGER, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, ts INTEGER, text TEXT, link TEXT, read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, actor_id INTEGER, actor_name TEXT, action TEXT, entity TEXT, entity_id INTEGER, booking_id INTEGER, resource_id INTEGER, details TEXT, reason TEXT, prev_hash TEXT, hash TEXT);
CREATE INDEX IF NOT EXISTS idx_b_res ON bookings(resource_id,start_ts); CREATE INDEX IF NOT EXISTS idx_b_user ON bookings(user_id); CREATE INDEX IF NOT EXISTS idx_a_b ON audit(booking_id);
`);

const clean = p => p.map(v => (v === undefined ? null : v));
const db = {
  raw,
  get: (sql, ...p) => raw.prepare(sql).get(...clean(p)) || undefined,
  all: (sql, ...p) => raw.prepare(sql).all(...clean(p)),
  run: (sql, ...p) => { const r = raw.prepare(sql).run(...clean(p)); return { id: Number(r.lastInsertRowid), changes: r.changes }; },
  tx(fn) { raw.exec('BEGIN'); try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
};

// Append-only, hash-chained audit trail: each row's hash covers the previous row's hash,
// so any edit or deletion of history is detectable via /api/audit/verify.
function auditBody(r) { return JSON.stringify([r.ts, r.actor_id, r.actor_name, r.action, r.entity, r.entity_id, r.booking_id, r.resource_id, r.details, r.reason]); }
function log({ actor, action, entity, entity_id, booking_id, resource_id, details, reason, ts }) {
  const last = db.get('SELECT hash FROM audit ORDER BY id DESC LIMIT 1');
  const row = { ts: ts || Date.now(), actor_id: actor ? actor.id : null, actor_name: actor ? actor.name : 'System (rule-based)', action,
    entity: entity || null, entity_id: entity_id || null, booking_id: booking_id || null, resource_id: resource_id || null,
    details: details ? JSON.stringify(details) : null, reason: reason || null };
  const prev = last ? last.hash : 'GENESIS';
  const hash = sha256(prev + auditBody(row));
  db.run('INSERT INTO audit(ts,actor_id,actor_name,action,entity,entity_id,booking_id,resource_id,details,reason,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    row.ts, row.actor_id, row.actor_name, row.action, row.entity, row.entity_id, row.booking_id, row.resource_id, row.details, row.reason, prev, hash);
}
function verifyAudit() {
  let prev = 'GENESIS', n = 0;
  for (const r of db.all('SELECT * FROM audit ORDER BY id')) {
    if (r.prev_hash !== prev || sha256(prev + auditBody(r)) !== r.hash) return { ok: false, broken_at: r.id, checked: n };
    prev = r.hash; n++;
  }
  return { ok: true, checked: n, head: prev.slice(0, 16) };
}
module.exports = { db, log, verifyAudit };
