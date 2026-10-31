'use strict';
const U = require('./util');
const { all, get, run, tx } = require('./db');

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const fail = (s, m, x) => { throw new HttpError(s, m, x); };
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const DEMO = process.env.DEMO_MODE !== 'false'; // relaxes early check-in so judges can finish a journey in minutes
const ACTIVE = ['pending', 'waitlisted', 'approved', 'checked_in'];
const HOLDING = ['approved', 'checked_in']; // statuses that physically block a slot
const COND_RANK = { good: 3, fair: 2, poor: 1 };
const PURPOSE_BONUS = { coursework: 10, research: 8, project: 5, community: 5, personal: 0 };

/* ---------------- audit (hash-chained, tamper-evident) ---------------- */
function audit(actor, action, summary, o = {}) {
  const last = get('SELECT hash FROM audit ORDER BY id DESC LIMIT 1');
  const prev = last ? last.hash : 'GENESIS';
  const ts = U.now();
  const details = JSON.stringify(o.details || {});
  const body = [prev, ts, actor?.id ?? '', action, o.booking_id ?? '', o.resource_id ?? '', summary, details].join('|');
  run(`INSERT INTO audit(ts,actor_id,actor_name,actor_role,action,booking_id,resource_id,target_user_id,summary,details,prev_hash,hash)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, ts, actor?.id ?? null, actor?.name ?? 'System', actor?.role ?? 'system', action,
  o.booking_id ?? null, o.resource_id ?? null, o.target_user_id ?? null, summary, details, prev, U.sha256(body));
}
function verifyAuditChain() {
  let prev = 'GENESIS'; const rows = all('SELECT * FROM audit ORDER BY id');
  for (const r of rows) {
    const body = [prev, r.ts, r.actor_id ?? '', r.action, r.booking_id ?? '', r.resource_id ?? '', r.summary, r.details].join('|');
    if (r.prev_hash !== prev || U.sha256(body) !== r.hash) return { ok: false, broken_at: r.id, total: rows.length };
    prev = r.hash;
  }
  return { ok: true, total: rows.length, head: prev.slice(0, 16) };
}
function notify(userId, message, link = '') { if (userId) run('INSERT INTO notifications(user_id,message,link,created_at) VALUES(?,?,?,?)', userId, message, link, U.now()); }

/* ---------------- permissions ---------------- */
const managerIds = (res) => [res.owner_id, ...all('SELECT user_id FROM managers WHERE resource_id=?', res.id).map((m) => m.user_id)];
const canManage = (user, res) => !!user && (user.role === 'admin' || managerIds(res).includes(user.id));
const getRes = (id) => get('SELECT * FROM resources WHERE id=?', id) || fail(404, 'Resource not found');
const getBooking = (id) => get('SELECT * FROM bookings WHERE id=?', id) || fail(404, 'Booking not found');
const getUser = (id) => get('SELECT * FROM users WHERE id=?', id);
const notifyManagers = (res, msg, link, exceptId) => managerIds(res).filter((i) => i !== exceptId).forEach((i) => notify(i, msg, link));

/* ---------------- eligibility ---------------- */
function evaluateEligibility(user, res) {
  const items = [];
  const t = U.now();
  items.push(user.suspended ? { key: 'account', label: 'Account in good standing', status: 'fail', detail: 'Your account is suspended. Contact an administrator.' }
    : user.strikes >= 3 ? { key: 'account', label: 'Account in good standing', status: 'fail', detail: `${user.strikes} confirmed incident strikes. Access is paused until an administrator reviews your account.` }
      : { key: 'account', label: 'Account in good standing', status: 'ok', detail: user.strikes ? `${user.strikes} strike(s) on record (priority reduced).` : 'No strikes.' });
  const types = J(res.allowed_types, []);
  if (types.length) items.push(types.includes(user.user_type)
    ? { key: 'type', label: `Open to: ${types.join(', ')}`, status: 'ok', detail: `You are registered as ${user.user_type}.` }
    : { key: 'type', label: `Open to: ${types.join(', ')}`, status: 'fail', detail: `Your profile type is "${user.user_type}". This resource is limited to ${types.join(', ')}.` });
  for (const name of J(res.requires, [])) {
    const creds = all('SELECT * FROM credentials WHERE user_id=? AND name=? ORDER BY id DESC', user.id, name);
    const ok = creds.find((c) => c.status === 'verified' && (!c.expires_at || c.expires_at > t));
    const pend = creds.find((c) => c.status === 'pending');
    const expired = creds.find((c) => c.status === 'verified' && c.expires_at && c.expires_at <= t);
    if (ok) items.push({ key: 'cred', credential: name, label: name, status: 'ok', detail: 'Verified.' });
    else if (pend) items.push({ key: 'cred', credential: name, label: name, status: 'pending', detail: 'Submitted and awaiting verification. You may request now; approval waits for verification.' });
    else items.push({ key: 'cred', credential: name, label: name, status: 'fail', detail: expired ? 'Your verification has expired. Submit it again.' : creds[0]?.status === 'rejected' ? `Rejected: ${creds[0].decision_note || 'see notes'}. Submit again.` : 'Not submitted yet. Add this credential to continue.' });
  }
  if (res.deposit > 0) items.push(user.credits >= res.deposit
    ? { key: 'deposit', label: `Refundable deposit: ${res.deposit} credits`, status: 'ok', detail: `You have ${user.credits} credits. Deposit is held on approval and released after a clean return.` }
    : { key: 'deposit', label: `Refundable deposit: ${res.deposit} credits`, status: 'fail', detail: `You have ${user.credits} credits; ${res.deposit} needed.` });
  if (res.supervised) items.push({ key: 'sup', label: 'Staff supervision required', status: 'info', detail: 'A staff member will supervise your session on site.' });
  return { items, can_request: !items.some((i) => i.status === 'fail'), awaiting_verification: items.some((i) => i.status === 'pending') };
}

/* ---------------- fairness (explainable) ---------------- */
function fairness(user, res, createdAt, purposeType) {
  const t = U.now();
  const used = all(`SELECT b.start_ts,b.end_ts FROM bookings b JOIN resources r ON r.id=b.resource_id
    WHERE b.user_id=? AND r.category=? AND b.status IN ('approved','checked_in','returned') AND b.start_ts>=?`, user.id, res.category, t - 30 * 86400000);
  const usedH = used.reduce((s, b) => s + U.hours(b.start_ts, b.end_ts), 0);
  const ns = get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status='no_show' AND start_ts>=?`, user.id, t - 30 * 86400000).c;
  const prior = get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND resource_id=? AND status IN ('approved','checked_in','returned')`, user.id, res.id).c;
  const waited = Math.max(0, (t - createdAt) / 3600000);
  const b = [{ label: 'Base priority', points: 50, why: 'Everyone starts equal.' }];
  const usePts = -Math.min(30, Math.round(usedH * 2));
  b.push({ label: 'Recent usage', points: usePts, why: `${usedH.toFixed(1)} h used in "${res.category}" over the last 30 days (-2 per hour, max -30).` });
  b.push({ label: 'Waiting time', points: Math.min(20, Math.floor(waited)), why: `Request has waited ${waited.toFixed(1)} h (+1 per hour, max +20).` });
  b.push({ label: 'Purpose', points: PURPOSE_BONUS[purposeType] ?? 0, why: `Purpose "${purposeType}" (coursework +10, research +8, project/community +5).` });
  b.push({ label: 'First-time user', points: prior === 0 ? 10 : 0, why: prior === 0 ? 'Has not used this resource before (+10).' : 'Has used this resource before.' });
  b.push({ label: 'Recent no-shows', points: -Math.min(15, ns * 5), why: `${ns} no-show(s) in last 30 days (-5 each, max -15).` });
  b.push({ label: 'Confirmed strikes', points: -10 * user.strikes, why: `${user.strikes} strike(s) confirmed by an owner (-10 each).` });
  return { score: b.reduce((s, x) => s + x.points, 0), breakdown: b };
}

/* ---------------- slot validation ---------------- */
function parseSlot(res, startLocal, durationH) {
  const s = U.localToUtc(startLocal);
  const d = Number(durationH);
  if (s == null) fail(400, 'Choose a valid start date and time.');
  if (!(d > 0) || (d * 2) % 1 !== 0) fail(400, 'Duration must be in 30-minute steps.');
  return { start: s, end: s + d * 3600000, dur: d };
}
function slotChecks(user, res, start, end, dur, excludeId = 0) {
  const errors = []; const t = U.now();
  if (res.status !== 'active') errors.push('This listing is currently paused by its owner.');
  if (start < t - 5 * 60000) errors.push('Start time is in the past.');
  if (start > t + 60 * 86400000) errors.push('You can book at most 60 days ahead.');
  if (dur > res.max_hours) errors.push(`Maximum ${res.max_hours} h per booking for this resource.`);
  const sp = U.localParts(start), ep = U.localParts(end - 1);
  const days = J(res.open_days, [1, 2, 3, 4, 5]);
  if (!days.includes(sp.dow)) errors.push('Resource is closed on that day.');
  if (sp.date !== ep.date || sp.minutes < U.hhmmToMin(res.open_start) || (ep.minutes + 1) > U.hhmmToMin(res.open_end))
    errors.push(`Bookings must fit inside opening hours (${res.open_start}-${res.open_end}, campus time).`);
  const mine = all(`SELECT * FROM bookings WHERE user_id=? AND status IN ('pending','approved','checked_in','waitlisted') AND id<>?`, user.id, excludeId);
  const clash = mine.find((b) => U.overlaps(start, end, b.start_ts, b.end_ts));
  if (clash) errors.push(`You already have booking #${clash.id} overlapping this time.`);
  const q = quota(user, res, start, excludeId);
  if (q.week_used + dur > res.weekly_cap) errors.push(`Fair-use limit: ${res.weekly_cap} h per week per person on this resource (you have ${q.week_used} h booked that week).`);
  if (q.active >= res.max_active && !excludeId) errors.push(`Fair-use limit: at most ${res.max_active} upcoming bookings at once on this resource.`);
  return errors;
}
function quota(user, res, start, excludeId = 0) {
  const wk = U.localParts(start).weekKey;
  const rows = all(`SELECT * FROM bookings WHERE user_id=? AND resource_id=? AND status IN ('pending','approved','checked_in','returned') AND id<>?`, user.id, res.id, excludeId);
  const week_used = rows.filter((b) => U.localParts(b.start_ts).weekKey === wk).reduce((s, b) => s + U.hours(b.start_ts, b.end_ts), 0);
  const active = get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND resource_id=? AND status IN ('pending','waitlisted','approved','checked_in') AND end_ts>? AND id<>?`, user.id, res.id, U.now(), excludeId).c;
  return { week_used, week_cap: res.weekly_cap, active, max_active: res.max_active };
}
const heldOverlaps = (resId, s, e, excludeId = 0) => all(`SELECT * FROM bookings WHERE resource_id=? AND status IN ('approved','checked_in') AND id<>? AND start_ts<? AND end_ts>?`, resId, excludeId, e, s);
const pendingOverlaps = (resId, s, e, excludeId = 0) => all(`SELECT * FROM bookings WHERE resource_id=? AND status='pending' AND id<>? AND start_ts<? AND end_ts>?`, resId, excludeId, e, s);

function previewBooking(user, res, body) {
  const { start, end, dur } = parseSlot(res, body.start_local, body.duration);
  const purposeType = PURPOSE_BONUS[body.purpose_type] !== undefined ? body.purpose_type : 'personal';
  const elig = evaluateEligibility(user, res);
  const errors = slotChecks(user, res, start, end, dur);
  if (!elig.can_request) errors.unshift('You do not meet all requirements yet (see checklist).');
  const held = heldOverlaps(res.id, start, end);
  const competing = pendingOverlaps(res.id, start, end);
  const f = fairness(user, res, U.now(), purposeType);
  const predicted = held.length ? 'waitlisted' : 'pending';
  const waitlistPos = held.length ? 1 + all(`SELECT * FROM bookings WHERE resource_id=? AND status='waitlisted' AND start_ts<? AND end_ts>?`, res.id, end, start).length : null;
  return { start, end, dur, purposeType, eligibility: elig, errors, predicted, held_by_other: held.length > 0, competing_requests: competing.length, waitlist_position: waitlistPos, fairness: f, quota: quota(user, res, start) };
}

/* ---------------- booking lifecycle ---------------- */
function createBooking(user, res, body) {
  return tx(() => {
    const p = previewBooking(user, res, body);
    if (p.errors.length) fail(422, p.errors[0], { errors: p.errors });
    const purpose = U.clean(body.purpose, 400);
    if (purpose.length < 10) fail(422, 'Please describe your purpose (at least 10 characters) so the owner can review it.');
    if (!body.ack_rules) fail(422, 'You must accept the usage rules.');
    const status = p.predicted;
    const reason = status === 'waitlisted' ? 'Automatically waitlisted: this time is already approved for another user. You will be promoted for owner review if it becomes free.' : 'Awaiting owner review.';
    const r = run(`INSERT INTO bookings(resource_id,user_id,start_ts,end_ts,purpose_type,purpose,status,awaiting_verification,decision_reason,score_snapshot,eligibility_snapshot,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, res.id, user.id, p.start, p.end, p.purposeType, purpose, status, p.eligibility.awaiting_verification ? 1 : 0, reason,
    JSON.stringify(p.fairness), JSON.stringify(p.eligibility.items), U.now());
    const id = Number(r.lastInsertRowid);
    audit(user, 'booking.requested', `${user.name} requested ${res.name} (${fmt(p.start)} - ${fmt(p.end)})`, { booking_id: id, resource_id: res.id, details: { status, fairness_score: p.fairness.score, awaiting_verification: p.eligibility.awaiting_verification } });
    if (status === 'waitlisted') audit(null, 'booking.waitlisted', `Auto-waitlisted: slot already approved for another user`, { booking_id: id, resource_id: res.id });
    notifyManagers(res, `New ${status === 'waitlisted' ? 'waitlisted ' : ''}request for ${res.name} from ${user.name}`, `#/owner`);
    notify(user.id, status === 'waitlisted' ? `Your request for ${res.name} is on the waiting list.` : `Request for ${res.name} submitted. The owner will review it.`, `#/booking/${id}`);
    return id;
  });
}

