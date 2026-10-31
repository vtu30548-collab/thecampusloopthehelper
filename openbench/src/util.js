'use strict';
const crypto = require('node:crypto');

const TZ = process.env.CAMPUS_TZ || 'Asia/Kolkata';
let clockOffsetMs = 0; // demo clock (admin can fast-forward to show overdue / reminders)
const now = () => Date.now() + clockOffsetMs;
const setClockOffset = (ms) => { clockOffsetMs = ms; };
const getClockOffset = () => clockOffsetMs;

function tzOffsetMs(ts, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
// "YYYY-MM-DDTHH:mm" interpreted in campus timezone -> UTC ms
function localToUtc(str, tz = TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}
function localParts(ts, tz = TZ) {
  const d = new Date(ts + tzOffsetMs(ts, tz));
  const dow = d.getUTCDay(); // 0=Sun
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((dow + 6) % 7)));
  return { dow, date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekKey: monday.toISOString().slice(0, 10) };
}
const hhmmToMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;
const hours = (s, e) => (e - s) / 3600000;
const iso = (ms) => new Date(ms).toISOString();

// Passwords: scrypt with per-user salt
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash: h };
}
function verifyPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(h, b);
}
const token = () => crypto.randomBytes(24).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const clean = (s, max = 500) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

module.exports = { TZ, now, setClockOffset, getClockOffset, localToUtc, localParts, hhmmToMin, overlaps, hours, iso, hashPassword, verifyPassword, token, sha256, clean, isEmail };
