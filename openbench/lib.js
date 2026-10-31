// Shared helpers: time zone maths, password hashing, hashing for the audit chain.
const crypto = require('crypto');
const TZ = process.env.INSTITUTION_TZ || 'Asia/Kolkata';
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function tzOffsetMs(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// Local (institution time zone) view of a timestamp
function local(ms) {
  const d = new Date(ms + tzOffsetMs(ms));
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
// 'YYYY-MM-DD' + 'HH:mm' in institution time -> epoch ms
function toTs(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const ts = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(ts);
}
function weekKey(ms) { // Monday-based week number in institution time
  const days = Math.floor(Date.parse(local(ms).date + 'T00:00:00Z') / 864e5);
  return Math.floor((days + 3) / 7);
}
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, stored) {
  const [s, h] = stored.split(':');
  const c = crypto.scryptSync(pw, s, 32), b = Buffer.from(h, 'hex');
  return c.length === b.length && crypto.timingSafeEqual(c, b);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(24).toString('hex');
module.exports = { TZ, local, toTs, weekKey, hhmm, hashPw, checkPw, sha256, token, tzOffsetMs };
