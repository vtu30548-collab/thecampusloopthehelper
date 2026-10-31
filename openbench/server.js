// OpenBench - zero-dependency server (Node >= 22.5). Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const { db, log, verifyAudit } = require('./db');
const L = require('./lib');
const { seed, reset } = require('./seed');

const PORT = process.env.PORT || 3000;
const DEMO = process.env.DEMO_MODE !== 'false'; // demo: allow check-in outside the slot so judges can finish a journey immediately
const CATEGORIES = ['Fabrication', 'Computing', 'Media', 'Spaces', 'Electronics'];
const MEMBER_TYPES = ['student', 'faculty', 'researcher', 'staff', 'startup', 'community'];
const RANK = { poor: 0, fair: 1, good: 2, excellent: 3 };
const PURPOSE_PTS = { coursework: 15, research: 10, project: 5, personal: 0 };
const SYN = { cut: ['laser', 'cutting'], cutting: ['laser', 'cutting'], engrave: ['laser'], engraving: ['laser'], acrylic: ['laser'], wood: ['laser', 'cnc'], prototype: ['3d', 'printing'], print: ['3d', 'printing'], printing: ['3d', 'printing'], '3d': ['3d', 'printing'], mill: ['cnc'], milling: ['cnc'], aluminium: ['cnc'], pcb: ['cnc', 'electronics'], train: ['gpu', 'ml'], training: ['gpu', 'ml'], model: ['gpu', 'ml'], ml: ['gpu', 'ml'], ai: ['gpu', 'ml'], deep: ['gpu'], learning: ['gpu'], compute: ['gpu'], render: ['gpu', 'video'], record: ['studio', 'audio', 'podcast'], podcast: ['studio', 'podcast'], audio: ['studio', 'audio'], video: ['camera', 'video'], film: ['camera', 'film'], shoot: ['camera'], photo: ['camera'], meeting: ['room', 'meeting'], workshop: ['room', 'workshop'], seminar: ['room', 'seminar'], circuit: ['electronics', 'oscilloscope'], signal: ['oscilloscope', 'signal'], measure: ['oscilloscope', 'measure'], debug: ['electronics', 'oscilloscope'] };

class E extends Error { constructor(s, m, x) { super(m); this.status = s; this.extra = x; } }
const bad = (m, x) => new E(400, m, x);
const forbid = m => new E(403, m || 'You do not have permission to do this');
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const now = () => Date.now();

// ---------- tiny router ----------
const routes = [];
function route(method, pattern, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn, auth: opts.auth !== false });
}
const get = (p, o, f) => route('GET', p, o, f), post = (p, o, f) => route('POST', p, o, f), put = (p, o, f) => route('PUT', p, o, f);

// ---------- helpers ----------
const notify = (uid, text, link) => db.run('INSERT INTO notifications(user_id,ts,text,link) VALUES(?,?,?,?)', uid, now(), text, link || null);
const getRes = id => { const r = db.get('SELECT * FROM resources WHERE id=?', id); if (!r) throw new E(404, 'Resource not found'); return r; };
const getBooking = id => { const b = db.get('SELECT * FROM bookings WHERE id=?', Number(id)); if (!b) throw new E(404, 'Booking not found'); return b; };
const userRow = id => db.get('SELECT * FROM users WHERE id=?', id);
const managerIds = resId => [...new Set([getRes(resId).owner_id, ...db.all('SELECT user_id FROM resource_managers WHERE resource_id=?', resId).map(x => x.user_id)])];
const canManage = (u, resId) => u.role === 'admin' || managerIds(resId).includes(u.id);
const managedIds = u => u.role === 'admin' ? db.all('SELECT id FROM resources').map(x => x.id) : db.all('SELECT id FROM resources WHERE owner_id=? UNION SELECT resource_id FROM resource_managers WHERE user_id=?', u.id, u.id).map(x => x.id);
const notifyManagers = (resId, text, link, except) => managerIds(resId).filter(i => i !== except).forEach(i => notify(i, text, link));
const hrs = (s, e) => (e - s) / 36e5;
const fmtT = ts => { const l = L.local(ts); return `${l.date} ${L.hhmm(l.min)}`; };
const activeStates = "('pending','approved','checked_in','returned','completed')";
const holdStates = "('approved','checked_in')";
const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const openText = r => { const d = r.open_days.split(',').map(Number); return `${d.map(i => dayName[i]).join(', ')} ${L.hhmm(r.open_from)}-${L.hhmm(r.open_to)}`; };

function certsOf(uid) { return db.all('SELECT cert,expires_at FROM user_certs WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)', uid, now()).map(c => c.cert); }

// ---------- eligibility ----------
function eligibility(u, r) {
  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok, detail });
  add('active', 'Resource is open for sharing', r.status === 'active', r.status === 'active' ? 'Active' : 'This resource is paused by its owner');
  if (r.verified_only) add('verified', 'Verified identity', u.status === 'verified', u.status === 'verified' ? 'Your identity is verified' : u.status === 'suspended' ? 'Your account is suspended' : 'Your identity is not verified yet. An administrator must verify your ID first.');
  add('standing', 'Good standing (fewer than 3 strikes)', u.strikes < 3 && u.status !== 'suspended', u.strikes < 3 ? `${u.strikes} strike(s) on record` : 'Booking is paused after 3 strikes. Contact an administrator.');
  if (r.allowed_types) { const t = r.allowed_types.split(','); add('member', `Eligible member type (${t.join(', ')})`, t.includes(u.member_type), t.includes(u.member_type) ? `You are registered as ${u.member_type}` : `Your member type "${u.member_type}" is not eligible for this resource`); }
  if (r.required_cert) { const has = certsOf(u.id).includes(r.required_cert); add('cert', `Training: ${r.required_cert}`, has, has ? 'Certification on file' : 'Missing - request training from the resource page'); }
  return { ok: checks.every(c => c.ok), checks };
}