function rankCompetitors(b, res) {
  const rows = [b, ...pendingOverlaps(res.id, b.start_ts, b.end_ts, b.id)];
  return rows.map((x) => { const u = getUser(x.user_id); return { id: x.id, user: u.name, ...fairness(u, res, x.created_at, x.purpose_type) }; }).sort((a, c) => c.score - a.score || a.id - c.id);
}

function approve(actor, id, body) {
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    if (!canManage(actor, res)) fail(403, 'Only the owner or an authorised manager can decide.');
    if (b.status !== 'pending') fail(409, `Only pending requests can be approved (this one is ${b.status}).`);
    const user = getUser(b.user_id);
    const elig = evaluateEligibility(user, res);
    if (!elig.can_request) fail(409, 'Requester no longer meets the requirements.', { items: elig.items });
    if (elig.awaiting_verification) fail(409, 'A required credential is still awaiting verification. Verify it first (Owner > Verification queue).');
    if (heldOverlaps(res.id, b.start_ts, b.end_ts, b.id).length) fail(409, 'That time slot was just approved for someone else.');
    const ranking = rankCompetitors(b, res);
    const top = ranking[0];
    const override = U.clean(body.override_reason, 300);
    if (top.id !== b.id && override.length < 8) fail(409, `A higher-priority request exists (#${top.id}, score ${top.score}). To approve this one instead, provide a reason (it is recorded in the audit trail).`, { requires_override: true, ranking });
    if (user.credits < res.deposit) fail(409, 'Requester does not have enough credits for the deposit.');
    const note = U.clean(body.note, 300);
    const reason = `Approved by ${actor.name}${note ? ': ' + note : ''}.${top.id !== b.id ? ' Override of fairness ranking: ' + override : ' Highest fairness score among competing requests.'}`;
    run(`UPDATE bookings SET status='approved',decision_reason=?,decided_by=?,decided_at=?,override_reason=?,awaiting_verification=0,deposit_held=?,deposit_status=? WHERE id=?`,
      reason, actor.id, U.now(), top.id !== b.id ? override : '', res.deposit, res.deposit ? 'held' : 'none', id);
    if (res.deposit) run('UPDATE users SET credits=credits-? WHERE id=?', res.deposit, user.id);
    audit(actor, 'booking.approved', `${actor.name} approved booking #${id}`, { booking_id: id, resource_id: res.id, target_user_id: user.id, details: { note, override: top.id !== b.id ? override : null, ranking } });
    notify(user.id, `Approved: ${res.name}, ${fmt(b.start_ts)}. ${res.supervised ? 'Staff will supervise.' : ''}`, `#/booking/${id}`);
    // competing pending requests for the same time are moved to the waiting list, with a reason
    for (const c of pendingOverlaps(res.id, b.start_ts, b.end_ts, id)) {
      run(`UPDATE bookings SET status='waitlisted',decision_reason=? WHERE id=?`, `Another request (#${id}) was approved for this time after owner review. You are on the waiting list and will be re-reviewed if it is cancelled.`, c.id);
      audit(actor, 'booking.waitlisted', `Booking #${c.id} moved to waiting list because #${id} was approved`, { booking_id: c.id, resource_id: res.id, target_user_id: c.user_id });
      notify(c.user_id, `Your request for ${res.name} was waitlisted: the slot went to another request. Reasons are in your booking.`, `#/booking/${c.id}`);
    }
  });
}

