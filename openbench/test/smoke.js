// End-to-end API test: starts a fresh server on a temp DB and walks the whole sharing lifecycle.
const { spawn } = require('child_process'), path = require('path'), os = require('os'), fs = require('fs');
const PORT = 3900 + Math.floor(Math.random() * 90), DBF = path.join(os.tmpdir(), `ob-test-${Date.now()}.db`);
const base = `http://localhost:${PORT}/api`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + m); };
async function call(tok, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: await r.json() };
}
const login = async e => (await call(null, 'POST', '/auth/login', { email: e + '@openbench.demo', password: 'demo1234' })).j.token;
const dateAt = d => { let x; do { x = new Date(Date.now() + d * 864e5 + 5.5 * 36e5); d++; } while (x.getUTCDay() === 0); return x.toISOString().slice(0, 10); };

(async () => {
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: DBF, DEMO_MODE: 'true' }, cwd: path.join(__dirname, '..') });
  srv.stderr.on('data', d => { const t = String(d); if (!t.includes('ExperimentalWarning') && !t.includes('trace-warnings')) process.stderr.write(t); });
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/meta'); break; } catch { await new Promise(r => setTimeout(r, 150)); } }
  try {
    console.log('Auth & roles');
    ok((await call(null, 'POST', '/auth/login', { email: 'ananya@openbench.demo', password: 'wrong' })).s === 401, 'wrong password rejected');
    ok((await call(null, 'GET', '/resources')).s === 401, 'API requires sign-in');
    const owner = await login('owner.media'), admin = await login('admin'), tom = await login('tom'), ana = await login('ananya'), mgr = await login('manager'), vik = await login('vikram'), sara = await login('sara'), ish = await login('ishaan');
    ok((await call(ana, 'GET', '/audit')).s === 403, 'normal user cannot read global audit trail');
    ok((await call(ana, 'GET', '/manage/overview')).s === 403, 'normal user has no manager console');

    console.log('1. Owner lists a resource');
    const nr = await call(owner, 'POST', '/resources', { name: 'Test Drone Kit', category: 'Media', location: 'Hangar 1', description: 'Test', required_cert: 'Drone Basics', deposit: 700, max_hours: 3, max_active: 1, weekly_quota: 4, open_days: '0,1,2,3,4,5,6', open_from: 0, open_to: 1440, supervised: false, allowed_types: ['student', 'researcher'] });
    ok(nr.s === 200 && nr.j.id, 'owner lists resource with conditions'); const rid = nr.j.id;
    ok((await call(ana, 'POST', '/resources', { name: 'x', category: 'Media', location: 'y' })).s === 403, 'student cannot list resources');

    console.log('2. User discovers & checks eligibility');
    const list = await call(ana, 'GET', '/resources?q=' + encodeURIComponent('engrave acrylic prototype'));
    ok(list.j[0] && /laser/i.test(list.j[0].name), 'smart match: "engrave acrylic" -> laser cutter first, terms: ' + (list.j[0] && list.j[0].match_terms));
    const d = await call(ana, 'GET', '/resources/' + rid);
    ok(d.j.eligibility.ok === false && d.j.eligibility.checks.some(c => c.key === 'cert' && !c.ok), 'missing certification detected before booking');
    const d2 = dateAt(2);
    const blocked = await call(ana, 'POST', `/resources/${rid}/book`, { date: d2, start: '10:00', end: '11:00', purpose_type: 'project', purpose: 'Aerial photos for project' });
    ok(blocked.s === 422 && blocked.j.problems.some(p => p.key === 'cert'), 'booking blocked with explained reason (no training)');
    ok((await call(tom, 'POST', `/resources/${rid}/book`, { date: d2, start: '10:00', end: '11:00', purpose_type: 'project', purpose: 'Aerial photos' })).j.problems.some(p => p.key === 'verified' || p.key === 'member'), 'unverified/ineligible member blocked');

    console.log('Training request -> grant');
    const cr = await call(ana, 'POST', `/resources/${rid}/request-cert`, { note: 'Please' }); ok(cr.s === 200, 'user requests training');
    const ov = await call(owner, 'GET', '/manage/overview'); const creq = ov.j.certReqs.find(c => c.resource_id === rid);
    ok(!!creq && !('email' in creq.user), 'owner sees the training request, requester email not exposed');
    ok((await call(owner, 'POST', `/cert-requests/${creq.id}/decide`, { grant: true })).s === 200, 'owner grants certification');

    console.log('3-6. Request, conflicts, fair use, approval');
    const dur = await call(ana, 'POST', `/resources/${rid}/check`, { date: d2, start: '10:00', end: '14:00', purpose_type: 'project' });
    ok(!dur.j.ok && dur.j.problems.some(p => /Maximum 3 h/.test(p.msg)), 'duration limit enforced');
    const prev = await call(ana, 'POST', `/resources/${rid}/check`, { date: d2, start: '10:00', end: '12:00', purpose_type: 'coursework' });
    ok(prev.j.ok && prev.j.outcome === 'pending' && prev.j.priority.parts.length >= 2, 'live preview explains outcome + fairness score');
    const b1 = await call(ana, 'POST', `/resources/${rid}/book`, { date: d2, start: '10:00', end: '12:00', purpose_type: 'coursework', purpose: 'Aerial survey for course project' });
    ok(b1.s === 200 && b1.j.status === 'pending', 'booking request submitted -> pending'); const bid = b1.j.id;
    const again = await call(ana, 'POST', `/resources/${rid}/book`, { date: dateAt(3), start: '10:00', end: '11:00', purpose_type: 'project', purpose: 'Second request same resource' });
    ok(again.s === 422 && again.j.problems.some(p => /at most 1 open/.test(p.msg)), 'monopolisation blocked: max open requests per user');
    ok((await call(sara, 'GET', '/bookings/' + bid)).s === 403, 'other users cannot see someone else\'s booking');
    // second person competes
    await call(admin, 'POST', '/admin/users/' + 6 + '/status', { status: 'verified' });
    const vcert = await call(vik, 'POST', `/resources/${rid}/request-cert`, {}); ok(vcert.s === 200, 'startup user requests training too (ineligible type -> still blocked below)');
    const vb = await call(vik, 'POST', `/resources/${rid}/book`, { date: d2, start: '11:00', end: '12:00', purpose_type: 'project', purpose: 'Startup demo footage' });
    ok(vb.s === 422, 'member type not allowed for this resource is blocked');
    ok((await call(owner, 'POST', `/bookings/${bid}/decide`, { decision: 'reject', reason: '' })).s === 400, 'rejection requires a reason');
    const ap = await call(owner, 'POST', `/bookings/${bid}/decide`, { decision: 'approve', reason: 'Certified and slot free.' });
    ok(ap.j.status === 'approved', 'owner approves');
    const ish2 = await call(ish, 'POST', `/resources/${rid}/book`, { date: d2, start: '11:00', end: '12:00', purpose_type: 'project', purpose: 'Roof inspection test' });
    ok(ish2.s === 422, 'ishaan lacks drone training -> blocked');
    const bd = await call(ana, 'GET', '/bookings/' + bid); ok(bd.j.deposit_status === 'held', 'deposit held (simulated) on approval');

    console.log('7. Check-in with initial condition; 8. return with final condition; 9. incidents');
    ok((await call(sara, 'POST', `/bookings/${bid}/checkin`, { condition: 'good' })).s === 403, 'a stranger cannot check in');
    ok((await call(ana, 'POST', `/bookings/${bid}/checkin`, { condition: 'excellent', notes: 'Props intact' })).s === 200, 'user checks in with initial condition');
    const co = await call(ana, 'POST', `/bookings/${bid}/checkout`, { condition: 'fair', notes: 'Scuffed propeller guard', damage: false });
    ok(co.j.flags.includes('damage'), 'condition drop auto-opens damage incident for human review');
    ok((await call(owner, 'POST', `/bookings/${bid}/confirm-return`, { deposit_action: 'withhold', note: '' })).s === 400, 'withholding deposit requires a written reason');
    ok((await call(owner, 'POST', `/bookings/${bid}/confirm-return`, { deposit_action: 'withhold', note: 'Propeller guard replacement cost.' })).s === 200, 'owner confirms return');
    const ovv = await call(owner, 'GET', '/manage/overview'); const inc = ovv.j.incidents.find(i => i.booking_id === bid);
    ok(inc && inc.status === 'open' && /NOT a decision/.test(inc.summary), 'incident has assistive summary, awaiting human');
    const rs = await call(owner, 'POST', `/incidents/${inc.id}/resolve`, { resolution: 'Guard replaced from deposit; warning issued.', penalty: 'strike' });
    ok(rs.s === 200, 'owner resolves incident with penalty');
    ok((await call(ana, 'GET', '/me')).j.strikes === 1, 'strike applied only after human decision');
    ok((await call(ana, 'POST', `/incidents/${inc.id}/appeal`, { text: 'The guard was already cracked.' })).s === 200, 'user appeals');
    ok((await call(owner, 'POST', `/incidents/${inc.id}/appeal-decision`, { decision: 'overturn', note: 'x yz abc' })).s === 403, 'owner cannot decide the appeal (independent admin review)');
    ok((await call(admin, 'POST', `/incidents/${inc.id}/appeal-decision`, { decision: 'overturn', note: 'Check-in photo shows crack.' })).s === 200, 'admin overturns appeal');
    ok((await call(ana, 'GET', '/me')).j.strikes === 0, 'strike reversed after appeal');

    console.log('10. Complete history for both parties');
    const fin = await call(ana, 'GET', '/bookings/' + bid);
    const acts = fin.j.audit.map(a => a.action);
    for (const a of ['booking_requested', 'booking_approved', 'check_in', 'check_out', 'return_confirmed', 'incident_reported', 'incident_resolved', 'appeal_filed']) ok(acts.includes(a), 'audit has ' + a);
    ok(fin.j.status === 'completed' && fin.j.deposit_status === 'withheld', 'booking completed, deposit withheld with reason');
    const fo = await call(owner, 'GET', '/bookings/' + bid); ok(fo.j.audit.length === fin.j.audit.length && fo.j.requester.email, 'owner sees same history + contact after approval');
    const vr = await call(admin, 'GET', '/audit/verify'); ok(vr.j.ok === true, `audit hash-chain verifies (${vr.j.checked} entries)`);

    console.log('Waitlist, cancellation, promotion (seeded laser scenario)');
    const mo = await call(mgr, 'GET', '/manage/overview');
    const wl = mo.j.bookings.find(b => b.status === 'waitlisted' && b.resource_name.includes('Laser')); const ap2 = mo.j.bookings.find(b => b.status === 'approved' && b.resource_name.includes('Laser'));
    ok(!!wl && !!ap2, 'seed: waitlisted + approved laser bookings exist');
    ok((await call(mgr, 'POST', `/bookings/${wl.id}/decide`, { decision: 'approve', reason: 'ok' })).s === 409, 'cannot approve into an occupied slot (conflict)');
    const cn = await call(ana, 'POST', `/bookings/${ap2.id}/cancel`, { reason: 'Project moved' }); ok(cn.s === 200, 'user cancels approved booking');
    const wl2 = (await call(mgr, 'GET', '/bookings/' + wl.id)).j; ok(wl2.status === 'pending', 'waitlisted request auto-promoted back to review: ' + (wl2.decision_reason || '').slice(0, 60));
    ok((await call(ish, 'GET', '/notifications')).j.some(n => /opened/.test(n.text)), 'waitlisted user notified');
    ok((await call(mgr, 'POST', `/bookings/${wl.id}/decide`, { decision: 'approve', reason: 'Slot free, certified.' })).j.status === 'approved', 'manager approves promoted request');
    ok((await call(ish, 'POST', `/bookings/${wl.id}/checkin`, { condition: 'good' })).s === 403, 'supervised: user cannot self check-in');
    ok((await call(mgr, 'POST', `/bookings/${wl.id}/checkin`, { condition: 'good', notes: 'ID + training checked' })).s === 200, 'staff checks user in on site');

    console.log('Auto-approve + overdue sweep + admin');
    const stu = (await call(ana, 'GET', '/resources')).j.find(r => r.name.includes('Podcast'));
    ok((await call(ana, 'POST', `/resources/${stu.id}/book`, { date: dateAt(1), start: '10:00', end: '11:00', purpose_type: 'project', purpose: 'Record episode one' })).j.status === 'approved', 'low-risk room auto-approved by rule (and logged)');
    const m2 = await call(owner, 'GET', '/manage/overview'); ok(m2.j.bookings.some(b => b.is_overdue), 'overdue return is flagged');
    ok((await call(owner, 'GET', '/notifications')).j.some(n => /OVERDUE/.test(n.text)), 'managers notified of overdue');
    ok((await call(admin, 'GET', '/admin/fairuse')).j.some(u => u.flags.length), 'fair-use watch lists flagged users');
    ok((await call(tom, 'GET', '/admin/users')).s === 403, 'non-admin cannot list users');
  } finally { srv.kill(); try { fs.unlinkSync(DBF); } catch {} }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