// ---------- explainable fairness priority ----------
function priority(b) {
  const u = userRow(b.user_id), parts = [];
  parts.push({ label: 'Base score', points: 50 });
  const pp = PURPOSE_PTS[b.purpose_type] ?? 0;
  if (pp) parts.push({ label: `Purpose: ${b.purpose_type}`, points: pp });
  const used = db.get(`SELECT COALESCE(SUM(end_ts-start_ts),0) t FROM bookings WHERE user_id=? AND resource_id=? AND id!=? AND status IN ('approved','checked_in','returned','completed') AND start_ts>?`, b.user_id, b.resource_id, b.id, now() - 30 * 864e5).t / 36e5;
  if (used > 0) parts.push({ label: `Heavy recent use (${used.toFixed(1)} h on this resource in 30 days)`, points: -Math.min(30, Math.round(used * 1.5)) });
  const prior = db.get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND resource_id=? AND id!=? AND status='completed'`, b.user_id, b.resource_id, b.id).c;
  if (!prior) parts.push({ label: 'First time on this resource', points: 10 });
  if (u.strikes) parts.push({ label: `${u.strikes} strike(s) on record`, points: -15 * u.strikes });
  const waitDays = Math.floor((now() - b.created_at) / 864e5);
  if (waitDays > 0) parts.push({ label: `Waiting ${waitDays} day(s)`, points: Math.min(15, waitDays * 2) });
  return { score: parts.reduce((s, p) => s + p.points, 0), parts };
}

// ---------- request evaluation (used for live preview AND creation) ----------
function evaluate(u, r, inp, excludeId = 0) {
  const problems = [], el = eligibility(u, r);
  el.checks.filter(c => !c.ok).forEach(c => problems.push({ type: 'eligibility', key: c.key, msg: c.detail }));
  const date = str(inp.date, 10), st = str(inp.start, 5), en = str(inp.end, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(en)) { problems.push({ type: 'slot', msg: 'Choose a date, start time and end time.' }); return { ok: false, problems, checks: el.checks }; }
  const s = L.toTs(date, st), e = L.toTs(date, en);
  const sl = L.local(s), dur = hrs(s, e);
  if (!(e > s)) problems.push({ type: 'slot', msg: 'End time must be after the start time.' });
  else {
    if (s < now() - 5 * 60000) problems.push({ type: 'slot', msg: 'That start time is in the past.' });
    if (s > now() + 60 * 864e5) problems.push({ type: 'slot', msg: 'Bookings can be made up to 60 days ahead.' });
    if (dur > r.max_hours) problems.push({ type: 'rule', msg: `Maximum ${r.max_hours} h per booking on this resource (you asked for ${dur} h).` });
    const days = r.open_days.split(',').map(Number);
    if (!days.includes(sl.dow) || sl.min < r.open_from || sl.min + Math.round(dur * 60) > r.open_to) problems.push({ type: 'slot', msg: `Outside opening hours (${openText(r)}).` });
    const wk = L.weekKey(s);
    const mine = db.all(`SELECT start_ts,end_ts FROM bookings WHERE user_id=? AND resource_id=? AND id!=? AND status IN ${activeStates}`, u.id, r.id, excludeId);
    const used = mine.filter(m => L.weekKey(m.start_ts) === wk).reduce((a, m) => a + hrs(m.start_ts, m.end_ts), 0);
    if (used + dur > r.weekly_quota) problems.push({ type: 'fairness', msg: `Fair-use limit: ${r.weekly_quota} h per week on this resource. You already hold ${used} h that week.` });
    const act = db.get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND resource_id=? AND id!=? AND end_ts>? AND status IN ('pending','approved','waitlisted')`, u.id, r.id, excludeId, now()).c;
    if (act >= r.max_active) problems.push({ type: 'fairness', msg: `Fair-use limit: at most ${r.max_active} open request(s) at a time on this resource. Cancel or finish one first.` });
    if (db.get(`SELECT id FROM bookings WHERE user_id=? AND resource_id=? AND id!=? AND status IN ('pending','approved','waitlisted','checked_in') AND start_ts<? AND end_ts>?`, u.id, r.id, excludeId, e, s)) problems.push({ type: 'slot', msg: 'You already have a request that overlaps this time.' });
  }
  const out = { ok: problems.length === 0, problems, checks: el.checks, s, e };
  if (!out.ok) return out;
  const conflict = db.get(`SELECT id,start_ts,end_ts FROM bookings WHERE resource_id=? AND status IN ${holdStates} AND start_ts<? AND end_ts>?`, r.id, e, s);
  const competing = db.get(`SELECT COUNT(*) c FROM bookings WHERE resource_id=? AND status IN ('pending','waitlisted') AND start_ts<? AND end_ts>?`, r.id, e, s).c;
  const prio = priority({ id: excludeId, user_id: u.id, resource_id: r.id, purpose_type: inp.purpose_type, created_at: now() });
  out.priority = prio; out.competing = competing;
  if (conflict) { out.outcome = 'waitlisted'; out.explanation = `That time overlaps an approved booking (${fmtT(conflict.start_ts)}-${L.hhmm(L.local(conflict.end_ts).min)}). You can still join the waiting list - if the slot opens, requests are offered in priority order and the owner makes the final decision.`; }
  else if (r.auto_approve && !r.high_demand && !r.supervised && competing === 0) { out.outcome = 'approved_auto'; out.explanation = 'Low-risk resource, all rules satisfied and no competing requests - this will be auto-approved by rule. The owner can still revoke it and every step is logged.'; }
  else { out.outcome = 'pending'; out.explanation = competing ? `${competing} other request(s) compete for this time. The owner will see everyone's fairness score and decide.` : 'All requirements met. Your request goes to the owner/manager for human review.'; }
  return out;
}

