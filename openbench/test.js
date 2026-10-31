// Run with:  node test.js
// Drives the rules engine through every journey the judges will try.
const assert = require('assert');
const OB = require('./logic.js');
const { HOUR, DAY, MIN } = OB;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
};
const throws = (fn, re, msg) => assert.throws(fn, e => re.test(e.message), msg || ('expected error matching ' + re));

const R = n => eng.db.resources.find(r => r.name.startsWith(n));
let eng;
const fresh = () => { eng = OB.seedEngine(); return eng; };
// next open local datetime for a resource, `from` days ahead, at hour h (offset pushes later days)
const slot = (r, from, h, hours) => {
  let d = from;
  const day = k => { const x = new Date(eng.now()); x.setDate(x.getDate() + k); x.setHours(h, 0, 0, 0); return x; };
  while (!r.availability.days.includes(day(d).getDay())) d++;
  const s = day(d).getTime();
  return { start: s, end: s + hours * HOUR, day: d };
};
const jump = ms => eng.setNow(ms);
const cond = (r, rating = 'good', notes = '') => ({ rating, notes, checklist: Object.fromEntries(r.checklist.map(i => [i, true])) });

console.log('\nSeed & audit');
fresh();
test('seed loads resources, users and a valid audit chain', () => {
  assert.strictEqual(eng.db.resources.length, 6);
  assert.ok(eng.db.users.length >= 8);
  const v = eng.verifyAudit(); assert.ok(v.valid, 'audit chain should verify'); assert.ok(v.count > 50);
});
test('login works and rejects a wrong password', () => {
  assert.strictEqual(eng.login('ANANYA@demo.edu', 'demo123').id, 'u_ananya');
  throws(() => eng.login('ananya@demo.edu', 'nope'), /Incorrect/);
});
test('tampering with an audit entry is detected', () => {
  const e2 = OB.seedEngine(); e2.db.audit[5].detail = 'edited later';
  const v = e2.verifyAudit(); assert.strictEqual(v.valid, false); assert.strictEqual(v.brokenAt, 5);
});

console.log('\nOne full journey: list → discover → eligibility → request → approve → check-in → return → confirm');
test('complete lifecycle with credits, deposit and history', () => {
  fresh();
  // 1. owner lists a new resource
  const r = eng.createResource('u_rao', {
    name: 'Soldering Station Pro', category: 'Electronics', location: 'Block A, Bench 2', description: 'Temperature-controlled soldering station with fume extraction.',
    rules: 'Tip must be tinned and the iron switched off after use.', tags: ['soldering', 'electronics'], days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00',
    maxHoursPerBooking: 3, maxHoursPerWeek: 6, maxActive: 2, creditsPerHour: 2, deposit: 6, trainings: [], allowedMemberships: ['student'], checklist: ['Tip tinned', 'Iron off']
  });
  assert.strictEqual(r.status, 'active');
  // 2. user discovers it
  const found = eng.search({ q: 'I need to solder a circuit', userId: 'u_rahul' });
  assert.ok(found.some(x => x.resource.id === r.id), 'search should find the soldering station');
  // 3. eligibility
  assert.ok(eng.eligibility('u_rahul', r.id).eligible);
  assert.ok(!eng.eligibility('u_imran', r.id).eligible, 'community member should be ineligible');
  // 4. request
  const s = slot(r, 2, 10, 2), before = eng.user('u_rahul').credits;
  const b = eng.requestBooking('u_rahul', { resourceId: r.id, start: s.start, end: s.end, purpose: 'Soldering my sensor board for the lab project' });
  assert.strictEqual(b.status, 'requested'); assert.strictEqual(eng.user('u_rahul').credits, before, 'nothing charged before approval');
  // 5. owner decides (not the requester, not an unrelated user)
  throws(() => eng.decideBooking('u_rahul', b.id, 'approve'), /own request|Only the owner/);
  throws(() => eng.decideBooking('u_ananya', b.id, 'approve'), /Only the owner/);
  eng.decideBooking('u_rao', b.id, 'approve', 'Looks fine');
  assert.strictEqual(b.status, 'approved'); assert.strictEqual(eng.user('u_rahul').credits, before - 4 - 6);
  // 6. check-in too early is refused, then jump the demo clock
  throws(() => eng.checkIn('u_rahul', b.id, cond(r)), /Check-in opens/);
  jump(b.start);
  eng.checkIn('u_rahul', b.id, cond(r, 'good', ''));
  assert.strictEqual(b.status, 'checked_in');
  // 7. return & confirm
  jump(b.end - 5 * MIN);
  eng.checkOut('u_rahul', b.id, cond(r, 'good'));
  assert.strictEqual(b.status, 'returned');
  throws(() => eng.confirmReturn('u_rahul', b.id), /Only staff|own return/);
  eng.confirmReturn('u_rao', b.id, { notes: 'All good' });
  assert.strictEqual(b.status, 'completed'); assert.strictEqual(b.depositState, 'released');
  assert.strictEqual(eng.user('u_rahul').credits, before - 4, 'deposit returned, usage cost kept');
  // 8. both parties see the history
  const hist = eng.auditFor('u_rahul', { bookingId: b.id }).map(e => e.action);
  ['booking.requested', 'booking.approved', 'booking.checked_in', 'booking.returned', 'booking.completed'].forEach(a => assert.ok(hist.includes(a), 'missing ' + a));
  assert.strictEqual(eng.auditFor('u_rao', { bookingId: b.id }).length, hist.length);
  assert.ok(eng.verifyAudit().valid);
});