function decideSimple(actor, id, body, kind) { // reject | waitlist
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    if (!canManage(actor, res)) fail(403, 'Only the owner or an authorised manager can decide.');
    if (!['pending', 'waitlisted'].includes(b.status)) fail(409, `Cannot ${kind} a ${b.status} booking.`);
    const reason = U.clean(body.reason, 300);
    if (reason.length < 5) fail(422, 'A reason is required so the requester understands the decision.');
    const status = kind === 'reject' ? 'rejected' : 'waitlisted';
    run('UPDATE bookings SET status=?,decision_reason=?,decided_by=?,decided_at=? WHERE id=?', status, `${kind === 'reject' ? 'Rejected' : 'Waitlisted'} by ${actor.name}: ${reason}`, actor.id, U.now(), id);
    audit(actor, `booking.${status}`, `${actor.name} ${status} booking #${id}`, { booking_id: id, resource_id: res.id, target_user_id: b.user_id, details: { reason } });
    notify(b.user_id, `Your request for ${res.name} was ${status}: ${reason}`, `#/booking/${id}`);
  });
}

function releaseDeposit(b) {
  if (b.deposit_status === 'held') { run('UPDATE users SET credits=credits+? WHERE id=?', b.deposit_held, b.user_id); run(`UPDATE bookings SET deposit_status='released' WHERE id=?`, b.id); }
}