// ---------- state transitions ----------
function approve(b, actor, reason, auto) {
  const r = getRes(b.resource_id);
  if (db.get(`SELECT id FROM bookings WHERE resource_id=? AND id!=? AND status IN ${holdStates} AND start_ts<? AND end_ts>?`, b.resource_id, b.id, b.end_ts, b.start_ts)) throw new E(409, 'Another approved booking already holds this time. Reject or waitlist this request instead.');
  const p = priority(b);
  db.run(`UPDATE bookings SET status='approved',decision_reason=?,decided_by=?,decided_at=?,priority_score=?,deposit_status=? WHERE id=?`, reason, actor ? actor.id : null, now(), p.score, r.deposit > 0 ? 'held' : 'none', b.id);
  log({ actor, action: auto ? 'booking_auto_approved' : 'booking_approved', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, details: { priority: p.score, deposit_held: r.deposit }, reason });
  notify(b.user_id, `Approved: ${r.name} on ${fmtT(b.start_ts)}. ${r.deposit ? `Deposit INR ${r.deposit} is held (simulated).` : ''}`, `#/booking/${b.id}`);
  for (const o of db.all(`SELECT * FROM bookings WHERE resource_id=? AND id!=? AND status='pending' AND start_ts<? AND end_ts>?`, b.resource_id, b.id, b.end_ts, b.start_ts)) {
    const why = 'Another request for this time was approved. You are on the waiting list and will be notified if the slot opens.';
    db.run(`UPDATE bookings SET status='waitlisted',decision_reason=? WHERE id=?`, why, o.id);
    log({ actor: null, action: 'booking_waitlisted', entity: 'booking', entity_id: o.id, booking_id: o.id, resource_id: o.resource_id, reason: why });
    notify(o.user_id, `Waiting list: ${r.name} on ${fmtT(o.start_ts)} was given to another request.`, `#/booking/${o.id}`);
  }
}
function promoteWaitlist(resId, s, e) {
  const r = getRes(resId);
  const list = db.all(`SELECT * FROM bookings WHERE resource_id=? AND status='waitlisted' AND start_ts<? AND end_ts>? AND end_ts>?`, resId, e, s, now());
  list.map(w => ({ w, p: priority(w) })).sort((a, b) => b.p.score - a.p.score).forEach(({ w, p }, i) => {
    if (db.get(`SELECT id FROM bookings WHERE resource_id=? AND status IN ${holdStates} AND start_ts<? AND end_ts>?`, resId, w.end_ts, w.start_ts)) return;
    const why = `The slot opened up. Your request moved back to review (priority ${p.score}, queue position ${i + 1}).`;
    db.run(`UPDATE bookings SET status='pending',decision_reason=? WHERE id=?`, why, w.id);
    log({ actor: null, action: 'waitlist_promoted', entity: 'booking', entity_id: w.id, booking_id: w.id, resource_id: resId, details: { priority: p.score, position: i + 1 }, reason: why });
    notify(w.user_id, `Good news: the slot for ${r.name} on ${fmtT(w.start_ts)} opened. Awaiting owner review.`, `#/booking/${w.id}`);
    notifyManagers(resId, `A waiting-list request is back in review for ${r.name} (${fmtT(w.start_ts)}).`, '#/manage');
  });
}
function openIncident({ b, reporter, type, severity, description, auto, summaryExtra }) {
  const r = getRes(b.resource_id);
  const summary = `Assistive summary (rule-generated, NOT a decision): ${type} incident, severity ${severity}, on "${r.name}" during booking #${b.id}. ${summaryExtra || ''}Reported detail: "${description.slice(0, 220)}". A manager must review this before any penalty is applied.`;
  const id = db.run(`INSERT INTO incidents(booking_id,resource_id,user_id,reporter_id,type,severity,description,summary,auto,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, b.id, b.resource_id, b.user_id, reporter ? reporter.id : null, type, severity, description, summary, auto ? 1 : 0, now()).id;
  log({ actor: reporter, action: 'incident_reported', entity: 'incident', entity_id: id, booking_id: b.id, resource_id: b.resource_id, details: { type, severity, auto: !!auto }, reason: description.slice(0, 300) });
  notifyManagers(b.resource_id, `Incident reported (${type}, ${severity}) on ${r.name}. Review needed.`, '#/manage', reporter && reporter.id);
  return id;
}

// ---------- background sweep: reminders, no-shows, overdue ----------
function sweep() {
  const t = now();
  for (const b of db.all(`SELECT * FROM bookings WHERE status='approved' AND reminded=0 AND start_ts>? AND start_ts<?`, t, t + 60 * 6e4)) {
    db.run('UPDATE bookings SET reminded=1 WHERE id=?', b.id);
    notify(b.user_id, `Reminder: ${getRes(b.resource_id).name} starts at ${fmtT(b.start_ts)}.`, `#/booking/${b.id}`);
    log({ actor: null, action: 'reminder_sent', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id });
  }
  for (const b of db.all(`SELECT * FROM bookings WHERE status='approved' AND start_ts<?`, t - 30 * 6e4)) {
    db.run(`UPDATE bookings SET status='no_show',deposit_status=CASE WHEN deposit_status='held' THEN 'held' ELSE deposit_status END WHERE id=?`, b.id);
    log({ actor: null, action: 'no_show_flagged', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, reason: 'No check-in within 30 minutes of start' });
    notify(b.user_id, `You did not check in for ${getRes(b.resource_id).name}. The slot was released and a manager will review.`, `#/booking/${b.id}`);
    openIncident({ b, reporter: null, type: 'no_show', severity: 'low', description: 'No check-in within 30 minutes of the start time.', auto: true });
    promoteWaitlist(b.resource_id, b.start_ts, b.end_ts);
  }
  for (const b of db.all(`SELECT * FROM bookings WHERE status='checked_in' AND overdue_notified=0 AND end_ts<?`, t)) {
    db.run('UPDATE bookings SET overdue_notified=1 WHERE id=?', b.id);
    const r = getRes(b.resource_id);
    log({ actor: null, action: 'overdue_flagged', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, details: { minutes_over: Math.round((t - b.end_ts) / 6e4) } });
    notify(b.user_id, `Overdue: please return ${r.name} now and complete check-out.`, `#/booking/${b.id}`);
    notifyManagers(b.resource_id, `OVERDUE: ${userRow(b.user_id).name} has not returned ${r.name} (was due ${fmtT(b.end_ts)}).`, '#/manage');
  }
}

// ---------- output shaping / privacy ----------
function requesterView(uid, showContact) {
  const u = userRow(uid);
  const v = { id: u.id, name: u.name, member_type: u.member_type, org: u.org, status: u.status, strikes: u.strikes, certs: certsOf(uid) };
  if (showContact) v.email = u.email; // contact details only revealed once a booking is approved
  return v;
}
function bookingOut(b, viewer) {
  const r = getRes(b.resource_id), mgr = canManage(viewer, b.resource_id);
  const o = { ...b, resource_name: r.name, resource_emoji: r.emoji, resource_location: r.location, supervised: !!r.supervised, deposit: r.deposit,
    perms: { isRequester: b.user_id === viewer.id, isManager: mgr }, is_overdue: b.status === 'checked_in' && b.end_ts < now() };
  if (mgr) { o.requester = requesterView(b.user_id, ['approved', 'checked_in', 'returned', 'completed'].includes(b.status)); if (['pending', 'waitlisted'].includes(b.status)) o.priority = priority(b); }
  return o;
}