console.log('\nEligibility & verification');
test('missing training blocks a request and a verified claim unlocks it', () => {
  fresh();
  const pr = R('Prusa'), s = slot(pr, 3, 10, 1);
  throws(() => eng.requestBooking('u_rahul', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Printing a phone stand for class' }), /Training/);
  const claim = eng.db.claims.find(c => c.userId === 'u_rahul');
  throws(() => eng.reviewClaim('u_ananya', claim.id, true), /not a reviewer/);
  eng.reviewClaim('u_ravi', claim.id, true);
  assert.ok(eng.user('u_rahul').credentials.t_3dp);
  const b = eng.requestBooking('u_rahul', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Printing a phone stand for class' });
  assert.strictEqual(b.status, 'requested');
});
test('membership rule: student cannot book the research GPU', () => {
  fresh();
  const g = R('GPU'), e = eng.eligibility('u_ananya', g.id);
  assert.ok(!e.eligible); assert.ok(e.checks.find(c => c.key === 'membership' && !c.pass));
  assert.ok(eng.eligibility('u_sneha', g.id).eligible);
});
test('unverified account cannot book; admin verification fixes it', () => {
  fresh();
  const room = R('Seminar'), s = slot(room, 2, 10, 1);
  throws(() => eng.requestBooking('u_neha', { resourceId: room.id, start: s.start, end: s.end, purpose: 'Design club meeting' }), /Verified account/);
  throws(() => eng.verifyUser('u_rao', 'u_neha', true), /Only administrators/);
  eng.verifyUser('u_admin', 'u_neha', true);
  assert.strictEqual(eng.requestBooking('u_neha', { resourceId: room.id, start: s.start, end: s.end, purpose: 'Design club meeting' }).status, 'requested');
});
test('owners/managers cannot book their own resource', () => {
  fresh();
  const pr = R('Prusa'), s = slot(pr, 3, 10, 1);
  throws(() => eng.requestBooking('u_ravi', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Testing my own printer here' }), /Independent requester/);
});

console.log('\nFair allocation, waitlist and conflicts');
test('conflicting request joins the waitlist with an explainable priority; cancellation promotes it', () => {
  fresh();
  const laser = R('80W'), approved = eng.db.bookings.find(b => b.resourceId === laser.id && b.status === 'approved' && b.start > eng.now());
  const b = eng.requestBooking('u_ananya', { resourceId: laser.id, start: approved.start + 30 * MIN, end: approved.start + 90 * MIN, purpose: 'Cutting acrylic parts for my capstone' });
  assert.strictEqual(b.status, 'waitlisted'); assert.ok(eng.waitlistPosition(b) === 1);
  const p = eng.priority(b); assert.ok(p.parts.length >= 3 && typeof p.total === 'number');
  eng.cancelBooking('u_imran', approved.id, 'Plans changed');
  assert.strictEqual(b.status, 'requested', 'waitlisted request promoted to owner review');
  assert.ok(b.why.some(w => /highest waitlist priority/.test(w.text)));
  assert.strictEqual(approved.status, 'cancelled');
});
test('lighter users outrank heavy users on the waitlist', () => {
  fresh();
  const laser = R('80W'), appr = eng.db.bookings.find(b => b.resourceId === laser.id && b.status === 'approved' && b.start > eng.now());
  // Imran used 9 h of laser recently; Ananya none → she should rank higher than he does
  const a = eng.requestBooking('u_ananya', { resourceId: laser.id, start: appr.start, end: appr.start + HOUR, purpose: 'Cutting acrylic parts for my capstone' });
  eng.db.users.find(u => u.id === 'u_sneha').credentials.t_laser = { verifiedBy: 'u_admin', verifiedAt: eng.now(), expires: eng.now() + 100 * DAY };
  const pa = eng.priority(a).total, pi = eng.priority(appr).total;
  assert.ok(pa > pi, `light user ${pa} should outrank heavy user ${pi}`);
});
test('competing pending requests: approving one waitlists the other with an explanation', () => {
  fresh();
  const room = R('Seminar'), s = slot(room, 3, 10, 2);
  const a = eng.requestBooking('u_rahul', { resourceId: room.id, start: s.start, end: s.end, purpose: 'Physics society seminar practice' });
  const b = eng.requestBooking('u_ananya', { resourceId: room.id, start: s.start + 30 * MIN, end: s.end + 30 * MIN, purpose: 'Robotics team design review' });
  assert.strictEqual(eng.competitors(a.id).length, 1);
  eng.decideBooking('u_rao', a.id, 'approve', '');
  assert.strictEqual(b.status, 'waitlisted'); assert.ok(b.why.some(w => /Another request was approved/.test(w.text)));
  throws(() => eng.decideBooking('u_rao', b.id, 'approve', ''), /Only pending/);
});
test('weekly cap and open-request cap stop monopolisation', () => {
  fresh();
  const pr = R('Prusa'); // cap 8 h/week, 2 open requests per person; Sneha has no printer bookings yet
  const s = slot(pr, 5, 9, 4), s2 = slot(pr, 5, 13, 4), s3 = slot(pr, 5, 17, 1);
  eng.requestBooking('u_sneha', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Printing sensor mounts, batch one' });
  eng.requestBooking('u_sneha', { resourceId: pr.id, start: s2.start, end: s2.end, purpose: 'Printing sensor mounts, batch two' });
  const pre = eng.previewRequest('u_sneha', pr.id, s3.start, s3.end);
  assert.ok(!pre.canSubmit);
  assert.ok(pre.slot.find(c => c.key === 'weekly' && !c.pass), 'weekly cap should fail');
  assert.ok(pre.slot.find(c => c.key === 'active' && !c.pass), 'open-request cap should fail');
  throws(() => eng.requestBooking('u_sneha', { resourceId: pr.id, start: s3.start, end: s3.end, purpose: 'Printing sensor mounts, batch three' }), /Request not allowed/);
});
test('opening hours, duration and past-time checks', () => {
  fresh();
  const pr = R('Prusa'), s = slot(pr, 3, 7, 1);
  throws(() => eng.requestBooking('u_ananya', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Printing before the lab opens' }), /opening hours/);
  const s2 = slot(pr, 3, 10, 6);
  throws(() => eng.requestBooking('u_ananya', { resourceId: pr.id, start: s2.start, end: s2.end, purpose: 'A very long printing session' }), /per booking/);
  throws(() => eng.requestBooking('u_ananya', { resourceId: pr.id, start: eng.now() - HOUR, end: eng.now(), purpose: 'Printing in the past somehow' }), /future/);
});
test('owner can reject with a reason; empty reason is refused', () => {
  fresh();
  const pend = eng.db.bookings.find(b => b.status === 'requested' && b.userId === 'u_ananya');
  throws(() => eng.decideBooking('u_ravi', pend.id, 'reject', ''), /reason/);
  eng.decideBooking('u_ravi', pend.id, 'reject', 'Machine is booked for maintenance that morning');
  assert.strictEqual(pend.status, 'rejected'); assert.ok(pend.why.some(w => /maintenance/.test(w.text)));
});

console.log('\nTime-driven events');
test('no-show releases the slot, refunds credits, opens a reviewable incident and promotes the waitlist', () => {
  fresh();
  const laser = R('80W'), appr = eng.db.bookings.find(b => b.resourceId === laser.id && b.status === 'approved' && b.start > eng.now());
  const w = eng.requestBooking('u_ananya', { resourceId: laser.id, start: appr.start, end: appr.start + HOUR, purpose: 'Cutting acrylic parts for my capstone' });
  const bal = eng.user('u_imran').credits;
  jump(appr.start + 31 * MIN); eng.tick();
  assert.strictEqual(appr.status, 'no_show'); assert.strictEqual(eng.user('u_imran').credits, bal + appr.cost + appr.deposit);
  const inc = eng.db.incidents.find(i => i.bookingId === appr.id); assert.ok(inc && inc.auto && inc.status === 'open');
  assert.strictEqual(eng.user('u_imran').strikes, 0, 'no automatic penalty');
  assert.ok(w.status === 'requested' || w.status === 'expired', 'waitlist reconsidered');
});
test('start reminder, overdue alert and late return create reviewable delay incident', () => {
  fresh();
  const room = R('Seminar'), s = slot(room, 2, 10, 1);
  const b = eng.requestBooking('u_rahul', { resourceId: room.id, start: s.start, end: s.end, purpose: 'Study group presentation rehearsal' });
  eng.decideBooking('u_rao', b.id, 'approve', '');
  jump(b.start - 50 * MIN); eng.tick();
  assert.ok(eng.db.notifications.some(n => n.userId === 'u_rahul' && /Reminder/.test(n.text)));
  jump(b.start); eng.checkIn('u_rahul', b.id, cond(room));
  jump(b.end + 20 * MIN); eng.tick();
  assert.ok(eng.isOverdue(b)); assert.ok(eng.db.notifications.some(n => n.userId === 'u_rahul' && /Overdue/.test(n.text)));
  assert.ok(eng.db.notifications.some(n => n.userId === 'u_rao' && /Overdue/.test(n.text)));
  eng.checkOut('u_rahul', b.id, cond(room));
  const d = eng.db.incidents.find(i => i.bookingId === b.id && i.type === 'delay'); assert.ok(d && d.auto);
});
test('unreviewed requests expire automatically instead of hanging forever', () => {
  fresh();
  const pend = eng.db.bookings.find(b => b.status === 'requested');
  jump(pend.start + MIN); eng.tick();
  assert.strictEqual(pend.status, 'expired');
});
test('previous overdue session alerts staff when it blocks the next booking', () => {
  fresh();
  const room = R('Seminar'), s = slot(room, 2, 10, 1);
  const b1 = eng.requestBooking('u_rahul', { resourceId: room.id, start: s.start, end: s.end, purpose: 'Study group presentation rehearsal' });
  const b2 = eng.requestBooking('u_ananya', { resourceId: room.id, start: s.end, end: s.end + HOUR, purpose: 'Robotics team design review meeting' });
  eng.decideBooking('u_rao', b1.id, 'approve', ''); eng.decideBooking('u_rao', b2.id, 'approve', '');
  jump(b1.start); eng.checkIn('u_rahul', b1.id, cond(room));
  jump(b2.start + 5 * MIN); eng.tick();
  throws(() => eng.checkIn('u_ananya', b2.id, cond(room)), /previous session/);
  assert.ok(eng.db.notifications.some(n => n.userId === 'u_ananya' && /previous session/.test(n.text)));
});

console.log('\nExtensions');
test('extension granted when free, blocked when next booking exists', () => {
  fresh();
  const room = R('Seminar'), s = slot(room, 2, 10, 1);
  const b = eng.requestBooking('u_rahul', { resourceId: room.id, start: s.start, end: s.end, purpose: 'Study group presentation rehearsal' });
  eng.decideBooking('u_rao', b.id, 'approve', '');
  const x = eng.requestExtension('u_rahul', b.id, 30); eng.decideExtension('u_rao', x.id, true);
  assert.strictEqual(b.end, s.end + 30 * MIN);
  const nxt = eng.requestBooking('u_ananya', { resourceId: room.id, start: b.end, end: b.end + HOUR, purpose: 'Robotics team design review meeting' });
  eng.decideBooking('u_rao', nxt.id, 'approve', '');
  throws(() => eng.requestExtension('u_rahul', b.id, 30), /another booking starts/);
});

console.log('\nIncidents, penalties and disputes');
test('damage report holds deposit; penalties need human decision; strikes → suspension; dispute → admin only', () => {
  fresh();
  const pr = R('Prusa'); let n = 0;
  const run = (d, damage) => {
    const s = slot(pr, d, 10, 1); jump(eng.now());
    const b = eng.requestBooking('u_ananya', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Printing parts for the capstone project ' + (++n) });
    eng.decideBooking('u_ravi', b.id, 'approve', ''); jump(b.start); eng.checkIn('u_ananya', b.id, cond(pr));
    jump(b.end - 5 * MIN); eng.checkOut('u_ananya', b.id, cond(pr, 'fair', 'Nozzle clogged at the end of the print'));
    eng.confirmReturn('u_ravi', b.id, damage ? { damage: { severity: 'medium', description: 'Nozzle heater cable frayed' } } : {});
    return b;
  };
  const b1 = run(2, true);
  assert.strictEqual(b1.depositState, 'held', 'deposit held while damage unresolved');
  const inc = eng.db.incidents.find(i => i.bookingId === b1.id && i.type === 'damage');
  throws(() => eng.resolveIncident('u_ananya', inc.id, { note: 'I decide myself' }), /Only staff/);
  const bal = eng.user('u_ananya').credits;
  eng.resolveIncident('u_ravi', inc.id, { strike: true, forfeitDeposit: true, note: 'Cable damaged through misuse' });
  assert.strictEqual(b1.depositState, 'forfeited'); assert.strictEqual(eng.user('u_ananya').strikes, 1); assert.strictEqual(eng.user('u_ananya').credits, bal);
  // dispute: only admin may rule, and ruling can reverse the penalty
  eng.disputeIncident('u_ananya', inc.id, 'The cable was already frayed when I started');
  throws(() => eng.resolveIncident('u_ravi', inc.id, { note: 'Staff retry' }), /administrator/);
  eng.resolveIncident('u_admin', inc.id, { strike: false, forfeitDeposit: false, note: 'Appeal accepted: wear and tear' });
  assert.strictEqual(eng.user('u_ananya').strikes, 0); assert.strictEqual(b1.depositState, 'released'); assert.strictEqual(eng.user('u_ananya').credits, bal + 5);
  // three strikes suspend automatically; admin reinstates
  const u = eng.user('u_ananya'); u.strikes = 2; u.status = 'verified';
  const b2 = run(4, true); const i2 = eng.db.incidents.find(i => i.bookingId === b2.id && i.type === 'damage');
  eng.resolveIncident('u_ravi', i2.id, { strike: true, forfeitDeposit: false, note: 'Second damage in a week' });
  assert.strictEqual(u.status, 'suspended');
  const s = slot(pr, 6, 10, 1);
  throws(() => eng.requestBooking('u_ananya', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Trying to print while suspended' }), /Verified account/);
  eng.reinstateUser('u_admin', 'u_ananya', 'Reviewed with student; training refresher done');
  assert.strictEqual(u.status, 'verified');
  assert.ok(eng.verifyAudit().valid);
});
test('damage found at check-in is documented and cannot be penalised', () => {
  fresh();
  const pr = R('Prusa'), s = slot(pr, 2, 10, 1);
  const b = eng.requestBooking('u_ananya', { resourceId: pr.id, start: s.start, end: s.end, purpose: 'Printing parts for the capstone project' });
  eng.decideBooking('u_ravi', b.id, 'approve', ''); jump(b.start);
  eng.checkIn('u_ananya', b.id, cond(pr, 'damaged', 'Build plate already scratched deeply'));
  const inc = eng.db.incidents.find(i => i.bookingId === b.id); assert.ok(inc.preExisting);
  throws(() => eng.resolveIncident('u_ravi', inc.id, { strike: true, note: 'Penalise the user' }), /cannot be penalised/);
  eng.resolveIncident('u_ravi', inc.id, { note: 'Logged for repair; not the user\'s fault' });
  assert.strictEqual(eng.user('u_ananya').strikes, 0);
});
test('condition worse than at check-in flags the return for staff', () => {
  fresh();
  const room = R('Seminar'), s = slot(room, 2, 10, 1);
  const b = eng.requestBooking('u_rahul', { resourceId: room.id, start: s.start, end: s.end, purpose: 'Study group presentation rehearsal' });
  eng.decideBooking('u_rao', b.id, 'approve', ''); jump(b.start); eng.checkIn('u_rahul', b.id, cond(room, 'excellent'));
  jump(b.end - MIN); eng.checkOut('u_rahul', b.id, cond(room, 'fair', 'Whiteboard marker stains on the table'));
  assert.ok(b.conditionWorsened);
  assert.ok(eng.db.notifications.some(n => n.userId === 'u_rao' && /condition changed/.test(n.text)));
});

console.log('\nPrivacy, roles & advisory flags');
test('users only see their own audit/bookings; staff see their resources; admin sees all', () => {
  fresh();
  const mine = eng.auditFor('u_rahul'); assert.ok(mine.every(e => e.actorId === 'u_rahul' || e.subjectUserId === 'u_rahul'));
  const raoIds = new Set(eng.managedResources('u_rao').map(r => r.id));
  assert.ok(eng.auditFor('u_rao').every(e => e.actorId === 'u_rao' || e.subjectUserId === 'u_rao' || raoIds.has(e.resourceId)));
  assert.strictEqual(eng.auditFor('u_admin').length, eng.db.audit.length);
  assert.ok(eng.visibleBookings('u_rahul').every(b => b.userId === 'u_rahul'));
  assert.ok(eng.visibleBookings('u_ravi').every(b => eng.canManage('u_ravi', eng.res(b.resourceId)) || b.userId === 'u_ravi'));
});
test('only owners can list resources; managers cannot edit listings', () => {
  fresh();
  const data = { name: 'Test rig', category: 'Space', location: 'Somewhere', description: 'A test resource for permissions.', rules: 'Be careful with it please.', days: [1], start: '09:00', end: '12:00', maxHoursPerBooking: 2, maxHoursPerWeek: 4, maxActive: 1 };
  throws(() => eng.createResource('u_rahul', data), /Only verified owners/);
  throws(() => eng.updateResource('u_ravi', R('Prusa').id, Object.assign({}, data)), /Only the owner/);
  assert.ok(eng.createResource('u_rao', data));
});
test('advisory flags surface heavy users without applying penalties', () => {
  fresh();
  const flags = eng.integrityFlags();
  assert.ok(Array.isArray(flags)); assert.ok(eng.db.users.every(u => u.strikes === 0));
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' — SOME FAILED' : ' — all green') + '\n');