function cancel(actor, id, body) {
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    const mine = b.user_id === actor.id, mgr = canManage(actor, res);
    if (!mine && !mgr) fail(403, 'Not allowed.');
    if (!['pending', 'waitlisted', 'approved'].includes(b.status)) fail(409, `A ${b.status} booking cannot be cancelled.`);
    const reason = U.clean(body.reason, 300);
    if (!mine && reason.length < 5) fail(422, 'Managers must give a reason when cancelling someone else’s booking.');
    const late = b.status === 'approved' && b.start_ts - U.now() < 2 * 3600000 ? 1 : 0;
    run(`UPDATE bookings SET status='cancelled',cancelled_by=?,cancel_reason=?,late_cancel=?,decision_reason=? WHERE id=?`, actor.id, reason, late, `Cancelled by ${actor.name}${reason ? ': ' + reason : ''}${late ? ' (late cancellation, under 2 h notice)' : ''}`, id);
    releaseDeposit(getBooking(id));
    audit(actor, 'booking.cancelled', `${actor.name} cancelled booking #${id}${late ? ' (late)' : ''}`, { booking_id: id, resource_id: res.id, target_user_id: b.user_id, details: { reason, late } });
    if (!mine) notify(b.user_id, `Your booking for ${res.name} was cancelled by ${actor.name}: ${reason}`, `#/booking/${id}`);
    else notifyManagers(res, `${actor.name} cancelled their booking for ${res.name} (${fmt(b.start_ts)})`, '#/owner', actor.id);
    if (b.status === 'approved') promoteWaitlist(res, actor);
  });
}

function promoteWaitlist(res, actor) {
  const wl = all(`SELECT * FROM bookings WHERE resource_id=? AND status='waitlisted' AND start_ts>?`, res.id, U.now());
  const ranked = wl.map((b) => ({ b, f: fairness(getUser(b.user_id), res, b.created_at, b.purpose_type) })).sort((a, c) => c.f.score - a.f.score || a.b.id - c.b.id);
  const taken = [];
  for (const { b, f } of ranked) {
    if (heldOverlaps(res.id, b.start_ts, b.end_ts).length) continue;
    if (taken.some((t) => U.overlaps(b.start_ts, b.end_ts, t.start_ts, t.end_ts))) continue;
    run(`UPDATE bookings SET status='pending',decision_reason=? WHERE id=?`, `Promoted from the waiting list (fairness score ${f.score}). Awaiting owner review.`, b.id);
    audit(actor, 'booking.promoted', `Booking #${b.id} promoted from waiting list (score ${f.score})`, { booking_id: b.id, resource_id: res.id, target_user_id: b.user_id, details: f });
    notify(b.user_id, `Good news: ${res.name} is free again. Your waitlisted request is now with the owner for review.`, `#/booking/${b.id}`);
    notifyManagers(res, `Waitlisted request #${b.id} promoted for ${res.name}; please review.`, '#/owner');
    taken.push(b);
  }
}