// ================= ROUTES =================
const loginAttempts = new Map();
post('/api/auth/login', { auth: false }, ctx => {
  const ip = ctx.ip, a = loginAttempts.get(ip) || { n: 0, t: now() };
  if (now() - a.t > 5 * 6e4) { a.n = 0; a.t = now(); }
  if (a.n >= 15) throw new E(429, 'Too many attempts. Try again in a few minutes.');
  const u = db.get('SELECT * FROM users WHERE email=?', str(ctx.body.email, 120).toLowerCase());
  if (!u || !L.checkPw(String(ctx.body.password || ''), u.pass_hash)) { a.n++; loginAttempts.set(ip, a); throw new E(401, 'Incorrect email or password'); }
  const token = L.token(); db.run('INSERT INTO sessions VALUES(?,?,?)', token, u.id, now());
  log({ actor: u, action: 'login', entity: 'user', entity_id: u.id });
  return { token };
});
post('/api/auth/register', { auth: false }, ctx => {
  const b = ctx.body, email = str(b.email, 120).toLowerCase(), name = str(b.name, 80);
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter your name and a valid email');
  if (String(b.password || '').length < 8) throw bad('Password must be at least 8 characters');
  if (!MEMBER_TYPES.includes(b.member_type)) throw bad('Choose a member type');
  if (db.get('SELECT id FROM users WHERE email=?', email)) throw bad('An account with this email already exists');
  const id = db.run('INSERT INTO users(name,email,pass_hash,role,member_type,org,id_number,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', name, email, L.hashPw(b.password), 'user', b.member_type, str(b.org, 120), str(b.id_number, 40), 'unverified', now()).id;
  log({ actor: userRow(id), action: 'account_registered', entity: 'user', entity_id: id, details: { member_type: b.member_type } });
  db.all("SELECT id FROM users WHERE role='admin'").forEach(a => notify(a.id, `New account awaiting identity verification: ${name} (${b.member_type}).`, '#/admin'));
  const token = L.token(); db.run('INSERT INTO sessions VALUES(?,?,?)', token, id, now());
  return { token };
});
post('/api/auth/logout', ctx => { db.run('DELETE FROM sessions WHERE token=?', ctx.token); return { ok: true }; });
get('/api/meta', { auth: false }, () => ({ tz: L.TZ, demo: DEMO, categories: CATEGORIES, memberTypes: MEMBER_TYPES }));
get('/api/me', ctx => {
  const u = ctx.user;
  const used = db.get(`SELECT COALESCE(SUM(end_ts-start_ts),0) t FROM bookings WHERE user_id=? AND status IN ('approved','checked_in','returned','completed') AND start_ts>?`, u.id, now() - 30 * 864e5).t / 36e5;
  return { id: u.id, name: u.name, email: u.email, role: u.role, member_type: u.member_type, org: u.org, status: u.status, strikes: u.strikes, certs: certsOf(u.id), hours_30d: Math.round(used * 10) / 10, manages: managedIds(u).length > 0 && u.role !== 'user', unread: db.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', u.id).c };
});

// ----- resources -----
function resOut(r, u) {
  const el = eligibility(u, r);
  return { ...r, owner_name: userRow(r.owner_id).name, open_text: openText(r), eligible: el.ok, failing: el.checks.filter(c => !c.ok).map(c => c.label),
    demand: db.get(`SELECT COUNT(*) c FROM bookings WHERE resource_id=? AND status IN ('pending','waitlisted') AND end_ts>?`, r.id, now()).c };
}
get('/api/resources', ctx => {
  const q = str(ctx.query.q, 120).toLowerCase(), cat = str(ctx.query.category, 40);
  let list = db.all(`SELECT * FROM resources WHERE status='active' ${cat ? 'AND category=?' : ''} ORDER BY name`, ...(cat ? [cat] : [])).map(r => resOut(r, ctx.user));
  if (q) {
    const STOP = new Set(['for', 'the', 'and', 'with', 'need', 'want', 'to', 'of', 'my', 'our', 'can', 'use', 'some', 'something', 'make', 'build', 'new', 'get']);
    const toks = q.split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t)), terms = new Map();
    toks.forEach(t => { terms.set(t, 2); (SYN[t] || []).forEach(s => terms.set(s, Math.max(1, terms.get(s) || 0))); });
    list = list.map(r => {
      const hay = `${r.name} ${r.description} ${r.tags} ${r.category} ${r.location}`.toLowerCase(), hit = [];
      let score = 0; terms.forEach((w, t) => { if (hay.includes(t)) { score += w; hit.push(t); } });
      return { ...r, match_score: score + (r.eligible ? 1 : 0), match_terms: hit.slice(0, 5) };
    }).filter(r => r.match_terms.length).sort((a, b) => b.match_score - a.match_score);
  }
  if (ctx.query.eligible === '1') list = list.filter(r => r.eligible);
  return list;
});
get('/api/resources/:id', ctx => {
  const r = getRes(ctx.params.id), u = ctx.user, el = eligibility(u, r);
  const slots = db.all(`SELECT start_ts,end_ts,status FROM bookings WHERE resource_id=? AND status IN ('approved','checked_in') AND end_ts>? AND start_ts<?`, r.id, now() - 864e5, now() + 8 * 864e5);
  const mgrs = managerIds(r.id).map(i => userRow(i).name);
  return { ...resOut(r, u), eligibility: el, slots, managers: mgrs, can_manage: canManage(u, r.id), my_cert_request: db.get(`SELECT status FROM cert_requests WHERE user_id=? AND resource_id=? ORDER BY id DESC LIMIT 1`, u.id, r.id) };
});
post('/api/resources/:id/check', ctx => { const r = getRes(ctx.params.id); const o = evaluate(ctx.user, r, ctx.body); delete o.s; delete o.e; return o; });
function resourceFields(b) {
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const days = String(b.open_days || '1,2,3,4,5').split(',').map(Number).filter(d => d >= 0 && d <= 6);
  const f = { name: str(b.name, 100), category: CATEGORIES.includes(b.category) ? b.category : null, emoji: str(b.emoji, 4) || '🔧', location: str(b.location, 120), description: str(b.description, 800), rules: str(b.rules, 800), tags: str(b.tags, 200).toLowerCase(),
    required_cert: str(b.required_cert, 80) || null, verified_only: b.verified_only ? 1 : 0, allowed_types: (Array.isArray(b.allowed_types) ? b.allowed_types : String(b.allowed_types || '').split(',')).filter(t => MEMBER_TYPES.includes(t)).join(','),
    supervised: b.supervised ? 1 : 0, auto_approve: b.auto_approve ? 1 : 0, high_demand: b.high_demand ? 1 : 0, deposit: n(b.deposit, 0, 100000, 0), max_hours: n(b.max_hours, 0.5, 24, 4), max_active: n(b.max_active, 1, 10, 2), weekly_quota: n(b.weekly_quota, 1, 80, 8),
    open_days: days.join(',') || '1,2,3,4,5', open_from: n(b.open_from, 0, 1439, 540), open_to: n(b.open_to, 1, 1440, 1080) };
  if (!f.name || !f.category || !f.location) throw bad('Name, category and location are required');
  if (f.open_to <= f.open_from) throw bad('Closing time must be after opening time');
  return f;
}
post('/api/resources', ctx => {
  if (!['owner', 'admin'].includes(ctx.user.role)) throw forbid('Only verified owners can list resources');
  const f = resourceFields(ctx.body), cols = Object.keys(f);
  const id = db.run(`INSERT INTO resources(owner_id,${cols.join(',')},status,created_at) VALUES(?,${cols.map(() => '?').join(',')},'active',?)`, ctx.user.id, ...cols.map(c => f[c]), now()).id;
  log({ actor: ctx.user, action: 'resource_listed', entity: 'resource', entity_id: id, resource_id: id, details: { name: f.name, required_cert: f.required_cert, deposit: f.deposit } });
  return { id };
});
put('/api/resources/:id', ctx => {
  const r = getRes(ctx.params.id);
  if (!(ctx.user.role === 'admin' || r.owner_id === ctx.user.id)) throw forbid('Only the owner can edit conditions');
  const f = resourceFields(ctx.body); f.status = ctx.body.status === 'paused' ? 'paused' : 'active';
  const cols = Object.keys(f);
  db.run(`UPDATE resources SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`, ...cols.map(c => f[c]), r.id);
  log({ actor: ctx.user, action: 'resource_updated', entity: 'resource', entity_id: r.id, resource_id: r.id, details: { status: f.status } });
  return { ok: true };
});
post('/api/resources/:id/request-cert', ctx => {
  const r = getRes(ctx.params.id); if (!r.required_cert) throw bad('This resource needs no training');
  if (db.get(`SELECT id FROM cert_requests WHERE user_id=? AND resource_id=? AND status='pending'`, ctx.user.id, r.id)) throw bad('You already have a pending training request');
  const id = db.run('INSERT INTO cert_requests(user_id,resource_id,cert,note,created_at) VALUES(?,?,?,?,?)', ctx.user.id, r.id, r.required_cert, str(ctx.body.note, 300), now()).id;
  log({ actor: ctx.user, action: 'training_requested', entity: 'cert_request', entity_id: id, resource_id: r.id, details: { cert: r.required_cert } });
  notifyManagers(r.id, `${ctx.user.name} requested training: ${r.required_cert}.`, '#/manage');
  return { id };
});

// ----- bookings -----
post('/api/resources/:id/book', ctx => {
  const r = getRes(ctx.params.id), u = ctx.user, inp = ctx.body;
  if (!PURPOSE_PTS.hasOwnProperty(inp.purpose_type)) throw bad('Choose a purpose type');
  const purpose = str(inp.purpose, 400); if (purpose.length < 5) throw bad('Please describe what you will use the resource for (at least 5 characters)');
  const ev = evaluate(u, r, inp);
  if (!ev.ok) throw new E(422, 'This request cannot be submitted yet', { problems: ev.problems });
  const status = ev.outcome === 'waitlisted' ? 'waitlisted' : 'pending';
  const id = db.run(`INSERT INTO bookings(resource_id,user_id,start_ts,end_ts,purpose,purpose_type,attendees,status,decision_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, r.id, u.id, ev.s, ev.e, purpose, inp.purpose_type, Math.min(50, Math.max(1, Number(inp.attendees) || 1)), status, status === 'waitlisted' ? ev.explanation : null, now()).id;
  log({ actor: u, action: 'booking_requested', entity: 'booking', entity_id: id, booking_id: id, resource_id: r.id, details: { start: ev.s, end: ev.e, purpose_type: inp.purpose_type, outcome: ev.outcome, priority: ev.priority.score, competing: ev.competing }, reason: purpose });
  let b = getBooking(id);
  if (ev.outcome === 'approved_auto') { approve(b, null, 'Auto-approved by rule: low-risk resource, requirements met, no competing requests.', true); }
  else notifyManagers(r.id, `${status === 'waitlisted' ? 'Waitlisted' : 'New'} request for ${r.name}: ${u.name}, ${fmtT(ev.s)}.`, '#/manage', u.id);
  return { id, status: getBooking(id).status };
});
get('/api/bookings/mine', ctx => db.all('SELECT * FROM bookings WHERE user_id=? ORDER BY start_ts DESC', ctx.user.id).map(b => bookingOut(b, ctx.user)));
get('/api/bookings/:id', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user, mgr = canManage(u, b.resource_id);
  if (b.user_id !== u.id && !mgr) throw forbid('This booking is private to the requester and the resource managers');
  const out = bookingOut(b, u), r = getRes(b.resource_id);
  out.resource = { id: r.id, name: r.name, rules: r.rules, location: r.location, required_cert: r.required_cert, max_hours: r.max_hours };
  out.priority = out.priority || (['pending', 'waitlisted'].includes(b.status) ? priority(b) : null);
  out.audit = db.all('SELECT id,ts,actor_name,action,details,reason,hash FROM audit WHERE booking_id=? ORDER BY id', b.id);
  out.incidents = db.all('SELECT * FROM incidents WHERE booking_id=? ORDER BY id', b.id);
  out.extensions = db.all('SELECT * FROM extensions WHERE booking_id=? ORDER BY id', b.id);
  if (mgr && ['pending', 'waitlisted'].includes(b.status)) out.competing = db.all(`SELECT * FROM bookings WHERE resource_id=? AND id!=? AND status IN ('pending','waitlisted') AND start_ts<? AND end_ts>?`, b.resource_id, b.id, b.end_ts, b.start_ts).map(x => ({ id: x.id, status: x.status, name: userRow(x.user_id).name, start_ts: x.start_ts, end_ts: x.end_ts, priority: priority(x) }));
  return out;
});
post('/api/bookings/:id/decide', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user;
  if (!canManage(u, b.resource_id)) throw forbid('Only the owner or an authorised manager can decide');
  if (!['pending', 'waitlisted'].includes(b.status)) throw new E(409, `This request is already ${b.status}`);
  const d = ctx.body.decision, reason = str(ctx.body.reason, 400), r = getRes(b.resource_id);
  if (!['approve', 'reject', 'waitlist'].includes(d)) throw bad('Decision must be approve, reject or waitlist');
  if (d !== 'approve' && reason.length < 5) throw bad('Please give the requester a reason (at least 5 characters)');
  if (d === 'approve') approve(b, u, reason || 'Approved: requirements met and slot available.');
  else if (d === 'reject') {
    db.run(`UPDATE bookings SET status='rejected',decision_reason=?,decided_by=?,decided_at=? WHERE id=?`, reason, u.id, now(), b.id);
    log({ actor: u, action: 'booking_rejected', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, reason }); notify(b.user_id, `Rejected: ${r.name} on ${fmtT(b.start_ts)}. Reason: ${reason}`, `#/booking/${b.id}`);
  } else {
    db.run(`UPDATE bookings SET status='waitlisted',decision_reason=?,decided_by=?,decided_at=? WHERE id=?`, reason, u.id, now(), b.id);
    log({ actor: u, action: 'booking_waitlisted', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, reason }); notify(b.user_id, `Waiting list: ${r.name} on ${fmtT(b.start_ts)}. Reason: ${reason}`, `#/booking/${b.id}`);
  }
  return { status: getBooking(b.id).status };
});
post('/api/bookings/:id/cancel', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user, mgr = canManage(u, b.resource_id), own = b.user_id === u.id;
  if (!own && !mgr) throw forbid();
  if (!['pending', 'waitlisted', 'approved'].includes(b.status)) throw new E(409, `A ${b.status} booking cannot be cancelled`);
  const reason = str(ctx.body.reason, 300); if (!own && reason.length < 5) throw bad('Managers must give a reason when cancelling someone else\'s booking');
  const late = own && b.status === 'approved' && b.start_ts - now() < 2 * 36e5 ? 1 : 0, wasHeld = b.status === 'approved';
  db.run(`UPDATE bookings SET status='cancelled',cancelled_by=?,late_cancel=?,decision_reason=?,deposit_status=CASE WHEN deposit_status='held' THEN 'released' ELSE deposit_status END WHERE id=?`, u.id, late, reason || 'Cancelled by requester', b.id);
  log({ actor: u, action: own ? 'booking_cancelled' : 'booking_revoked_by_manager', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, details: { late_cancellation: !!late }, reason });
  if (own) notifyManagers(b.resource_id, `${u.name} cancelled ${fmtT(b.start_ts)}${late ? ' (late cancellation)' : ''}.`, '#/manage', u.id); else notify(b.user_id, `Your booking on ${fmtT(b.start_ts)} was cancelled by a manager. Reason: ${reason}`, `#/booking/${b.id}`);
  if (wasHeld) promoteWaitlist(b.resource_id, b.start_ts, b.end_ts);
  return { ok: true, late_cancellation: !!late };
});
post('/api/bookings/:id/checkin', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user, r = getRes(b.resource_id), mgr = canManage(u, b.resource_id);
  if (b.user_id !== u.id && !mgr) throw forbid();
  if (r.supervised && !mgr) throw forbid('This resource is supervised: a lab manager must check you in and verify your ID and training on site.');
  if (b.status !== 'approved') throw new E(409, `Only approved bookings can be checked in (this one is ${b.status})`);
  const cond = ctx.body.condition; if (!(cond in RANK)) throw bad('Record the condition you found the resource in');
  const t = now(), early = t < b.start_ts - 30 * 6e4;
  if (t > b.end_ts) throw new E(409, 'This booking window has already ended');
  if (early && !DEMO) throw new E(409, `Check-in opens 30 minutes before the start (${fmtT(b.start_ts)})`);
  db.run(`UPDATE bookings SET status='checked_in',checkin_at=?,checkin_by=?,checkin_condition=?,checkin_notes=? WHERE id=?`, t, u.id, cond, str(ctx.body.notes, 400), b.id);
  log({ actor: u, action: 'check_in', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, details: { condition: cond, notes: str(ctx.body.notes, 400), early_demo_checkin: early, on_behalf: b.user_id !== u.id } });
  if (b.user_id !== u.id) notify(b.user_id, `You were checked in to ${r.name} by ${u.name}. Initial condition recorded: ${cond}.`, `#/booking/${b.id}`);
  return { ok: true };
});
post('/api/bookings/:id/checkout', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user, r = getRes(b.resource_id);
  if (b.user_id !== u.id && !canManage(u, b.resource_id)) throw forbid();
  if (b.status !== 'checked_in') throw new E(409, 'Only checked-in bookings can be returned');
  const cond = ctx.body.condition; if (!(cond in RANK)) throw bad('Record the condition you are returning it in');
  const damage = !!ctx.body.damage, dmgText = str(ctx.body.damage_description, 400);
  if (damage && dmgText.length < 5) throw bad('Describe the damage so the owner can assess it');
  const t = now(), late = Math.max(0, Math.round((t - b.end_ts) / 6e4)), drop = RANK[b.checkin_condition] - RANK[cond];
  db.run(`UPDATE bookings SET status='returned',checkout_at=?,checkout_condition=?,checkout_notes=?,late_minutes=? WHERE id=?`, t, cond, str(ctx.body.notes, 400), late, b.id);
  log({ actor: u, action: 'check_out', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, details: { condition: cond, checkin_condition: b.checkin_condition, notes: str(ctx.body.notes, 400), late_minutes: late, damage_flagged: damage } });
  notifyManagers(b.resource_id, `${userRow(b.user_id).name} returned ${r.name}${late ? ` (${late} min late)` : ''}. Confirm the return.`, '#/manage', u.id);
  const flags = [];
  if (damage || drop >= 1) { openIncident({ b, reporter: u, type: 'damage', severity: damage || drop >= 2 ? 'high' : 'medium', description: damage ? dmgText : `Condition recorded as ${cond} at return, was ${b.checkin_condition} at check-in.`, auto: !damage, summaryExtra: `Condition changed from ${b.checkin_condition} to ${cond}. ` }); flags.push('damage'); }
  if (late > 15) { openIncident({ b, reporter: null, type: 'delay', severity: 'low', description: `Returned ${late} minutes after the booked end time.`, auto: true, summaryExtra: `Returned ${late} min late. ` }); flags.push('delay'); }
  promoteWaitlist(b.resource_id, b.end_ts, b.end_ts + 864e5);
  return { ok: true, late_minutes: late, flags };
});
post('/api/bookings/:id/confirm-return', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user, r = getRes(b.resource_id);
  if (!canManage(u, b.resource_id)) throw forbid('Only the owner or manager can confirm a return');
  if (b.status !== 'returned') throw new E(409, 'Nothing to confirm: the user has not checked out yet');
  const act = ctx.body.deposit_action === 'withhold' ? 'withhold' : 'release', note = str(ctx.body.note, 400);
  if (act === 'withhold' && note.length < 5) throw bad('Explain why the deposit is withheld');
  const dep = b.deposit_status === 'held' ? (act === 'withhold' ? 'withheld' : 'released') : b.deposit_status;
  db.run(`UPDATE bookings SET status='completed',return_confirmed_at=?,return_confirmed_by=?,return_note=?,deposit_status=? WHERE id=?`, now(), u.id, note, dep, b.id);
  log({ actor: u, action: 'return_confirmed', entity: 'booking', entity_id: b.id, booking_id: b.id, resource_id: b.resource_id, details: { deposit: dep }, reason: note });
  notify(b.user_id, `Return confirmed for ${r.name}.${dep === 'released' ? ' Deposit released.' : dep === 'withheld' ? ' Deposit withheld - see the booking for the reason.' : ''}`, `#/booking/${b.id}`);
  return { ok: true };
});
post('/api/bookings/:id/extend', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user, r = getRes(b.resource_id);
  if (b.user_id !== u.id) throw forbid();
  if (!['approved', 'checked_in'].includes(b.status)) throw new E(409, 'Only approved or active bookings can be extended');
  if (!/^\d{2}:\d{2}$/.test(String(ctx.body.end || ''))) throw bad('Choose the new end time');
  const ne = L.toTs(L.local(b.start_ts).date, ctx.body.end), reason = str(ctx.body.reason, 300);
  if (ne <= b.end_ts) throw bad('The new end time must be later than the current one');
  if (reason.length < 5) throw bad('Say why you need more time');
  if (hrs(b.start_ts, ne) > r.max_hours) throw bad(`Total time cannot exceed ${r.max_hours} h on this resource`);
  if (L.local(ne).min > r.open_to) throw bad(`The resource closes at ${L.hhmm(r.open_to)}`);
  const c = db.get(`SELECT id FROM bookings WHERE resource_id=? AND id!=? AND status IN ${holdStates} AND start_ts<? AND end_ts>?`, r.id, b.id, ne, b.end_ts);
  if (c) throw new E(409, 'Someone else is booked right after you, so this cannot be extended. Please return on time.');
  const id = db.run('INSERT INTO extensions(booking_id,new_end_ts,reason,created_at) VALUES(?,?,?,?)', b.id, ne, reason, now()).id;
  log({ actor: u, action: 'extension_requested', entity: 'extension', entity_id: id, booking_id: b.id, resource_id: b.resource_id, details: { new_end: ne }, reason });
  notifyManagers(b.resource_id, `${u.name} asks to extend ${r.name} until ${fmtT(ne)}.`, '#/manage');
  return { id };
});
post('/api/extensions/:id/decide', ctx => {
  const x = db.get('SELECT * FROM extensions WHERE id=?', Number(ctx.params.id)); if (!x) throw new E(404, 'Not found');
  const b = getBooking(x.booking_id);
  if (!canManage(ctx.user, b.resource_id)) throw forbid();
  if (x.status !== 'pending') throw new E(409, 'Already decided');
  const ok = ctx.body.decision === 'approve', reason = str(ctx.body.reason, 300);
  if (!ok && reason.length < 5) throw bad('Give a reason when declining');
  if (ok && db.get(`SELECT id FROM bookings WHERE resource_id=? AND id!=? AND status IN ${holdStates} AND start_ts<? AND end_ts>?`, b.resource_id, b.id, x.new_end_ts, b.end_ts)) throw new E(409, 'A later booking now conflicts with this extension');
  db.run('UPDATE extensions SET status=?,decided_by=?,decision_reason=? WHERE id=?', ok ? 'approved' : 'declined', ctx.user.id, reason, x.id);
  if (ok) db.run('UPDATE bookings SET end_ts=?,overdue_notified=0 WHERE id=?', x.new_end_ts, b.id);
  log({ actor: ctx.user, action: ok ? 'extension_approved' : 'extension_declined', entity: 'extension', entity_id: x.id, booking_id: b.id, resource_id: b.resource_id, details: { new_end: x.new_end_ts }, reason });
  notify(b.user_id, `Extension ${ok ? 'approved' : 'declined'} for ${getRes(b.resource_id).name}.${reason ? ' ' + reason : ''}`, `#/booking/${b.id}`);
  return { ok: true };
});