function checkin(actor, id, body) {
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    if (b.user_id !== actor.id) fail(403, 'Only the booking holder can check in.');
    if (b.status !== 'approved') fail(409, 'Only approved bookings can be checked in.');
    const t = U.now();
    if (t > b.end_ts) fail(409, 'This booking window has ended.');
    if (!DEMO && t < b.start_ts - 15 * 60000) fail(409, 'Check-in opens 15 minutes before your start time.');
    if (!body.ack_rules) fail(422, 'Please confirm you have read the usage rules.');
    const cond = body.condition;
    if (!COND_RANK[cond]) fail(422, 'Record the condition of the resource (good, fair or poor).');
    const checklist = body.checklist || {};
    const items = J(res.checklist, []);
    run(`UPDATE bookings SET status='checked_in',checkin_ts=?,checkin_condition=?,checkin_notes=?,checkin_checklist=? WHERE id=?`, t, cond, U.clean(body.notes, 400), JSON.stringify(Object.fromEntries(items.map((i) => [i, !!checklist[i]]))), id);
    audit(actor, 'booking.checked_in', `${actor.name} checked in to ${res.name} (condition: ${cond})`, { booking_id: id, resource_id: res.id, details: { condition: cond, notes: U.clean(body.notes, 400), checklist, early: t < b.start_ts } });
    if (cond === 'poor' || items.some((i) => !checklist[i])) {
      run(`INSERT INTO incidents(booking_id,resource_id,reporter_id,type,severity,description,status,auto_flagged,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        id, res.id, actor.id, 'pre_existing', 'minor', `Issue recorded at check-in (condition ${cond}). Missing/failed checklist items: ${items.filter((i) => !checklist[i]).join(', ') || 'none'}. ${U.clean(body.notes, 300)}`, 'open', 1, t);
      audit(null, 'incident.auto_flagged', 'Pre-existing condition issue recorded at check-in (protects the user from blame)', { booking_id: id, resource_id: res.id });
      notifyManagers(res, `${actor.name} reported a pre-existing issue on ${res.name} at check-in.`, '#/owner');
    }
    notifyManagers(res, `${actor.name} checked in to ${res.name}.`, '#/owner', actor.id);
  });
}

function doReturn(actor, id, body) {
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    if (b.user_id !== actor.id) fail(403, 'Only the booking holder can return it.');
    if (b.status !== 'checked_in') fail(409, 'Only checked-in bookings can be returned.');
    const cond = body.condition;
    if (!COND_RANK[cond]) fail(422, 'Record the condition on return (good, fair or poor).');
    const t = U.now();
    const items = J(res.checklist, []); const checklist = body.checklist || {};
    const before = J(b.checkin_checklist, {});
    const lost = items.filter((i) => before[i] && !checklist[i]);
    const worse = COND_RANK[cond] < COND_RANK[b.checkin_condition];
    const late = Math.max(0, Math.floor((t - b.end_ts) / 60000));
    const lateFlag = late > 10 ? late : 0;
    if (cond !== 'good' && !U.clean(body.notes, 400)) fail(422, 'Please describe the condition in the notes.');
    run(`UPDATE bookings SET status='returned',return_ts=?,return_condition=?,return_notes=?,return_checklist=?,late_minutes=? WHERE id=?`, t, cond, U.clean(body.notes, 400), JSON.stringify(Object.fromEntries(items.map((i) => [i, !!checklist[i]]))), lateFlag, id);
    audit(actor, 'booking.returned', `${actor.name} returned ${res.name} (condition: ${cond}${lateFlag ? `, ${lateFlag} min late` : ''})`, { booking_id: id, resource_id: res.id, details: { condition: cond, notes: U.clean(body.notes, 400), checklist, late_minutes: lateFlag } });
    if (worse || body.damage || lost.length) {
      run(`INSERT INTO incidents(booking_id,resource_id,reporter_id,type,severity,description,status,auto_flagged,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        id, res.id, actor.id, 'damage', cond === 'poor' ? 'major' : 'minor', `Condition changed ${b.checkin_condition} -> ${cond}.${lost.length ? ' Checklist items no longer present: ' + lost.join(', ') + '.' : ''}${body.damage ? ' User reported damage.' : ''} ${U.clean(body.notes, 300)}`, 'open', 1, t);
      audit(null, 'incident.auto_flagged', `Possible damage flagged for review on booking #${id} (condition worsened or items missing). No penalty is applied automatically.`, { booking_id: id, resource_id: res.id });
    }
    if (lateFlag && !get(`SELECT id FROM incidents WHERE booking_id=? AND type='delay'`, id)) {
      run(`INSERT INTO incidents(booking_id,resource_id,reporter_id,type,severity,description,status,auto_flagged,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, res.id, null, 'delay', 'minor', `Returned ${lateFlag} minutes after the booked end time.`, 'open', 1, t);
      audit(null, 'incident.auto_flagged', `Late return of ${lateFlag} min recorded on booking #${id}`, { booking_id: id, resource_id: res.id });
    }
    notifyManagers(res, `${actor.name} returned ${res.name}. Please confirm the return and condition.`, '#/owner');
    notify(actor.id, `Return recorded for ${res.name}. Waiting for the owner to confirm.`, `#/booking/${id}`);
  });
}

const blockingIncidents = (bid) => get(`SELECT COUNT(*) c FROM incidents WHERE booking_id=? AND status='open' AND type<>'pre_existing'`, bid).c;

function confirmReturn(actor, id, body) {
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    if (!canManage(actor, res)) fail(403, 'Only the owner or an authorised manager can confirm returns.');
    if (b.status !== 'returned' || b.confirmed_ts) fail(409, 'Nothing to confirm for this booking.');
    const fc = COND_RANK[body.final_condition] ? body.final_condition : b.return_condition;
    run('UPDATE bookings SET confirmed_by=?,confirmed_ts=?,confirm_notes=?,final_condition=? WHERE id=?', actor.id, U.now(), U.clean(body.notes, 400), fc, id);
    let dep = 'No deposit held.';
    if (b.deposit_status === 'held') {
      if (blockingIncidents(id)) dep = 'Deposit kept on hold until the open incident is resolved.';
      else { releaseDeposit(getBooking(id)); dep = `${b.deposit_held} credits released to the user.`; }
    }
    audit(actor, 'booking.return_confirmed', `${actor.name} confirmed return of booking #${id} (final condition: ${fc}). ${dep}`, { booking_id: id, resource_id: res.id, target_user_id: b.user_id, details: { notes: U.clean(body.notes, 400) } });
    notify(b.user_id, `Return confirmed for ${res.name}. ${dep}`, `#/booking/${id}`);
  });
}