// ----- incidents -----
post('/api/bookings/:id/incident', ctx => {
  const b = getBooking(ctx.params.id), u = ctx.user;
  if (b.user_id !== u.id && !canManage(u, b.resource_id)) throw forbid();
  const type = ['damage', 'delay', 'conflict', 'safety', 'other'].includes(ctx.body.type) ? ctx.body.type : 'other', sev = ['low', 'medium', 'high'].includes(ctx.body.severity) ? ctx.body.severity : 'low', desc = str(ctx.body.description, 600);
  if (desc.length < 5) throw bad('Describe what happened');
  return { id: openIncident({ b, reporter: u, type, severity: sev, description: desc }) };
});
post('/api/incidents/:id/resolve', ctx => {
  const i = db.get('SELECT * FROM incidents WHERE id=?', Number(ctx.params.id)); if (!i) throw new E(404, 'Not found');
  if (!canManage(ctx.user, i.resource_id)) throw forbid();
  if (i.status !== 'open') throw new E(409, 'This incident is already closed');
  const pen = ['none', 'warning', 'strike', 'suspend'].includes(ctx.body.penalty) ? ctx.body.penalty : 'none', res = str(ctx.body.resolution, 500);
  if (res.length < 5) throw bad('Write a resolution note - it is shown to the user and kept in the audit trail');
  if (pen === 'suspend' && ctx.user.role !== 'admin') throw forbid('Only an administrator can suspend an account');
  db.run(`UPDATE incidents SET status='resolved',resolution=?,resolved_by=?,penalty=?,resolved_at=? WHERE id=?`, res, ctx.user.id, pen, now(), i.id);
  if (pen === 'strike') db.run('UPDATE users SET strikes=strikes+1 WHERE id=?', i.user_id);
  if (pen === 'suspend') db.run(`UPDATE users SET status='suspended' WHERE id=?`, i.user_id);
  log({ actor: ctx.user, action: 'incident_resolved', entity: 'incident', entity_id: i.id, booking_id: i.booking_id, resource_id: i.resource_id, details: { penalty: pen }, reason: res });
  notify(i.user_id, `Incident #${i.id} resolved (${pen === 'none' ? 'no penalty' : pen}). ${res} You can appeal from the booking page.`, `#/booking/${i.booking_id}`);
  return { ok: true };
});
post('/api/incidents/:id/appeal', ctx => {
  const i = db.get('SELECT * FROM incidents WHERE id=?', Number(ctx.params.id)); if (!i) throw new E(404, 'Not found');
  if (i.user_id !== ctx.user.id) throw forbid();
  if (i.status !== 'resolved' || i.appeal) throw new E(409, 'This incident cannot be appealed');
  const t = str(ctx.body.text, 500); if (t.length < 5) throw bad('Explain why you are appealing');
  db.run(`UPDATE incidents SET appeal=?,status='appealed' WHERE id=?`, t, i.id);
  log({ actor: ctx.user, action: 'appeal_filed', entity: 'incident', entity_id: i.id, booking_id: i.booking_id, resource_id: i.resource_id, reason: t });
  db.all("SELECT id FROM users WHERE role='admin'").forEach(a => notify(a.id, `Appeal filed on incident #${i.id}.`, '#/admin'));
  return { ok: true };
});
post('/api/incidents/:id/appeal-decision', ctx => {
  if (ctx.user.role !== 'admin') throw forbid('Only an administrator reviews appeals');
  const i = db.get('SELECT * FROM incidents WHERE id=?', Number(ctx.params.id)); if (!i || i.status !== 'appealed') throw new E(409, 'No open appeal');
  const overturn = ctx.body.decision === 'overturn', note = str(ctx.body.note, 400); if (note.length < 5) throw bad('Write a decision note');
  db.run(`UPDATE incidents SET status='closed',appeal_decision=? WHERE id=?`, (overturn ? 'Overturned: ' : 'Upheld: ') + note, i.id);
  if (overturn && i.penalty === 'strike') db.run('UPDATE users SET strikes=MAX(0,strikes-1) WHERE id=?', i.user_id);
  if (overturn && i.penalty === 'suspend') db.run(`UPDATE users SET status='verified' WHERE id=?`, i.user_id);
  log({ actor: ctx.user, action: overturn ? 'appeal_overturned' : 'appeal_upheld', entity: 'incident', entity_id: i.id, booking_id: i.booking_id, resource_id: i.resource_id, reason: note });
  notify(i.user_id, `Your appeal on incident #${i.id} was ${overturn ? 'accepted - penalty reversed' : 'reviewed and the decision stands'}. ${note}`, `#/booking/${i.booking_id}`);
  return { ok: true };
});

// ----- manager console -----
get('/api/manage/overview', ctx => {
  const u = ctx.user, ids = managedIds(u); if (!ids.length) throw forbid('You do not manage any resources');
  const ph = ids.map(() => '?').join(',');
  const resources = db.all(`SELECT * FROM resources WHERE id IN (${ph}) ORDER BY name`, ...ids).map(r => ({ ...resOut(r, u), is_owner: r.owner_id === u.id || u.role === 'admin' }));
  const bookings = db.all(`SELECT * FROM bookings WHERE resource_id IN (${ph}) AND (status IN ('pending','waitlisted','approved','checked_in','returned') OR (status IN ('completed','rejected','cancelled','no_show') AND start_ts>?)) ORDER BY start_ts`, ...ids, now() - 14 * 864e5).map(b => bookingOut(b, u));
  const incidents = db.all(`SELECT i.*,r.name resource_name FROM incidents i JOIN resources r ON r.id=i.resource_id WHERE i.resource_id IN (${ph}) ORDER BY i.id DESC LIMIT 40`, ...ids).map(i => ({ ...i, user_name: userRow(i.user_id).name }));
  const extensions = db.all(`SELECT x.*,b.resource_id,b.end_ts old_end,b.user_id FROM extensions x JOIN bookings b ON b.id=x.booking_id WHERE x.status='pending' AND b.resource_id IN (${ph})`, ...ids).map(x => ({ ...x, user_name: userRow(x.user_id).name, resource_name: getRes(x.resource_id).name }));
  const certReqs = db.all(`SELECT c.*,r.name resource_name FROM cert_requests c JOIN resources r ON r.id=c.resource_id WHERE c.status='pending' AND c.resource_id IN (${ph})`, ...ids).map(c => ({ ...c, user: requesterView(c.user_id, false) }));
  return { resources, bookings, incidents, extensions, certReqs };
});
post('/api/cert-requests/:id/decide', ctx => {
  const c = db.get('SELECT * FROM cert_requests WHERE id=?', Number(ctx.params.id)); if (!c) throw new E(404, 'Not found');
  if (!canManage(ctx.user, c.resource_id)) throw forbid();
  if (c.status !== 'pending') throw new E(409, 'Already decided');
  const grant = ctx.body.grant === true, note = str(ctx.body.note, 300);
  if (!grant && note.length < 5) throw bad('Give a reason when declining');
  db.run('UPDATE cert_requests SET status=?,decided_by=?,decision_note=? WHERE id=?', grant ? 'granted' : 'declined', ctx.user.id, note, c.id);
  if (grant) db.run('INSERT INTO user_certs(user_id,cert,granted_by,granted_at,expires_at) VALUES(?,?,?,?,?)', c.user_id, c.cert, ctx.user.id, now(), now() + 365 * 864e5);
  log({ actor: ctx.user, action: grant ? 'certification_granted' : 'certification_declined', entity: 'user', entity_id: c.user_id, resource_id: c.resource_id, details: { cert: c.cert }, reason: note });
  notify(c.user_id, `Training request for "${c.cert}" was ${grant ? 'approved - you can now book' : 'declined. ' + note}.`, `#/resource/${c.resource_id}`);
  return { ok: true };
});