function requestExtension(actor, id, body) {
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    if (b.user_id !== actor.id) fail(403, 'Only the booking holder can request an extension.');
    if (!['approved', 'checked_in'].includes(b.status)) fail(409, 'Only approved or active bookings can be extended.');
    if (b.ext_status === 'pending') fail(409, 'An extension request is already pending.');
    const add = Number(body.add_hours);
    if (!(add >= 0.5 && add <= 4 && (add * 2) % 1 === 0)) fail(422, 'Extend by 0.5 to 4 hours.');
    const newEnd = b.end_ts + add * 3600000;
    const errs = slotChecks(actor, res, b.start_ts, newEnd, U.hours(b.start_ts, newEnd), id).filter((e) => !e.startsWith('Start time is in the past') && !e.startsWith('Maximum'));
    if (heldOverlaps(res.id, b.start_ts, newEnd, id).length) errs.unshift('Someone else is booked right after you, so this cannot be extended.');
    if (errs.length) fail(422, errs[0], { errors: errs });
    const reason = U.clean(body.reason, 300);
    if (reason.length < 5) fail(422, 'Give a short reason for the extension.');
    run(`UPDATE bookings SET ext_end_ts=?,ext_status='pending',ext_reason=? WHERE id=?`, newEnd, reason, id);
    audit(actor, 'booking.extension_requested', `${actor.name} requested +${add} h on booking #${id}`, { booking_id: id, resource_id: res.id, details: { add_hours: add, reason } });
    notifyManagers(res, `${actor.name} requests a ${add} h extension on ${res.name}.`, '#/owner');
  });
}
function decideExtension(actor, id, body) {
  return tx(() => {
    const b = getBooking(id), res = getRes(b.resource_id);
    if (!canManage(actor, res)) fail(403, 'Not allowed.');
    if (b.ext_status !== 'pending') fail(409, 'No pending extension.');
    const ok = !!body.approve; const reason = U.clean(body.reason, 300);
    if (!ok && reason.length < 5) fail(422, 'Give a reason when declining.');
    if (ok && heldOverlaps(res.id, b.start_ts, b.ext_end_ts, id).length) fail(409, 'Another booking now overlaps the extension.');
    if (ok) run(`UPDATE bookings SET end_ts=ext_end_ts,ext_status='approved',overdue_flag=0 WHERE id=?`, id);
    else run(`UPDATE bookings SET ext_status='declined' WHERE id=?`, id);
    audit(actor, ok ? 'booking.extension_approved' : 'booking.extension_declined', `${actor.name} ${ok ? 'approved' : 'declined'} the extension on booking #${id}`, { booking_id: id, resource_id: res.id, target_user_id: b.user_id, details: { reason } });
    notify(b.user_id, `Your extension on ${res.name} was ${ok ? 'approved' : 'declined: ' + reason}.`, `#/booking/${id}`);
  });
}

/* ---------------- incidents ---------------- */
function reportIncident(actor, body) {
  return tx(() => {
    const b = getBooking(Number(body.booking_id)), res = getRes(b.resource_id);
    if (b.user_id !== actor.id && !canManage(actor, res)) fail(403, 'Not allowed.');
    const type = ['damage', 'delay', 'conflict', 'misuse', 'safety', 'other'].includes(body.type) ? body.type : 'other';
    const desc = U.clean(body.description, 800);
    if (desc.length < 10) fail(422, 'Please describe what happened (at least 10 characters).');
    const sev = ['minor', 'major', 'critical'].includes(body.severity) ? body.severity : 'minor';
    const r = run(`INSERT INTO incidents(booking_id,resource_id,reporter_id,type,severity,description,created_at) VALUES(?,?,?,?,?,?,?)`, b.id, res.id, actor.id, type, sev, desc, U.now());
    audit(actor, 'incident.reported', `${actor.name} reported a ${sev} ${type} incident on booking #${b.id}`, { booking_id: b.id, resource_id: res.id, details: { type, sev, desc } });
    if (b.user_id === actor.id) notifyManagers(res, `Incident reported on ${res.name} by ${actor.name}: ${type}`, '#/owner');
    else notify(b.user_id, `An incident (${type}) was recorded on your booking for ${res.name}. You can see it in the booking history.`, `#/booking/${b.id}`);
    return Number(r.lastInsertRowid);
  });
}
function resolveIncident(actor, id, body) {
  return tx(() => {
    const inc = get('SELECT * FROM incidents WHERE id=?', id) || fail(404, 'Incident not found');
    const res = getRes(inc.resource_id), b = getBooking(inc.booking_id);
    if (!canManage(actor, res)) fail(403, 'Only the owner, manager or admin can resolve incidents.');
    if (inc.status !== 'open') fail(409, 'Already resolved.');
    const outcome = ['dismiss', 'warning', 'strike', 'forfeit', 'strike_forfeit'].includes(body.outcome) ? body.outcome : null;
    if (!outcome) fail(422, 'Choose an outcome.');
    const note = U.clean(body.resolution, 400);
    if (note.length < 8) fail(422, 'Write a short explanation; the user will see it.');
    run(`UPDATE incidents SET status='resolved',outcome=?,resolution=?,resolved_by=?,resolved_at=? WHERE id=?`, outcome, note, actor.id, U.now(), id);
    const u = getUser(b.user_id);
    if (outcome.includes('strike')) {
      run('UPDATE users SET strikes=strikes+1 WHERE id=?', u.id);
      if (u.strikes + 1 >= 3) all(`SELECT id FROM users WHERE role='admin'`).forEach((a) => notify(a.id, `${u.name} reached ${u.strikes + 1} strikes. Please review the account.`, '#/admin'));
    }
    const bk = getBooking(b.id);
    if (bk.deposit_status === 'held' && bk.confirmed_ts) {
      if (outcome.includes('forfeit')) run(`UPDATE bookings SET deposit_status='forfeited' WHERE id=?`, b.id);
      else if (!blockingIncidents(b.id)) releaseDeposit(bk);
    } else if (bk.deposit_status === 'held' && outcome.includes('forfeit') && bk.status === 'returned') run(`UPDATE bookings SET deposit_status='forfeited' WHERE id=?`, b.id);
    audit(actor, 'incident.resolved', `${actor.name} resolved incident #${id} with outcome "${outcome}"`, { booking_id: b.id, resource_id: res.id, target_user_id: u.id, details: { outcome, note } });
    notify(u.id, `Incident #${id} on your booking was resolved (${outcome.replace('_', ' + ')}): ${note}`, `#/booking/${b.id}`);
  });
}