// ----- notifications -----
get('/api/notifications', ctx => db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 40', ctx.user.id));
post('/api/notifications/read', ctx => { db.run('UPDATE notifications SET read=1 WHERE user_id=?', ctx.user.id); return { ok: true }; });

// ----- audit -----
get('/api/audit', ctx => {
  if (ctx.user.role !== 'admin') throw forbid('The full audit trail is for administrators. Open a booking to see its own history.');
  return db.all('SELECT id,ts,actor_name,action,entity,entity_id,booking_id,resource_id,details,reason,hash FROM audit ORDER BY id DESC LIMIT 200');
});
get('/api/audit/verify', ctx => { if (ctx.user.role !== 'admin') throw forbid(); return verifyAudit(); });

// ----- admin -----
const admin = ctx => { if (ctx.user.role !== 'admin') throw forbid('Administrators only'); };
get('/api/admin/users', ctx => { admin(ctx); return db.all('SELECT * FROM users ORDER BY id').map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, member_type: u.member_type, org: u.org, id_number: u.id_number ? '***' + u.id_number.slice(-3) : '', status: u.status, strikes: u.strikes })); });
post('/api/admin/users/:id/status', ctx => {
  admin(ctx); const t = userRow(Number(ctx.params.id)); if (!t) throw new E(404, 'Not found');
  const s = ctx.body.status, note = str(ctx.body.note, 200); if (!['verified', 'unverified', 'suspended'].includes(s)) throw bad('Invalid status');
  db.run('UPDATE users SET status=? WHERE id=?', s, t.id);
  log({ actor: ctx.user, action: 'user_status_changed', entity: 'user', entity_id: t.id, details: { from: t.status, to: s }, reason: note });
  notify(t.id, s === 'verified' ? 'Your identity has been verified. You can now request bookings.' : `Your account status is now: ${s}.`, '#/discover');
  return { ok: true };
});
post('/api/admin/users/:id/role', ctx => {
  admin(ctx); const t = userRow(Number(ctx.params.id)); if (!t) throw new E(404, 'Not found');
  const r = ctx.body.role; if (!['user', 'owner', 'manager', 'admin'].includes(r)) throw bad('Invalid role');
  db.run('UPDATE users SET role=? WHERE id=?', r, t.id); log({ actor: ctx.user, action: 'role_changed', entity: 'user', entity_id: t.id, details: { from: t.role, to: r } });
  return { ok: true };
});
get('/api/admin/fairuse', ctx => {
  admin(ctx);
  return db.all("SELECT * FROM users WHERE role IN ('user','manager')").map(u => {
    const h30 = db.get(`SELECT COALESCE(SUM(end_ts-start_ts),0) t FROM bookings WHERE user_id=? AND status IN ('approved','checked_in','returned','completed') AND start_ts>?`, u.id, now() - 30 * 864e5).t / 36e5;
    const n7 = db.get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND created_at>?`, u.id, now() - 7 * 864e5).c;
    const lc = db.get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND late_cancel=1`, u.id).c, ns = db.get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status='no_show'`, u.id).c;
    const late = db.get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND late_minutes>15`, u.id).c, inc = db.get(`SELECT COUNT(*) c FROM incidents WHERE user_id=?`, u.id).c;
    const flags = []; if (h30 >= 30) flags.push(`High usage: ${h30.toFixed(0)} h in 30 days`); if (n7 >= 5) flags.push(`${n7} requests in 7 days`); if (lc >= 2) flags.push(`${lc} late cancellations`); if (ns) flags.push(`${ns} no-show(s)`); if (late >= 2) flags.push(`${late} late returns`); if (u.strikes) flags.push(`${u.strikes} strike(s)`);
    return { id: u.id, name: u.name, member_type: u.member_type, hours_30d: Math.round(h30 * 10) / 10, requests_7d: n7, late_cancels: lc, no_shows: ns, late_returns: late, incidents: inc, strikes: u.strikes, flags };
  }).sort((a, b) => b.flags.length - a.flags.length || b.hours_30d - a.hours_30d);
});
get('/api/admin/stats', ctx => {
  admin(ctx);
  return { users: db.get('SELECT COUNT(*) c FROM users').c, resources: db.get('SELECT COUNT(*) c FROM resources').c, bookings: db.all('SELECT status,COUNT(*) c FROM bookings GROUP BY status'), incidents_open: db.get(`SELECT COUNT(*) c FROM incidents WHERE status IN ('open','appealed')`).c, audit_entries: db.get('SELECT COUNT(*) c FROM audit').c,
    appeals: db.all(`SELECT i.id,i.appeal,i.resolution,i.penalty,u.name user_name FROM incidents i JOIN users u ON u.id=i.user_id WHERE i.status='appealed'`) };
});
post('/api/admin/reset-demo', ctx => { admin(ctx); if (!DEMO) throw forbid('Reset is disabled outside demo mode'); reset(); seed(); return { ok: true }; });

// ================= HTTP server =================
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" };

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (!url.pathname.startsWith('/api/')) {
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let f = path.join(PUB, p === '/' || p === '\\' ? 'index.html' : p);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    return send(200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on('end', () => {
    try {
      sweep();
      const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(404, { error: 'Not found' });
      const m = url.pathname.match(r.re), params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const ctx = { params, query: Object.fromEntries(url.searchParams), body: {}, ip: req.socket.remoteAddress };
      if (raw) { try { ctx.body = JSON.parse(raw); } catch { return send(400, { error: 'Invalid JSON' }); } }
      if (r.auth) {
        const t = (req.headers.authorization || '').replace('Bearer ', ''), s = t && db.get('SELECT * FROM sessions WHERE token=?', t);
        if (!s || now() - s.created > 7 * 864e5) return send(401, { error: 'Please sign in' });
        ctx.user = userRow(s.user_id); ctx.token = t;
      } else ctx.token = null;
      const out = r.fn(ctx);
      send(200, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (e instanceof E) return send(e.status, { error: e.message, ...(e.extra || {}) });
      console.error(e); send(500, { error: 'Something went wrong on the server' });
    }
  });
}

if (!db.get('SELECT id FROM users LIMIT 1')) { seed(); console.log('Seeded demo data'); }
sweep(); setInterval(sweep, 30000).unref();
if (require.main === module) http.createServer(handle).listen(PORT, () => console.log(`OpenBench running on http://localhost:${PORT}  (demo mode: ${DEMO})`));
module.exports = { handle };