/* ---------------- credentials ---------------- */
function submitCredential(user, body) {
  const name = U.clean(body.name, 100), evidence = U.clean(body.evidence, 300);
  if (!name) fail(422, 'Choose a credential.');
  if (evidence.length < 4) fail(422, 'Add a certificate number, training date or link so a human can verify it.');
  const known = new Set(all('SELECT requires FROM resources').flatMap((r) => J(r.requires, [])));
  if (!known.has(name)) fail(422, 'Unknown credential.');
  if (get(`SELECT id FROM credentials WHERE user_id=? AND name=? AND status='pending'`, user.id, name)) fail(409, 'You already have a pending submission for this credential.');
  const r = run('INSERT INTO credentials(user_id,name,evidence,created_at) VALUES(?,?,?,?)', user.id, name, evidence, U.now());
  audit(user, 'credential.submitted', `${user.name} submitted "${name}" for verification`, { target_user_id: user.id });
  for (const res of all('SELECT * FROM resources WHERE status=?', 'active')) if (J(res.requires, []).includes(name)) notifyManagers(res, `${user.name} submitted "${name}" for verification.`, '#/owner');
  return Number(r.lastInsertRowid);
}
function credentialsToReview(user) {
  const rows = all(`SELECT c.*, u.name user_name, u.user_type, u.org FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.status='pending' ORDER BY c.id`);
  const resList = user.role === 'admin' ? all('SELECT * FROM resources') : all('SELECT r.* FROM resources r WHERE r.owner_id=? OR r.id IN (SELECT resource_id FROM managers WHERE user_id=?)', user.id, user.id);
  const names = new Set(resList.flatMap((r) => J(r.requires, [])));
  return rows.filter((c) => names.has(c.name)).map((c) => {
    const dup = get(`SELECT u.name FROM credentials d JOIN users u ON u.id=d.user_id WHERE d.name=? AND d.evidence=? AND d.user_id<>? LIMIT 1`, c.name, c.evidence, c.user_id);
    return { ...c, advisory: dup ? `Assistive check: the same reference was also submitted by ${dup.name}. Verify carefully.` : null };
  });
}
function decideCredential(actor, id, body) {
  const c = get('SELECT * FROM credentials WHERE id=?', id) || fail(404, 'Not found');
  if (c.status !== 'pending') fail(409, 'Already decided.');
  if (!credentialsToReview(actor).some((x) => x.id === id)) fail(403, 'You cannot review this credential.');
  const ok = !!body.approve; const note = U.clean(body.note, 200);
  if (!ok && note.length < 4) fail(422, 'Give a reason for rejecting.');
  const exp = ok ? U.now() + 365 * 86400000 : null;
  run('UPDATE credentials SET status=?,decided_by=?,decided_at=?,decision_note=?,expires_at=? WHERE id=?', ok ? 'verified' : 'rejected', actor.id, U.now(), note, exp, id);
  audit(actor, ok ? 'credential.verified' : 'credential.rejected', `${actor.name} ${ok ? 'verified' : 'rejected'} "${c.name}" for user #${c.user_id}`, { target_user_id: c.user_id, details: { note } });
  notify(c.user_id, `Your "${c.name}" credential was ${ok ? 'verified (valid 12 months)' : 'rejected: ' + note}.`, '#/my');
  if (ok) for (const b of all(`SELECT * FROM bookings WHERE user_id=? AND status='pending' AND awaiting_verification=1`, c.user_id)) {
    const res = getRes(b.resource_id); const e = evaluateEligibility(getUser(c.user_id), res);
    if (!e.awaiting_verification) { run('UPDATE bookings SET awaiting_verification=0 WHERE id=?', b.id); notifyManagers(res, `Verification complete: request #${b.id} is ready for review.`, '#/owner'); }
  }
}

/* ---------------- scheduled scan: reminders, overdue, no-shows ---------------- */
function scan() {
  const t = U.now(); const out = { reminders: 0, overdue: 0, no_show: 0, expired: 0 };
  for (const b of all(`SELECT * FROM bookings WHERE status='approved' AND reminder_sent=0 AND start_ts>? AND start_ts<=?`, t, t + 3600000)) {
    const res = getRes(b.resource_id); run('UPDATE bookings SET reminder_sent=1 WHERE id=?', b.id);
    notify(b.user_id, `Reminder: ${res.name} starts at ${fmt(b.start_ts)}.`, `#/booking/${b.id}`); out.reminders++;
  }
  for (const b of all(`SELECT * FROM bookings WHERE status='checked_in' AND end_ts<? AND overdue_flag=0`, t)) {
    const res = getRes(b.resource_id); run('UPDATE bookings SET overdue_flag=1 WHERE id=?', b.id);
    run(`INSERT INTO incidents(booking_id,resource_id,reporter_id,type,severity,description,status,auto_flagged,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, b.id, res.id, null, 'delay', 'minor', `Not returned by ${fmt(b.end_ts)}. Flagged automatically for owner review (no penalty applied).`, 'open', 1, t);
    audit(null, 'booking.overdue', `Booking #${b.id} is overdue; reminder sent and flagged for owner review`, { booking_id: b.id, resource_id: res.id, target_user_id: b.user_id });
    notify(b.user_id, `OVERDUE: please return ${res.name} now or request an extension.`, `#/booking/${b.id}`);
    notifyManagers(res, `Overdue: ${getUser(b.user_id).name} has not returned ${res.name}.`, '#/owner'); out.overdue++;
  }
  for (const b of all(`SELECT * FROM bookings WHERE status='approved' AND end_ts<?`, t)) {
    const res = getRes(b.resource_id); run(`UPDATE bookings SET status='no_show',decision_reason='Marked as no-show automatically: never checked in before the end time.' WHERE id=?`, b.id); releaseDeposit(getBooking(b.id));
    audit(null, 'booking.no_show', `Booking #${b.id} marked no-show (no check-in). Deposit released; no penalty applied.`, { booking_id: b.id, resource_id: res.id, target_user_id: b.user_id });
    notify(b.user_id, `Your booking for ${res.name} was marked as a no-show. Repeated no-shows lower your priority.`, `#/booking/${b.id}`); promoteWaitlist(res, null); out.no_show++;
  }
  for (const b of all(`SELECT * FROM bookings WHERE status IN ('pending','waitlisted') AND start_ts<?`, t)) {
    run(`UPDATE bookings SET status='expired',decision_reason='Expired: the start time passed before a decision.' WHERE id=?`, b.id);
    audit(null, 'booking.expired', `Request #${b.id} expired undecided`, { booking_id: b.id, resource_id: b.resource_id, target_user_id: b.user_id });
    notify(b.user_id, 'A request expired because its start time passed before it was approved.', `#/booking/${b.id}`); out.expired++;
  }
  return out;
}

/* ---------------- discovery ---------------- */
const SYN = { print: ['3d', 'printer', 'printing', 'prototype', 'fabrication', 'filament'], '3d': ['printer', 'print', 'prototype'], laser: ['cut', 'engrave', 'acrylic', 'wood'], cut: ['laser', 'acrylic'], circuit: ['oscilloscope', 'electronics', 'signal', 'solder', 'pcb'], pcb: ['solder', 'electronics', 'circuit'], solder: ['pcb', 'electronics'], oscilloscope: ['signal', 'electronics', 'measure'], signal: ['oscilloscope', 'electronics'], video: ['camera', 'film', 'media', 'record'], film: ['camera', 'video', 'media'], camera: ['video', 'photo', 'media'], photo: ['camera', 'media'], podcast: ['audio', 'recording', 'studio', 'media'], audio: ['podcast', 'recording', 'studio'], train: ['gpu', 'ml', 'model', 'compute'], model: ['gpu', 'ml', 'compute', 'train'], ml: ['gpu', 'compute', 'train'], ai: ['gpu', 'ml', 'compute', 'train'], gpu: ['compute', 'ml', 'train'], meeting: ['room', 'seminar', 'presentation', 'team'], present: ['room', 'seminar', 'meeting'], workshop: ['room', 'seminar', 'meeting'], team: ['room', 'meeting'] };
const STOP = new Set('i a an the to for of and or my we our need want use using with on in at is are be can some do how'.split(' '));
function matchResources(user, need, list) {
  const toks = [...new Set(String(need).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)))];
  const exp = new Set(toks); toks.forEach((w) => (SYN[w] || []).forEach((s) => exp.add(s)));
  return list.map((r) => {
    const hay = { name: r.name.toLowerCase(), tags: r.tags.toLowerCase(), cat: r.category.toLowerCase(), desc: r.description.toLowerCase() };
    let score = 0; const hit = new Set();
    for (const w of exp) {
      const direct = toks.includes(w) ? 1 : 0.6;
      if (hay.name.includes(w)) { score += 3 * direct; hit.add(w); }
      if (hay.tags.includes(w)) { score += 2 * direct; hit.add(w); }
      if (hay.cat.includes(w)) { score += 2 * direct; hit.add(w); }
      if (hay.desc.includes(w)) { score += 1 * direct; hit.add(w); }
    }
    const reasons = [];
    if (hit.size) reasons.push(`Matches: ${[...hit].slice(0, 5).join(', ')}`);
    if (score > 0 && r.eligibility?.can_request) { score += 1.5; reasons.push('You already meet the requirements'); }
    else if (score > 0 && r.eligibility && !r.eligibility.can_request) reasons.push('Needs: ' + r.eligibility.items.filter((i) => i.status === 'fail').map((i) => i.label).join(', '));
    if (score > 0 && r.next_free) { score += 0.5; reasons.push(`Next free: ${fmt(r.next_free)}`); }
    return { ...r, match_score: Math.round(score * 10) / 10, match_reasons: reasons };
  }).filter((r) => r.match_score > 0).sort((a, b) => b.match_score - a.match_score);
}
function nextFree(res, durH = 1) {
  const days = J(res.open_days, []); const t = U.now();
  for (let d = 0; d < 10; d++) {
    const p = U.localParts(t + d * 86400000);
    const dow = new Date(p.date + 'T00:00:00Z').getUTCDay();
    if (!days.includes(dow)) continue;
    for (let m = U.hhmmToMin(res.open_start); m + durH * 60 <= U.hhmmToMin(res.open_end); m += 30) {
      const s = U.localToUtc(`${p.date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
      if (s > t && !heldOverlaps(res.id, s, s + durH * 3600000).length) return s;
    }
  }
  return null;
}
function fmt(ms) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: U.TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

/* ---------------- admin insights (advisory only) ---------------- */
function insights() {
  const since = U.now() - 30 * 86400000; const flags = [];
  for (const r of all('SELECT * FROM resources')) {
    const rows = all(`SELECT user_id,start_ts,end_ts FROM bookings WHERE resource_id=? AND status IN ('approved','checked_in','returned') AND start_ts>=?`, r.id, since);
    const per = {}; rows.forEach((b) => { per[b.user_id] = (per[b.user_id] || 0) + U.hours(b.start_ts, b.end_ts); });
    const total = Object.values(per).reduce((a, b) => a + b, 0); const users = Object.keys(per).length;
    for (const [uid, h] of Object.entries(per)) if (users >= 2 && total >= 4 && h / total >= 0.5) flags.push({ type: 'monopolisation', resource: r.name, user: getUser(+uid).name, detail: `${h.toFixed(1)} of ${total.toFixed(1)} booked hours (${Math.round((100 * h) / total)}%) in the last 30 days.` });
  }
  for (const u of all(`SELECT u.id,u.name,COUNT(*) c FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.status='no_show' AND b.start_ts>=? GROUP BY u.id HAVING c>=2`, since)) flags.push({ type: 'no_shows', user: u.name, detail: `${u.c} no-shows in 30 days.` });
  for (const d of all(`SELECT name, evidence, COUNT(DISTINCT user_id) n FROM credentials GROUP BY name, evidence HAVING n>1`)) flags.push({ type: 'duplicate_evidence', resource: d.name, detail: `Reference "${d.evidence}" submitted by ${d.n} different users.` });
  return flags;
}

module.exports = { HttpError, fail, J, DEMO, audit, verifyAuditChain, notify, managerIds, canManage, getRes, getBooking, getUser, evaluateEligibility, fairness, previewBooking, createBooking, rankCompetitors, approve, decideSimple, cancel, checkin, doReturn, confirmReturn, requestExtension, decideExtension, reportIncident, resolveIncident, submitCredential, credentialsToReview, decideCredential, scan, matchResources, nextFree, fmt, insights, heldOverlaps, blockingIncidents, quota, promoteWaitlist, PURPOSE_BONUS, ACTIVE };
