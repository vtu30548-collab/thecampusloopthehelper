/* OpenBench rules engine — no dependencies.
 * Runs in the browser (window.OB) and in Node (tests). All business rules live here:
 * eligibility, fair allocation, approvals, check-in/out, incidents, audit trail.
 * The UI (app.js) only calls these methods; every important action is written to a
 * hash-chained audit log. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
  const CFG = {
    NO_SHOW_GRACE_MIN: 30,     // minutes after start before an un-checked-in booking becomes a no-show
    EARLY_CHECKIN_MIN: 15,     // check-in opens this many minutes before start
    DELAY_INCIDENT_MIN: 15,    // returns later than this open a (reviewable) delay incident
    STRIKE_LIMIT: 3,           // reviewed strikes before an account is suspended
    REMINDER_MIN: 60,          // start reminder
    RETURN_REMINDER_MIN: 30,   // return reminder
    CREDENTIAL_DAYS: 365
  };
  const CATEGORIES = ['Fabrication', 'Electronics', 'Computing', 'Media', 'Space'];
  const MEMBERSHIPS = ['student', 'research', 'staff', 'community'];
  const RATINGS = ['excellent', 'good', 'fair', 'damaged'];
  const RANK = { excellent: 0, good: 1, fair: 2, damaged: 3 };
  const INCIDENT_TYPES = ['damage', 'delay', 'no_show', 'safety', 'conflict', 'other'];
  const DAYNAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---------- small helpers ----------
  const fail = m => { throw new Error(m); };
  const need = (x, m) => { if (!x) fail(m); return x; };
  const round1 = n => Math.round(n * 10) / 10;
  const round2 = n => Math.round(n * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const minOfDay = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
  const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const sameDay = (a, b) => startOfDay(a) === startOfDay(b);
  const weekStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const overlap = (a, b) => a.start < b.end && b.start < a.end;
  const fmtT = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const fmtD = ms => new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtDT = ms => fmtD(ms) + ', ' + fmtT(ms);
  const ymd = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const daysText = days => {
    const d = [...days].sort((a, b) => a - b);
    if (d.length === 7) return 'Every day';
    const contiguous = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
    return contiguous && d.length > 2 ? DAYNAMES[d[0]] + '–' + DAYNAMES[d[d.length - 1]] : d.map(x => DAYNAMES[x]).join(', ');
  };
  // cyrb53 — small non-cryptographic hash used for the demo audit chain & password check.
  function hash(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  const pwHash = (email, pw) => hash(String(email).toLowerCase() + '::' + pw, 7);
  const entryHash = (prev, e) => hash([prev, e.ts, e.actorId, e.action, e.detail, e.reason, e.bookingId || '', e.resourceId || '', e.subjectUserId || '', e.incidentId || ''].join('|')).toString(16);

  const STOP = new Set('the and for with need want use from have that this into some make get can would like for your our you are but not any all'.split(' '));
  const SYN = {
    print: ['3d printing'], printing: ['3d printing'], prototype: ['3d printing', 'electronics'], enclosure: ['3d printing'], plastic: ['3d printing'],
    cut: ['laser', 'cutting'], cutting: ['laser'], engrave: ['laser', 'engraving'], acrylic: ['laser'], wood: ['laser'],
    film: ['camera', 'video'], video: ['camera', 'video'], photo: ['camera', 'photography'], photos: ['camera'], record: ['camera', 'video'], shoot: ['camera'],
    meeting: ['meeting', 'room'], workshop: ['workshop', 'room'], present: ['presentation'], team: ['team', 'meeting'], seminar: ['seminar'],
    train: ['gpu', 'ml'], model: ['gpu', 'ml'], neural: ['gpu', 'ml'], learning: ['ml', 'deep learning'], ai: ['ai', 'gpu'], compute: ['compute', 'gpu'],
    debug: ['oscilloscope', 'debugging'], signal: ['signal', 'oscilloscope'], circuit: ['circuit', 'electronics'], sensor: ['electronics', 'circuit'], hardware: ['hardware', 'electronics']
  };

  class Engine {
    constructor(db, opts = {}) {
      this.db = db;
      this.onChange = opts.onChange || (() => {});
      this._now = opts.now || Date.now;
    }
    // ---------- clock (demo clock lets judges fast-forward time) ----------
    now() { return this._now() + (this.db.clockOffset || 0); }
    setNow(ms) { this.db.clockOffset = ms - this._now(); }
    save() { this.onChange(this.db); }
    uid(p) { this.db.seq = (this.db.seq || 1000) + 1; return p + this.db.seq; }

    // ---------- lookups ----------
    user(id) { return this.db.users.find(u => u.id === id); }
    res(id) { return this.db.resources.find(r => r.id === id); }
    bk(id) { return this.db.bookings.find(b => b.id === id); }
    inc(id) { return this.db.incidents.find(i => i.id === id); }
    name(id) { if (id === 'system') return 'System (automatic)'; const u = this.user(id); return u ? u.name : 'Unknown'; }
    training(id) { return this.db.trainings.find(t => t.id === id); }
    canManage(uid, r) { const u = this.user(uid); return !!u && !!r && (u.role === 'admin' || r.ownerId === uid || (r.managerIds || []).includes(uid)); }
    staffOf(r) { return [...new Set([r.ownerId, ...(r.managerIds || [])])]; }
    admins() { return this.db.users.filter(u => u.role === 'admin').map(u => u.id); }
    managedResources(uid) { return this.db.resources.filter(r => this.canManage(uid, r)); }
    isStaff(uid) { const u = this.user(uid); return !!u && (u.role === 'admin' || this.managedResources(uid).length > 0 || u.role === 'owner' || u.role === 'manager'); }
    isOverdue(b) { return b.status === 'checked_in' && this.now() > b.end; }

    // ---------- notifications & audit ----------
    notify(userId, text, link) {
      if (!userId || userId === 'system') return;
      this.db.notifications.push({ id: this.uid('n'), userId, ts: this.now(), text, link: link || '', read: false });
    }
    notifyStaff(r, text, link, exceptId) { this.staffOf(r).filter(i => i !== exceptId).forEach(i => this.notify(i, text, link)); }
    log(actorId, action, detail, refs = {}, reason = '') {
      const a = this.db.audit;
      const prev = a.length ? a[a.length - 1].hash : 'GENESIS';
      const e = Object.assign({ id: this.uid('a'), ts: this.now(), actorId, action, detail, reason, prev }, refs);
      e.hash = entryHash(prev, e);
      a.push(e);
      return e;
    }
    verifyAudit() {
      let prev = 'GENESIS';
      for (let i = 0; i < this.db.audit.length; i++) {
        const e = this.db.audit[i];
        if (e.prev !== prev || e.hash !== entryHash(prev, e)) return { valid: false, brokenAt: i, id: e.id, count: this.db.audit.length };
        prev = e.hash;
      }
      return { valid: true, count: this.db.audit.length };
    }
    addWhy(b, by, text) { b.why.push({ ts: this.now(), by, text }); }
    ledger(userId, delta, reason, bookingId) {
      if (!delta) return;
      const u = this.user(userId);
      u.credits = round2(u.credits + delta);
      this.db.ledger.push({ id: this.uid('l'), userId, ts: this.now(), delta, reason, bookingId: bookingId || null, balance: u.credits });
    }

    // ---------- accounts & verification ----------
    login(email, password) {
      const u = this.db.users.find(x => x.email === String(email || '').trim().toLowerCase());
      if (!u || u.pw !== pwHash(u.email, password || '')) fail('Incorrect email or password.');
      return u;
    }
    register(d) {
      const name = (d.name || '').trim(), email = (d.email || '').trim().toLowerCase();
      if (name.length < 2) fail('Please enter your full name.');
      if (!/^\S+@\S+\.\S+$/.test(email)) fail('Enter a valid email address.');
      if ((d.password || '').length < 6) fail('Password must be at least 6 characters.');
      if (this.db.users.some(u => u.email === email)) fail('An account with this email already exists.');
      if (!MEMBERSHIPS.includes(d.membership)) fail('Choose a membership type.');
      if ((d.idRef || '').trim().length < 3) fail('Enter your institutional ID or registration number so an administrator can verify you.');
      const u = {
        id: this.uid('u'), name, email, pw: pwHash(email, d.password), role: 'user', status: 'pending',
        org: (d.org || '').trim(), membership: d.membership, idRef: d.idRef.trim(), requestedRole: d.wantsOwner ? 'owner' : null,
        credits: { student: 40, research: 60, staff: 60, community: 25 }[d.membership], credentials: {}, strikes: 0, createdAt: this.now()
      };
      this.db.users.push(u);
      this.log(u.id, 'user.registered', `${name} registered (${d.membership})${d.wantsOwner ? ', requested owner role' : ''}`, { subjectUserId: u.id });
      this.admins().forEach(a => this.notify(a, `${name} is waiting for account verification.`, '#/admin'));
      this.save();
      return u;
    }
    verifyUser(actorId, userId, approve, reason) {
      need(this.user(actorId) && this.user(actorId).role === 'admin', 'Only administrators can verify accounts.');
      const u = need(this.user(userId), 'User not found.');
      if (u.status !== 'pending') fail('This account is not awaiting verification.');
      reason = (reason || '').trim();
      if (!approve && reason.length < 5) fail('Please give a short reason for rejecting the account.');
      u.status = approve ? 'verified' : 'rejected';
      if (approve && u.requestedRole === 'owner') u.role = 'owner';
      u.requestedRole = null;
      this.log(actorId, approve ? 'user.verified' : 'user.rejected', `${u.name} ${approve ? 'verified' : 'rejected'}`, { subjectUserId: u.id }, reason);
      this.notify(u.id, approve ? 'Your account has been verified. You can now request resources.' : 'Your account verification was rejected: ' + reason, '#/profile');
      this.save();
    }
    setRole(actorId, userId, role) {
      need(this.user(actorId) && this.user(actorId).role === 'admin', 'Only administrators can change roles.');
      if (!['user', 'owner', 'manager', 'admin'].includes(role)) fail('Unknown role.');
      const u = need(this.user(userId), 'User not found.');
      if (u.id === actorId && role !== 'admin') fail('You cannot remove your own administrator role.');
      u.role = role;
      this.log(actorId, 'user.role_changed', `${u.name} is now ${role}`, { subjectUserId: u.id });
      this.notify(u.id, `Your role was changed to ${role}.`, '#/profile');
      this.save();
    }
    grantCredits(actorId, userId, amount, reason) {
      need(this.user(actorId) && this.user(actorId).role === 'admin', 'Only administrators can grant credits.');
      amount = Number(amount);
      if (!(amount > 0 && amount <= 500)) fail('Enter an amount between 1 and 500.');
      if ((reason || '').trim().length < 5) fail('Please record why credits are being granted.');
      this.ledger(userId, amount, 'Institutional credit grant: ' + reason.trim());
      this.log(actorId, 'credits.granted', `${amount} credits to ${this.name(userId)}`, { subjectUserId: userId }, reason.trim());
      this.notify(userId, `${amount} credits were added to your account.`, '#/profile');
      this.save();
    }
    reinstateUser(actorId, userId, reason) {
      need(this.user(actorId) && this.user(actorId).role === 'admin', 'Only administrators can reinstate accounts.');
      const u = need(this.user(userId), 'User not found.');
      if (u.status !== 'suspended') fail('This account is not suspended.');
      if ((reason || '').trim().length < 5) fail('Please record the reason for reinstating the account.');
      u.status = 'verified'; u.suspendedFor = null; u.strikes = Math.min(u.strikes, CFG.STRIKE_LIMIT - 1);
      this.log(actorId, 'user.reinstated', `${u.name} reinstated`, { subjectUserId: u.id }, reason.trim());
      this.notify(u.id, 'Your account was reinstated by an administrator.', '#/profile');
      this.save();
    }
    syncSuspension(u, actorId) {
      if (u.strikes >= CFG.STRIKE_LIMIT && u.status === 'verified') {
        u.status = 'suspended'; u.suspendedFor = 'strikes';
        this.log('system', 'user.suspended', `${u.name} suspended after ${u.strikes} reviewed strikes (pending admin review)`, { subjectUserId: u.id });
        this.notify(u.id, 'Your account is suspended after repeated reviewed incidents. An administrator can review it.', '#/profile');
        this.admins().forEach(a => this.notify(a, `${u.name} was suspended after ${u.strikes} strikes.`, '#/admin'));
      } else if (u.strikes < CFG.STRIKE_LIMIT && u.status === 'suspended' && u.suspendedFor === 'strikes') {
        u.status = 'verified'; u.suspendedFor = null;
        this.log(actorId, 'user.reinstated', `${u.name} reinstated automatically (strike removed on review)`, { subjectUserId: u.id });
      }
    }

    // ---------- credential claims (training verification) ----------
    claimReviewers(trainingId) {
      const ids = new Set(this.admins());
      this.db.resources.filter(r => r.eligibility.trainings.includes(trainingId)).forEach(r => this.staffOf(r).forEach(i => ids.add(i)));
      return ids;
    }
    submitClaim(actorId, trainingId, evidence) {
      const u = need(this.user(actorId), 'Sign in first.');
      const t = need(this.training(trainingId), 'Choose a training.');
      if ((evidence || '').trim().length < 3) fail('Add a certificate number, receipt or reference so a reviewer can verify it.');
      if (this.db.claims.some(c => c.userId === actorId && c.trainingId === trainingId && c.status === 'pending')) fail('You already have a pending request for this training.');
      const c = { id: this.uid('c'), userId: actorId, trainingId, evidence: evidence.trim(), status: 'pending', createdAt: this.now() };
      this.db.claims.push(c);
      this.log(actorId, 'credential.submitted', `${u.name} submitted evidence for “${t.name}”`, { subjectUserId: actorId }, evidence.trim());
      this.claimReviewers(trainingId).forEach(i => this.notify(i, `${u.name} submitted training evidence: ${t.name}`, '#/manage'));
      this.save();
      return c;
    }
    reviewClaim(actorId, claimId, approve, reason) {
      const c = need(this.db.claims.find(x => x.id === claimId), 'Request not found.');
      if (!this.claimReviewers(c.trainingId).has(actorId)) fail('You are not a reviewer for this training.');
      if (c.status !== 'pending') fail('This request was already reviewed.');
      reason = (reason || '').trim();
      if (!approve && reason.length < 5) fail('Please explain why the evidence was not accepted.');
      c.status = approve ? 'approved' : 'rejected'; c.reviewedBy = actorId; c.reviewedAt = this.now(); c.reason = reason;
      const u = this.user(c.userId), t = this.training(c.trainingId);
      if (approve) u.credentials[c.trainingId] = { verifiedBy: actorId, verifiedAt: this.now(), expires: this.now() + CFG.CREDENTIAL_DAYS * DAY, evidence: c.evidence };
      this.log(actorId, approve ? 'credential.approved' : 'credential.rejected', `${t.name} for ${u.name}`, { subjectUserId: u.id }, reason);
      this.notify(u.id, approve ? `Your training “${t.name}” was verified.` : `Training evidence for “${t.name}” was not accepted: ${reason}`, '#/profile');
      this.save();
    }

    // ---------- resources ----------
    cleanResource(d) {
      const name = (d.name || '').trim();
      if (name.length < 3) fail('Resource name must be at least 3 characters.');
      if (!CATEGORIES.includes(d.category)) fail('Choose a category.');
      if ((d.location || '').trim().length < 3) fail('Add the location (building / room).');
      if ((d.description || '').trim().length < 10) fail('Add a description of at least 10 characters.');
      if ((d.rules || '').trim().length < 10) fail('Add usage rules / conditions (at least 10 characters).');
      const days = [...new Set((d.days || []).map(Number))].filter(x => x >= 0 && x <= 6).sort();
      if (!days.length) fail('Select at least one open day.');
      if (!/^\d{1,2}:\d{2}$/.test(d.start || '') || !/^\d{1,2}:\d{2}$/.test(d.end || '') || hm(d.start) >= hm(d.end)) fail('Opening time must be earlier than closing time.');
      const maxH = Number(d.maxHoursPerBooking), maxW = Number(d.maxHoursPerWeek), maxA = Number(d.maxActive), adv = Number(d.maxAdvanceDays || 14);
      if (!(maxH >= 0.5 && maxH <= 12)) fail('Max hours per booking must be between 0.5 and 12.');
      if (!(maxW >= maxH && maxW <= 80)) fail('Weekly cap per user must be at least the per-booking maximum.');
      if (!(Number.isInteger(maxA) && maxA >= 1 && maxA <= 5)) fail('Open requests per user must be 1–5.');
      if (!(Number.isInteger(adv) && adv >= 1 && adv <= 60)) fail('Advance booking window must be 1–60 days.');
      const cph = Number(d.creditsPerHour || 0), dep = Number(d.deposit || 0);
      if (!(cph >= 0 && cph <= 50)) fail('Credits per hour must be 0–50.');
      if (!(dep >= 0 && dep <= 200)) fail('Deposit must be 0–200 credits.');
      const trainings = (d.trainings || []).filter(t => this.training(t));
      const mem = (d.allowedMemberships || []).filter(m => MEMBERSHIPS.includes(m));
      const checklist = (d.checklist || []).map(s => String(s).trim()).filter(Boolean).slice(0, 8);
      return {
        name, category: d.category, kind: d.category === 'Space' ? 'space' : 'equipment', location: d.location.trim(),
        description: d.description.trim(), rules: d.rules.trim(), tags: (d.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 10),
        availability: { days, start: d.start, end: d.end }, limits: { maxHoursPerBooking: maxH, maxHoursPerWeek: maxW, maxActive: maxA, maxAdvanceDays: adv },
        creditsPerHour: cph, deposit: dep, eligibility: { trainings, allowedMemberships: mem },
        checklist: checklist.length ? checklist : ['Overall condition', 'All parts present'], requiresSupervision: !!d.requiresSupervision
      };
    }
    createResource(actorId, d) {
      const u = need(this.user(actorId), 'Sign in first.');
      if (!(u.role === 'owner' || u.role === 'admin') || u.status !== 'verified') fail('Only verified owners can list resources.');
      const r = Object.assign({ id: this.uid('r'), ownerId: actorId, managerIds: [], status: 'active', createdAt: this.now() }, this.cleanResource(d));
      this.db.resources.push(r);
      this.log(actorId, 'resource.listed', `${r.name} listed (${r.category}, ${r.location})`, { resourceId: r.id });
      this.save();
      return r;
    }
    updateResource(actorId, id, d) {
      const r = need(this.res(id), 'Resource not found.'), u = this.user(actorId);
      if (!(u.role === 'admin' || r.ownerId === actorId)) fail('Only the owner can edit this listing.');
      Object.assign(r, this.cleanResource(d));
      this.log(actorId, 'resource.updated', `${r.name} listing updated`, { resourceId: r.id });
      this.save();
      return r;
    }
    setResourceStatus(actorId, id, status, reason) {
      const r = need(this.res(id), 'Resource not found.');
      if (!this.canManage(actorId, r)) fail('Only staff of this resource can change its status.');
      if (!['active', 'paused', 'maintenance'].includes(status)) fail('Unknown status.');
      if (status !== 'active' && (reason || '').trim().length < 5) fail('Please give a reason (shown to users).');
      r.status = status; r.statusNote = status === 'active' ? '' : reason.trim();
      this.log(actorId, 'resource.status', `${r.name} is now ${status}`, { resourceId: r.id }, reason || '');
      if (status !== 'active') this.db.bookings.filter(b => b.resourceId === r.id && b.status === 'approved' && b.start > this.now())
        .forEach(b => this.notify(b.userId, `${r.name} is now ${status}: ${reason.trim()}. Staff may contact you about your booking.`, '#/booking/' + b.id));
      this.save();
    }
    addManager(actorId, resourceId, email) {
      const r = need(this.res(resourceId), 'Resource not found.');
      if (!(this.user(actorId).role === 'admin' || r.ownerId === actorId)) fail('Only the owner can assign managers.');
      const u = need(this.db.users.find(x => x.email === String(email || '').trim().toLowerCase()), 'No verified user with that email.');
      if (u.status !== 'verified') fail('That user is not verified yet.');
      if (u.id === r.ownerId || r.managerIds.includes(u.id)) fail('That user already manages this resource.');
      r.managerIds.push(u.id);
      if (u.role === 'user') u.role = 'manager';
      this.log(actorId, 'resource.manager_added', `${u.name} is now a manager of ${r.name}`, { resourceId: r.id, subjectUserId: u.id });
      this.notify(u.id, `You were assigned as manager of ${r.name}.`, '#/manage');
      this.save();
    }
    removeManager(actorId, resourceId, userId) {
      const r = need(this.res(resourceId), 'Resource not found.');
      if (!(this.user(actorId).role === 'admin' || r.ownerId === actorId)) fail('Only the owner can remove managers.');
      r.managerIds = r.managerIds.filter(i => i !== userId);
      this.log(actorId, 'resource.manager_removed', `${this.name(userId)} removed from ${r.name}`, { resourceId: r.id, subjectUserId: userId });
      this.save();
    }

    // ---------- discovery & matching ----------
    matchScore(r, terms) {
      let score = 0; const reasons = [];
      const hay = { tags: r.tags.join(' | '), name: r.name.toLowerCase(), desc: r.description.toLowerCase(), cat: (r.category + ' ' + r.location).toLowerCase() };
      for (const t of terms) {
        const variants = [t, ...(SYN[t] || [])]; let hit = 0;
        for (const v of variants) {
          if (hay.tags.includes(v)) hit = Math.max(hit, 3);
          else if (hay.name.includes(v)) hit = Math.max(hit, 2);
          else if (hay.desc.includes(v) || hay.cat.includes(v)) hit = Math.max(hit, 1);
        }
        if (hit) { score += hit; reasons.push(t); }
      }
      return { score, reasons };
    }
    search({ q = '', category = '', userId = null, onlyEligible = false } = {}) {
      const terms = (String(q).toLowerCase().match(/[a-z0-9+\-]{2,}/g) || []).filter(t => !STOP.has(t));
      let list = this.db.resources.filter(r => !category || r.category === category).map(r => {
        const m = this.matchScore(r, terms);
        return { resource: r, score: m.score, reasons: m.reasons, eligibility: userId ? this.eligibility(userId, r.id) : null };
      });
      if (terms.length) list = list.filter(x => x.score > 0);
      if (onlyEligible && userId) list = list.filter(x => x.eligibility.eligible);
      list.sort((a, b) => terms.length ? (b.score - a.score) || ((b.eligibility && b.eligibility.eligible) - (a.eligibility && a.eligibility.eligible)) : a.resource.name.localeCompare(b.resource.name));
      return list;
    }

    // ---------- eligibility & request checks ----------
    eligibility(userId, resourceId) {
      const u = this.user(userId), r = this.res(resourceId), now = this.now(), checks = [];
      const add = (key, label, pass, detail, fix) => checks.push({ key, label, pass: !!pass, detail, fix: pass ? '' : (fix || '') });
      add('verified', 'Verified account', u.status === 'verified',
        u.status === 'verified' ? 'Your identity was verified by the institution.' : u.status === 'pending' ? 'Waiting for administrator verification.' : u.status === 'suspended' ? 'Account suspended after reviewed incidents.' : 'Account not verified.',
        u.status === 'suspended' ? 'An administrator must review your suspension.' : 'An administrator must verify your account first.');
      add('open', 'Resource is accepting requests', r.status === 'active', r.status === 'active' ? 'Open for requests.' : `Currently ${r.status}${r.statusNote ? ': ' + r.statusNote : ''}.`, 'Check back when staff reopen it.');
      add('independent', 'Independent requester', !this.canManage(userId, r), 'You are not the owner or a manager of this resource.', 'Owners and managers cannot book their own resource (conflict of interest).');
      const mem = r.eligibility.allowedMemberships;
      if (mem.length) add('membership', 'Membership: ' + mem.join(' / '), mem.includes(u.membership), `Your membership is “${u.membership}”.`, `Limited to ${mem.join(' / ')} members.`);
      for (const tid of r.eligibility.trainings) {
        const t = this.training(tid), c = u.credentials[tid], valid = c && (!c.expires || c.expires > now);
        add('training:' + tid, 'Training: ' + t.name, valid,
          valid ? `Verified by ${this.name(c.verifiedBy)}, valid until ${fmtD(c.expires)}.` : c ? 'Your certification has expired.' : 'No verified record on your profile.',
          'Submit your certificate from Profile → Training & credentials for staff to verify.');
      }
      return { eligible: checks.every(c => c.pass), checks };
    }
    cost(r, start, end) { return Math.round((r.creditsPerHour * (end - start) / HOUR) * 2) / 2; }
    weekHours(userId, rid, start, excludeId) {
      const ws = weekStart(start);
      return round1(this.db.bookings.filter(b => b.userId === userId && b.resourceId === rid && b.id !== excludeId &&
        ['requested', 'approved', 'checked_in', 'returned', 'completed'].includes(b.status) && weekStart(b.start) === ws)
        .reduce((s, b) => s + (b.end - b.start) / HOUR, 0));
    }
    activeCount(userId, rid, excludeId) {
      const now = this.now();
      return this.db.bookings.filter(b => b.userId === userId && b.resourceId === rid && b.id !== excludeId && ['requested', 'waitlisted', 'approved'].includes(b.status) && b.end > now).length;
    }
    hoursUsed(userId, days) {
      const now = this.now();
      return round1(this.db.bookings.filter(b => b.userId === userId && ['completed', 'returned', 'checked_in'].includes(b.status) && b.start >= now - days * DAY && b.start <= now)
        .reduce((s, b) => s + (b.end - b.start) / HOUR, 0));
    }
    conflicts(rid, start, end, excludeId) {
      const slot = { start, end }, others = this.db.bookings.filter(b => b.resourceId === rid && b.id !== excludeId && overlap(b, slot));
      return { hard: others.filter(b => ['approved', 'checked_in'].includes(b.status)), soft: others.filter(b => b.status === 'requested') };
    }
    slotChecks(u, r, start, end, excludeId) {
      const now = this.now(), checks = [];
      const add = (key, label, pass, detail, fix) => checks.push({ key, label, pass: !!pass, detail, fix: pass ? '' : (fix || detail) });
      const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
      add('valid', 'Valid date and time', valid, 'Pick a date, start time and duration.', 'Pick a date, start time and duration.');
      if (!valid) return checks;
      const dur = (end - start) / HOUR, L = r.limits, av = r.availability;
      add('future', 'Starts in the future', start >= now, 'The start time has already passed.', 'Choose a later start time.');
      const one = sameDay(start, end - 1);
      add('sameday', 'Finishes the same day', one, 'Bookings cannot run past midnight.', 'Shorten the booking or choose an earlier start.');
      add('days', 'Open on ' + DAYNAMES[new Date(start).getDay()], av.days.includes(new Date(start).getDay()), 'Open ' + daysText(av.days) + '.', 'This resource is open ' + daysText(av.days) + '.');
      add('hours', `Within opening hours (${av.start}–${av.end})`, one && minOfDay(start) >= hm(av.start) && minOfDay(end) <= hm(av.end), `Opening hours are ${av.start}–${av.end}.`, `Choose a time between ${av.start} and ${av.end}.`);
      add('min', 'At least 30 minutes', dur >= 0.5, 'Minimum booking is 30 minutes.', 'Minimum booking is 30 minutes.');
      add('max', `At most ${L.maxHoursPerBooking} h per booking`, dur <= L.maxHoursPerBooking, `This resource allows up to ${L.maxHoursPerBooking} h per booking.`, `Reduce the duration to ${L.maxHoursPerBooking} h or less so others can use it.`);
      add('advance', `Within ${L.maxAdvanceDays} days from today`, start <= now + L.maxAdvanceDays * DAY, `Bookings open ${L.maxAdvanceDays} days ahead.`, `Choose a date within ${L.maxAdvanceDays} days.`);
      const used = this.weekHours(u.id, r.id, start, excludeId);
      add('weekly', `Fair-use weekly cap (${L.maxHoursPerWeek} h per person)`, used + dur <= L.maxHoursPerWeek, `You already hold ${used} h this week on this resource.`, `You already hold ${used} h this week; the cap is ${L.maxHoursPerWeek} h. Choose another week or a shorter slot.`);
      const n = this.activeCount(u.id, r.id, excludeId);
      add('active', `Open requests on this resource (${n}/${L.maxActive})`, n < L.maxActive, `You can hold up to ${L.maxActive} open requests here at a time.`, `You already have ${n} open request(s) here. Wait for one to finish or cancel one.`);
      const cost = this.cost(r, start, end);
      add('credits', `Credits: ${cost} + ${r.deposit} refundable deposit`, u.credits >= cost + r.deposit, `Your balance is ${u.credits}.`, `Your balance is ${u.credits} credits; ${round2(cost + r.deposit)} are needed.`);
      return checks;
    }
    previewRequest(userId, resourceId, start, end, excludeId) {
      const u = this.user(userId), r = this.res(resourceId);
      const eligibility = this.eligibility(userId, resourceId), slot = this.slotChecks(u, r, start, end, excludeId);
      const blockers = [...eligibility.checks, ...slot].filter(c => !c.pass).map(c => c.label + ' — ' + (c.fix || c.detail));
      const conflicts = Number.isFinite(start) && Number.isFinite(end) && end > start ? this.conflicts(r.id, start, end, excludeId) : { hard: [], soft: [] };
      let outcome = 'blocked'; const explanation = [];
      if (!blockers.length) {
        if (conflicts.hard.length) {
          outcome = 'waitlist';
          explanation.push('This time is already approved for another user, so your request will join the fair waitlist.');
          explanation.push('If the slot frees up (cancellation, no-show), the waitlisted request with the highest transparent priority score moves to owner review.');
        } else {
          outcome = 'review';
          explanation.push('You meet every requirement. Your request goes to the owner or manager for a decision.');
          if (conflicts.soft.length) explanation.push(`${conflicts.soft.length} other request(s) for this time are also waiting. The owner sees all of them with priority scores.`);
        }
        if (r.requiresSupervision) explanation.push('Staff supervision is required for this resource; a manager must be present.');
      }
      const cost = Number.isFinite(start) && Number.isFinite(end) ? this.cost(r, start, end) : 0;
      return { eligibility, slot, blockers, outcome, canSubmit: !blockers.length, explanation, conflictCount: { hard: conflicts.hard.length, soft: conflicts.soft.length }, cost, deposit: r.deposit };
    }
    busyBlocks(rid, from, to) {
      return this.db.bookings.filter(b => b.resourceId === rid && ['approved', 'checked_in', 'requested'].includes(b.status) && b.start < to && b.end > from)
        .map(b => ({ start: b.start, end: b.end, kind: b.status === 'requested' ? 'pending' : 'booked' }));
    }

    // ---------- fair allocation ----------
    priority(b) {
      const u = this.user(b.userId), now = this.now(), parts = [{ label: 'Base score', points: 50 }];
      const waited = Math.max(0, (now - b.createdAt) / DAY);
      parts.push({ label: `Waiting time: ${waited.toFixed(1)} days (+5 per day, max +25)`, points: round1(Math.min(25, waited * 5)) });
      const used = this.hoursUsed(u.id, 30);
      parts.push(used === 0 ? { label: 'No use in the last 30 days (fair-share bonus)', points: 15 }
        : { label: `Recent use: ${used} h in the last 30 days (−1.5 per hour, max −30)`, points: -round1(Math.min(30, used * 1.5)) });
      const first = !this.db.bookings.some(x => x.userId === u.id && x.resourceId === b.resourceId && x.id !== b.id && ['completed', 'returned', 'checked_in'].includes(x.status));
      if (first) parts.push({ label: 'First time on this resource (access bonus)', points: 10 });
      if (u.strikes) parts.push({ label: `Reviewed strikes: ${u.strikes} (−15 each)`, points: -15 * u.strikes });
      return { total: round1(parts.reduce((s, p) => s + p.points, 0)), parts };
    }
    waitlistPosition(b) {
      const rank = this.db.bookings.filter(x => x.resourceId === b.resourceId && x.status === 'waitlisted' && overlap(x, b))
        .map(x => ({ x, p: this.priority(x).total })).sort((a, c) => c.p - a.p || a.x.createdAt - c.x.createdAt);
      return rank.findIndex(r => r.x.id === b.id) + 1;
    }
    competitors(bookingId) {
      const b = this.bk(bookingId);
      return this.db.bookings.filter(x => x.id !== b.id && x.resourceId === b.resourceId && ['requested', 'waitlisted'].includes(x.status) && overlap(x, b))
        .map(x => ({ booking: x, priority: this.priority(x) })).sort((a, c) => c.priority.total - a.priority.total);
    }
    promoteWaitlist(rid) {
      const now = this.now(), r = this.res(rid), promoted = [];
      const ranked = this.db.bookings.filter(b => b.resourceId === rid && b.status === 'waitlisted' && !b.heldByOwner && b.start > now)
        .map(b => ({ b, p: this.priority(b) })).sort((a, c) => c.p.total - a.p.total || a.b.createdAt - c.b.createdAt);
      for (const { b, p } of ranked) {
        if (promoted.some(x => overlap(x, b))) continue;
        if (this.conflicts(rid, b.start, b.end, b.id).hard.length) continue;
        if (this.previewRequest(b.userId, rid, b.start, b.end, b.id).blockers.length) continue;
        b.status = 'requested';
        this.addWhy(b, 'system', `A slot opened up and your request had the highest waitlist priority (score ${p.total}), so it moved to owner review automatically.`);
        this.log('system', 'booking.promoted', `Waitlist → pending review (${r.name}, priority ${p.total})`, { bookingId: b.id, resourceId: rid, subjectUserId: b.userId });
        this.notify(b.userId, `Good news: a slot opened for ${r.name}. Your waitlisted request is now with the owner.`, '#/booking/' + b.id);
        this.notifyStaff(r, `Waitlisted request promoted for ${r.name} (${this.name(b.userId)}).`, '#/booking/' + b.id);
        promoted.push(b);
      }
      return promoted;
    }
    usageStats(userId) {
      const bs = this.db.bookings.filter(b => b.userId === userId);
      return {
        hours30: this.hoursUsed(userId, 30), total: bs.length,
        completed: bs.filter(b => ['completed', 'returned'].includes(b.status)).length,
        cancelled: bs.filter(b => b.status === 'cancelled').length, lateCancels: bs.filter(b => b.lateCancel).length,
        noShows: bs.filter(b => b.status === 'no_show').length, lateReturns: bs.filter(b => (b.lateMinutes || 0) > CFG.DELAY_INCIDENT_MIN).length,
        strikes: this.user(userId).strikes
      };
    }
    // Advisory, rule-based flags. Never applies a penalty: an administrator reviews them.
    integrityFlags() {
      const out = [];
      for (const u of this.db.users) {
        const s = this.usageStats(u.id), flags = [];
        if (s.total >= 3 && s.cancelled / s.total > 0.4) flags.push(`High cancellation rate: ${s.cancelled} of ${s.total} bookings cancelled.`);
        if (s.lateCancels >= 2) flags.push(`${s.lateCancels} late cancellations (under 24 h notice) — may be blocking slots.`);
        if (s.noShows >= 2) flags.push(`${s.noShows} no-shows.`);
        if (s.lateReturns >= 2) flags.push(`${s.lateReturns} late returns.`);
        if (s.hours30 >= 20) flags.push(`Heavy use: ${s.hours30} h in 30 days (possible monopolisation).`);
        const per = {}; this.db.bookings.filter(b => b.userId === u.id && ['completed', 'returned', 'checked_in'].includes(b.status) && b.start >= this.now() - 30 * DAY)
          .forEach(b => { per[b.resourceId] = (per[b.resourceId] || 0) + (b.end - b.start) / HOUR; });
        Object.entries(per).forEach(([rid, h]) => { if (h >= 12 && h / Math.max(s.hours30, 1) > 0.7) flags.push(`${round1(h)} h on ${this.res(rid).name} alone in 30 days.`); });
        if (flags.length) out.push({ userId: u.id, flags });
      }
      return out;
    }

    // ---------- booking lifecycle ----------
    requestBooking(actorId, d) {
      this.tick();
      const u = need(this.user(actorId), 'Sign in first.'), r = need(this.res(d.resourceId), 'Resource not found.');
      const purpose = (d.purpose || '').trim();
      if (purpose.length < 10) fail('Please describe what you will use it for (at least 10 characters) so the owner can review it.');
      const pre = this.previewRequest(actorId, r.id, d.start, d.end);
      if (!pre.canSubmit) fail('Request not allowed: ' + pre.blockers[0] + (pre.blockers.length > 1 ? ` (+${pre.blockers.length - 1} more)` : ''));
      const waitlist = pre.outcome === 'waitlist';
      const b = {
        id: this.uid('b'), resourceId: r.id, userId: actorId, start: d.start, end: d.end, purpose, status: waitlist ? 'waitlisted' : 'requested',
        createdAt: this.now(), cost: pre.cost, deposit: r.deposit, paid: false, depositState: 'none', why: [], checkIn: null, checkOut: null, incidentIds: [], lateCancel: false, lateMinutes: 0
      };
      this.db.bookings.push(b);
      pre.explanation.forEach(t => this.addWhy(b, 'system', t));
      if (waitlist) {
        const p = this.priority(b);
        this.addWhy(b, 'system', `Your waitlist priority score is ${p.total} (position ${this.waitlistPosition(b)}). See the breakdown below.`);
      }
      const win = `${r.name}: ${fmtDT(b.start)}–${fmtT(b.end)}`;
      this.log(actorId, 'booking.requested', win, { bookingId: b.id, resourceId: r.id, subjectUserId: actorId }, purpose);
      if (waitlist) this.log('system', 'booking.waitlisted', 'Slot already approved — placed on fair waitlist', { bookingId: b.id, resourceId: r.id, subjectUserId: actorId });
      this.notifyStaff(r, `${u.name} ${waitlist ? 'joined the waitlist for' : 'requested'} ${win}`, '#/booking/' + b.id);
      this.save();
      return b;
    }
    decideBooking(actorId, id, decision, reason) {
      this.tick();
      const b = need(this.bk(id), 'Booking not found.'), r = this.res(b.resourceId), actor = this.user(actorId);
      if (!this.canManage(actorId, r)) fail('Only the owner, an assigned manager or an administrator can decide on requests for this resource.');
      if (actorId === b.userId) fail('You cannot decide on your own request (conflict of interest).');
      reason = (reason || '').trim();
      const u = this.user(b.userId), win = `${r.name}, ${fmtDT(b.start)}–${fmtT(b.end)}`;
      if (decision === 'approve') {
        if (b.status !== 'requested') fail('Only pending requests can be approved.');
        const pre = this.previewRequest(b.userId, b.resourceId, b.start, b.end, b.id);
        if (pre.blockers.length) fail('Cannot approve: ' + pre.blockers[0]);
        if (pre.outcome === 'waitlist') fail('Cannot approve: this time is already approved for someone else.');
        reason = reason || 'Meets all eligibility and fair-use requirements.';
        this.ledger(u.id, -b.cost, 'Booking cost — ' + r.name, b.id);
        if (b.deposit) this.ledger(u.id, -b.deposit, 'Refundable deposit hold — ' + r.name, b.id);
        b.paid = true; b.depositState = b.deposit ? 'held' : 'none'; b.status = 'approved'; b.decidedBy = actorId; b.decidedAt = this.now();
        this.addWhy(b, actorId, `Approved by ${actor.name}: ${reason}`);
        this.log(actorId, 'booking.approved', win, { bookingId: b.id, resourceId: r.id, subjectUserId: u.id }, reason);
        this.notify(u.id, `Approved: ${win}. ${b.cost + b.deposit ? `${b.cost} credits charged, ${b.deposit} held as deposit.` : ''}`, '#/booking/' + b.id);
        const mine = this.priority(b).total;
        this.db.bookings.filter(x => x.id !== b.id && x.resourceId === r.id && x.status === 'requested' && overlap(x, b)).forEach(x => {
          x.status = 'waitlisted';
          const px = this.priority(x).total;
          this.addWhy(x, 'system', `Another request was approved for this time (${fmtT(b.start)}–${fmtT(b.end)}). Yours is now on the waitlist with priority ${px}; it will be reconsidered automatically if the slot frees up.`);
          this.log('system', 'booking.waitlisted', `Competing request approved — moved to waitlist (priority ${px}, approved request ${mine})`, { bookingId: x.id, resourceId: r.id, subjectUserId: x.userId });
          this.notify(x.userId, `${r.name}: another request got the slot. You're on the waitlist and will be reconsidered if it frees up.`, '#/booking/' + x.id);
        });
      } else if (decision === 'reject') {
        if (!['requested', 'waitlisted'].includes(b.status)) fail('Only pending or waitlisted requests can be rejected.');
        if (reason.length < 5) fail('Please give a reason so the requester understands the decision.');
        b.status = 'rejected'; b.decidedBy = actorId; b.decidedAt = this.now();
        this.addWhy(b, actorId, `Rejected by ${actor.name}: ${reason}`);
        this.log(actorId, 'booking.rejected', win, { bookingId: b.id, resourceId: r.id, subjectUserId: u.id }, reason);
        this.notify(u.id, `Not approved: ${win}. Reason: ${reason}`, '#/booking/' + b.id);
        this.promoteWaitlist(r.id);
      } else if (decision === 'waitlist') {
        if (b.status !== 'requested') fail('Only pending requests can be waitlisted.');
        if (reason.length < 5) fail('Please say why the request is being waitlisted.');
        b.status = 'waitlisted'; b.heldByOwner = true; b.decidedBy = actorId; b.decidedAt = this.now();
        this.addWhy(b, actorId, `Placed on the waitlist by ${actor.name}: ${reason}`);
        this.log(actorId, 'booking.waitlisted', win, { bookingId: b.id, resourceId: r.id, subjectUserId: u.id }, reason);
        this.notify(u.id, `Waitlisted: ${win}. Reason: ${reason}`, '#/booking/' + b.id);
      } else fail('Unknown decision.');
      this.save();
      return b;
    }
    refund(b, reasonText) {
      if (!b.paid) return;
      this.ledger(b.userId, b.cost, 'Refund — ' + reasonText, b.id);
      if (b.deposit) this.ledger(b.userId, b.deposit, 'Deposit returned — ' + reasonText, b.id);
      b.paid = false;
    }
    cancelBooking(actorId, id, reason) {
      this.tick();
      const b = need(this.bk(id), 'Booking not found.'), r = this.res(b.resourceId), actor = this.user(actorId);
      const byOwner = actorId === b.userId, byStaff = this.canManage(actorId, r);
      if (!byOwner && !byStaff) fail('Only the booking holder or staff can cancel.');
      if (!['requested', 'waitlisted', 'approved'].includes(b.status)) fail('This booking can no longer be cancelled.');
      reason = (reason || '').trim();
      if (!byOwner && reason.length < 5) fail('Please give the user a reason for cancelling their booking.');
      const hoursBefore = (b.start - this.now()) / HOUR;
      if (byOwner && b.status === 'approved' && hoursBefore < 24) b.lateCancel = true;
      const wasApproved = b.status === 'approved';
      if (wasApproved) { this.refund(b, 'booking cancelled'); b.depositState = b.deposit ? 'refunded' : 'none'; }
      b.status = 'cancelled'; b.cancelledBy = actorId;
      this.addWhy(b, actorId, byOwner ? `Cancelled by you${reason ? ': ' + reason : ''}.${b.lateCancel ? ' (Late cancellation, under 24 h notice — recorded for fair-use review.)' : ''}` : `Cancelled by ${actor.name}: ${reason}`);
      this.log(actorId, 'booking.cancelled', `${r.name}, ${fmtDT(b.start)}${b.lateCancel ? ' (late)' : ''}`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId }, reason);
      if (byOwner) this.notifyStaff(r, `${actor.name} cancelled ${r.name} (${fmtDT(b.start)}).`, '#/booking/' + b.id);
      else this.notify(b.userId, `Your booking for ${r.name} (${fmtDT(b.start)}) was cancelled by staff: ${reason}${wasApproved ? '. Credits were refunded.' : ''}`, '#/booking/' + b.id);
      this.promoteWaitlist(r.id);
      this.save();
      return b;
    }
    cleanCondition(r, c, actorId) {
      c = c || {};
      if (!RATINGS.includes(c.rating)) fail('Select a condition rating.');
      const notes = (c.notes || '').trim();
      if ((c.rating === 'fair' || c.rating === 'damaged') && notes.length < 5) fail('Please describe the condition in the notes (what, where, how bad).');
      const checklist = {}; r.checklist.forEach(i => { checklist[i] = !!(c.checklist && c.checklist[i]); });
      return { at: this.now(), by: actorId, rating: c.rating, checklist, notes, photo: c.photo || null };
    }
    openIncident(o) {
      const b = this.bk(o.bookingId), r = this.res(b.resourceId);
      const i = {
        id: this.uid('i'), bookingId: b.id, resourceId: r.id, userId: b.userId, type: o.type, severity: o.severity || 'low', description: o.description,
        reporterId: o.reporterId, auto: !!o.auto, preExisting: !!o.preExisting, status: 'open', thread: [], createdAt: this.now(), resolution: null, applied: { strike: false, forfeit: false }
      };
      this.db.incidents.push(i); b.incidentIds.push(i.id);
      this.log(o.reporterId, 'incident.reported', `${o.type}${o.preExisting ? ' (pre-existing)' : ''} — ${r.name}`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId, incidentId: i.id }, o.description);
      if (o.reporterId === b.userId) this.notifyStaff(r, `${this.name(b.userId)} reported an issue on ${r.name}: ${o.description.slice(0, 80)}`, '#/incident/' + i.id);
      else if (o.preExisting) this.notifyStaff(r, `Pre-existing damage was documented on ${r.name} at check-in.`, '#/incident/' + i.id);
      else this.notify(b.userId, `An incident was recorded on your booking (${r.name}). You can respond or dispute it.`, '#/incident/' + i.id);
      return i;
    }
    checkIn(actorId, id, cond) {
      this.tick();
      const b = need(this.bk(id), 'Booking not found.'), r = this.res(b.resourceId), now = this.now();
      if (!(actorId === b.userId || this.canManage(actorId, r))) fail('Only the booking holder or staff can check in.');
      if (b.status === 'no_show') fail(`This booking was marked as a no-show (no check-in within ${CFG.NO_SHOW_GRACE_MIN} minutes of the start).`);
      if (b.status !== 'approved') fail('Only approved bookings can be checked in.');
      if (now < b.start - CFG.EARLY_CHECKIN_MIN * MIN) fail(`Check-in opens ${CFG.EARLY_CHECKIN_MIN} minutes before the start time (${fmtDT(b.start)}).`);
      if (now > b.end) fail('This booking has already ended.');
      const prev = this.db.bookings.find(x => x.resourceId === r.id && x.status === 'checked_in' && x.id !== b.id);
      if (prev) { this.notifyStaff(r, `${this.name(b.userId)} is waiting: the previous session on ${r.name} has not been returned.`, '#/booking/' + prev.id); fail('The previous session has not been returned yet. Staff have been alerted.'); }
      b.checkIn = this.cleanCondition(r, cond, actorId);
      b.status = 'checked_in';
      this.addWhy(b, actorId, `Checked in. Initial condition recorded as “${b.checkIn.rating}”.`);
      this.log(actorId, 'booking.checked_in', `${r.name} — initial condition: ${b.checkIn.rating}`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId }, b.checkIn.notes);
      if (b.checkIn.rating === 'damaged' || b.checkIn.rating === 'fair' && /damag|broken|crack|missing/i.test(b.checkIn.notes))
        this.openIncident({ bookingId: b.id, type: 'damage', severity: 'medium', description: 'Pre-existing condition documented at check-in: ' + b.checkIn.notes, reporterId: actorId, preExisting: true });
      this.save();
      return b;
    }
    checkOut(actorId, id, cond) {
      this.tick();
      const b = need(this.bk(id), 'Booking not found.'), r = this.res(b.resourceId), now = this.now();
      if (!(actorId === b.userId || this.canManage(actorId, r))) fail('Only the booking holder or staff can return it.');
      if (b.status !== 'checked_in') fail('Only resources that are checked in can be returned.');
      b.checkOut = this.cleanCondition(r, cond, actorId);
      b.status = 'returned'; b.returnedAt = now; b.lateMinutes = Math.max(0, Math.round((now - b.end) / MIN));
      const worse = RANK[b.checkOut.rating] > RANK[b.checkIn.rating];
      b.conditionWorsened = worse;
      this.addWhy(b, actorId, `Returned. Final condition recorded as “${b.checkOut.rating}”${b.lateMinutes ? `, ${b.lateMinutes} min after the booked end` : ''}. Waiting for staff to confirm.`);
      this.log(actorId, 'booking.returned', `${r.name} — final condition: ${b.checkOut.rating}${b.lateMinutes ? `, ${b.lateMinutes} min late` : ''}`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId }, b.checkOut.notes);
      this.notifyStaff(r, `${this.name(b.userId)} returned ${r.name}${worse ? ` — condition changed from ${b.checkIn.rating} to ${b.checkOut.rating}` : ''}. Please confirm the return.`, '#/booking/' + b.id);
      if (b.lateMinutes > CFG.DELAY_INCIDENT_MIN)
        this.openIncident({ bookingId: b.id, type: 'delay', severity: 'low', description: `Returned ${b.lateMinutes} minutes after the booked end time. Automatically recorded for staff review — no penalty has been applied.`, reporterId: 'system', auto: true });
      this.save();
      return b;
    }
    confirmReturn(actorId, id, d = {}) {
      this.tick();
      const b = need(this.bk(id), 'Booking not found.'), r = this.res(b.resourceId);
      if (!this.canManage(actorId, r)) fail('Only staff of this resource can confirm returns.');
      if (actorId === b.userId) fail('You cannot confirm your own return.');
      if (b.status !== 'returned') fail('Only returned bookings can be confirmed.');
      b.status = 'completed'; b.confirmedBy = actorId; b.confirmedAt = this.now(); b.staffNotes = (d.notes || '').trim();
      this.addWhy(b, actorId, `Return confirmed by ${this.name(actorId)}${b.staffNotes ? ': ' + b.staffNotes : '.'}`);
      this.log(actorId, 'booking.completed', `${r.name} return confirmed`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId }, b.staffNotes);
      if (d.damage && (d.damage.description || '').trim().length >= 5)
        this.openIncident({ bookingId: b.id, type: 'damage', severity: d.damage.severity || 'medium', description: d.damage.description.trim(), reporterId: actorId });
      else if (d.damage) fail('Please describe the damage (at least 5 characters).');
      this.reconcileDeposit(b);
      this.notify(b.userId, `Return confirmed for ${r.name}.` + (b.depositState === 'held' ? ' Your deposit is held until the damage report is resolved.' : b.deposit ? ' Your deposit was returned.' : ''), '#/booking/' + b.id);
      this.promoteWaitlist(r.id);
      this.save();
      return b;
    }
    reconcileDeposit(b) {
      if (!b.deposit || !['completed', 'no_show'].includes(b.status) || !['held', 'released', 'forfeited'].includes(b.depositState)) return;
      const incs = b.incidentIds.map(i => this.inc(i));
      const forfeit = incs.some(i => i.applied.forfeit);
      const blocking = incs.some(i => i.type === 'damage' && !i.preExisting && i.status !== 'resolved');
      const cur = b.depositState; let next = cur;
      if (forfeit) next = 'forfeited'; else if (cur === 'held' && blocking) next = 'held'; else if (cur === 'held' || cur === 'forfeited') next = 'released';
      if (next === cur) return;
      if (cur === 'held' && next === 'released') this.ledger(b.userId, b.deposit, 'Deposit returned', b.id);
      else if (cur === 'released' && next === 'forfeited') this.ledger(b.userId, -b.deposit, 'Deposit forfeited after staff review', b.id);
      else if (cur === 'forfeited' && next === 'released') this.ledger(b.userId, b.deposit, 'Deposit restored after review', b.id);
      b.depositState = next;
    }

    // ---------- extensions ----------
    extensionChecks(b, r, newEnd) {
      const u = this.user(b.userId), L = r.limits, av = r.availability;
      if (!sameDay(b.start, newEnd - 1) || minOfDay(newEnd) > hm(av.end)) return `Cannot extend past closing time (${av.end}).`;
      if ((newEnd - b.start) / HOUR > L.maxHoursPerBooking) return `Cannot exceed ${L.maxHoursPerBooking} h per booking.`;
      const clash = this.conflicts(r.id, b.start, newEnd, b.id).hard[0];
      if (clash) return `Cannot extend: another booking starts at ${fmtT(clash.start)}.`;
      if (this.weekHours(u.id, r.id, b.start, b.id) + (newEnd - b.start) / HOUR > L.maxHoursPerWeek) return 'The extension would exceed your weekly fair-use cap.';
      if (b.paid && u.credits < this.cost(r, b.end, newEnd)) return 'Not enough credits for the extension.';
      return '';
    }
    requestExtension(actorId, id, minutes) {
      this.tick();
      const b = need(this.bk(id), 'Booking not found.'), r = this.res(b.resourceId);
      if (actorId !== b.userId) fail('Only the booking holder can request an extension.');
      if (!['approved', 'checked_in'].includes(b.status)) fail('Extensions are only possible for approved or in-use bookings.');
      minutes = Number(minutes);
      if (!(minutes >= 15 && minutes <= 120 && minutes % 15 === 0)) fail('Choose an extension of 15–120 minutes.');
      if (this.db.extensions.some(e => e.bookingId === id && e.status === 'pending')) fail('You already have a pending extension request for this booking.');
      const newEnd = b.end + minutes * MIN, err = this.extensionChecks(b, r, newEnd);
      if (err) fail(err);
      const e = { id: this.uid('x'), bookingId: id, minutes, newEnd, status: 'pending', createdAt: this.now() };
      this.db.extensions.push(e);
      this.addWhy(b, actorId, `Requested an extension of ${minutes} minutes (to ${fmtT(newEnd)}).`);
      this.log(actorId, 'extension.requested', `${r.name} +${minutes} min`, { bookingId: id, resourceId: r.id, subjectUserId: b.userId });
      this.notifyStaff(r, `${this.name(b.userId)} asked for ${minutes} more minutes on ${r.name}.`, '#/booking/' + id);
      this.save();
      return e;
    }
    decideExtension(actorId, extId, approve, reason) {
      const e = need(this.db.extensions.find(x => x.id === extId), 'Extension request not found.');
      const b = this.bk(e.bookingId), r = this.res(b.resourceId);
      if (!this.canManage(actorId, r)) fail('Only staff of this resource can decide on extensions.');
      if (e.status !== 'pending') fail('This extension was already decided.');
      reason = (reason || '').trim();
      if (!approve && reason.length < 5) fail('Please give a reason for declining the extension.');
      if (approve) {
        const err = this.extensionChecks(b, r, e.newEnd); if (err) fail(err);
        const extra = this.cost(r, b.end, e.newEnd);
        if (b.paid) { this.ledger(b.userId, -extra, 'Extension cost — ' + r.name, b.id); b.cost = round2(b.cost + extra); }
        b.end = e.newEnd; b.overdueNotified = false; b.remindedReturn = false;
      }
      e.status = approve ? 'approved' : 'rejected'; e.decidedBy = actorId; e.reason = reason;
      this.addWhy(b, actorId, approve ? `Extension of ${e.minutes} minutes approved by ${this.name(actorId)}.` : `Extension declined by ${this.name(actorId)}: ${reason}`);
      this.log(actorId, approve ? 'extension.approved' : 'extension.rejected', `${r.name} +${e.minutes} min`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId }, reason);
      this.notify(b.userId, approve ? `Extension approved: ${r.name} now ends at ${fmtT(b.end)}.` : `Extension declined: ${reason}`, '#/booking/' + b.id);
      this.save();
    }

    // ---------- incidents ----------
    reportIncident(actorId, bookingId, d) {
      const b = need(this.bk(bookingId), 'Booking not found.'), r = this.res(b.resourceId);
      if (!(actorId === b.userId || this.canManage(actorId, r))) fail('You cannot report incidents for this booking.');
      if (!INCIDENT_TYPES.includes(d.type)) fail('Choose an incident type.');
      if ((d.description || '').trim().length < 10) fail('Describe what happened (at least 10 characters).');
      const i = this.openIncident({ bookingId, type: d.type, severity: ['low', 'medium', 'high'].includes(d.severity) ? d.severity : 'medium', description: d.description.trim(), reporterId: actorId });
      this.save();
      return i;
    }
    respondIncident(actorId, id, text) {
      const i = need(this.inc(id), 'Incident not found.'), r = this.res(i.resourceId);
      if (!(actorId === i.userId || this.canManage(actorId, r))) fail('You cannot comment on this incident.');
      if ((text || '').trim().length < 3) fail('Write a short response.');
      i.thread.push({ ts: this.now(), by: actorId, text: text.trim() });
      this.log(actorId, 'incident.comment', `Comment on ${i.type} incident`, { bookingId: i.bookingId, resourceId: i.resourceId, subjectUserId: i.userId, incidentId: i.id }, text.trim());
      if (actorId === i.userId) this.notifyStaff(r, `${this.name(i.userId)} responded to an incident on ${r.name}.`, '#/incident/' + i.id);
      else this.notify(i.userId, `Staff commented on the incident on ${r.name}.`, '#/incident/' + i.id);
      this.save();
    }
    disputeIncident(actorId, id, reason) {
      const i = need(this.inc(id), 'Incident not found.');
      if (actorId !== i.userId) fail('Only the user concerned can dispute an incident.');
      if (!['open', 'resolved'].includes(i.status)) fail('This incident is already under appeal.');
      if ((reason || '').trim().length < 10) fail('Explain why you disagree (at least 10 characters).');
      i.status = 'disputed'; i.disputeReason = reason.trim();
      this.log(actorId, 'incident.disputed', `${i.type} incident disputed — escalated to administrator`, { bookingId: i.bookingId, resourceId: i.resourceId, subjectUserId: i.userId, incidentId: i.id }, reason.trim());
      this.admins().forEach(a => this.notify(a, `${this.name(actorId)} disputed an incident — your ruling is needed.`, '#/incident/' + i.id));
      this.notifyStaff(this.res(i.resourceId), `${this.name(actorId)} disputed an incident; it was escalated to an administrator.`, '#/incident/' + i.id);
      this.save();
    }
    resolveIncident(actorId, id, d) {
      const i = need(this.inc(id), 'Incident not found.'), b = this.bk(i.bookingId), r = this.res(i.resourceId), actor = this.user(actorId);
      if (!this.canManage(actorId, r)) fail('Only staff of this resource or an administrator can resolve incidents.');
      if (i.status === 'disputed' && actor.role !== 'admin') fail('This incident is under appeal. Only an administrator can rule on it.');
      if (actorId === i.userId) fail('You cannot resolve an incident about your own booking.');
      const note = (d.note || '').trim();
      if (note.length < 5) fail('Record the reasoning for this decision (at least 5 characters).');
      const next = { strike: !!d.strike, forfeit: !!d.forfeitDeposit };
      if (i.preExisting && (next.strike || next.forfeit)) fail('Damage documented at check-in as pre-existing cannot be penalised.');
      const u = this.user(i.userId), prev = i.applied;
      if (next.strike && !prev.strike) u.strikes++; else if (!next.strike && prev.strike) u.strikes = Math.max(0, u.strikes - 1);
      i.applied = next; i.status = 'resolved'; i.resolution = { by: actorId, at: this.now(), strike: next.strike, forfeit: next.forfeit, note };
      this.reconcileDeposit(b);
      this.syncSuspension(u, actorId);
      const outcome = next.strike || next.forfeit ? [next.strike ? 'strike recorded' : '', next.forfeit ? 'deposit forfeited' : ''].filter(Boolean).join(' + ') : 'no penalty';
      this.log(actorId, 'incident.resolved', `${i.type} incident resolved: ${outcome}`, { bookingId: b.id, resourceId: r.id, subjectUserId: u.id, incidentId: i.id }, note);
      this.notify(u.id, `Incident on ${r.name} resolved (${outcome}). ${note}. You can dispute this decision.`, '#/incident/' + i.id);
      this.save();
    }

    // ---------- time-driven events ----------
    tick() {
      const now = this.now(); let changed = false;
      for (const b of this.db.bookings) {
        const r = this.res(b.resourceId); if (!r) continue;
        if (b.status === 'approved') {
          if (now > b.start + CFG.NO_SHOW_GRACE_MIN * MIN) {
            b.status = 'no_show';
            this.refund(b, 'no-show (credits returned; staff will review)'); b.depositState = b.deposit ? 'released' : 'none';
            this.addWhy(b, 'system', `No check-in within ${CFG.NO_SHOW_GRACE_MIN} minutes of the start time, so the slot was released for others. Credits were refunded; staff will review before any penalty.`);
            this.log('system', 'booking.no_show', `${r.name}, ${fmtDT(b.start)} — slot released`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId });
            this.openIncident({ bookingId: b.id, type: 'no_show', severity: 'low', description: `Not checked in within ${CFG.NO_SHOW_GRACE_MIN} minutes of the start time. Automatically recorded for staff review — no penalty has been applied.`, reporterId: 'system', auto: true });
            this.notify(b.userId, `Your booking for ${r.name} was released after no check-in. Credits were refunded.`, '#/booking/' + b.id);
            this.promoteWaitlist(r.id); changed = true; continue;
          }
          if (!b.remindedStart && b.start - now <= CFG.REMINDER_MIN * MIN) { b.remindedStart = true; this.notify(b.userId, `Reminder: ${r.name} starts at ${fmtT(b.start)}. Check-in opens ${CFG.EARLY_CHECKIN_MIN} minutes before.`, '#/booking/' + b.id); changed = true; }
          if (!b.delayNotified && now >= b.start && this.db.bookings.some(x => x.resourceId === r.id && x.status === 'checked_in' && x.end < now && x.start < b.start)) {
            b.delayNotified = true;
            this.notify(b.userId, `The previous session on ${r.name} has not been returned yet. Staff were alerted and will help you start.`, '#/booking/' + b.id);
            this.notifyStaff(r, `Scheduling conflict: the previous session on ${r.name} is overdue and ${this.name(b.userId)} is waiting.`, '#/booking/' + b.id);
            this.log('system', 'booking.conflict', `Overdue return is delaying the next booking on ${r.name}`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId }); changed = true;
          }
        } else if (b.status === 'checked_in') {
          if (now > b.end && !b.overdueNotified) {
            b.overdueNotified = true;
            this.notify(b.userId, `Overdue: please return ${r.name} now (was due ${fmtT(b.end)}).`, '#/booking/' + b.id);
            this.notifyStaff(r, `Overdue: ${this.name(b.userId)} has not returned ${r.name} (due ${fmtT(b.end)}).`, '#/booking/' + b.id);
            this.log('system', 'booking.overdue', `${r.name} overdue since ${fmtT(b.end)}`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId }); changed = true;
          } else if (!b.remindedReturn && now <= b.end && b.end - now <= CFG.RETURN_REMINDER_MIN * MIN) {
            b.remindedReturn = true; this.notify(b.userId, `Reminder: please return ${r.name} by ${fmtT(b.end)}.`, '#/booking/' + b.id); changed = true;
          }
        } else if ((b.status === 'requested' || b.status === 'waitlisted') && now >= b.start) {
          const was = b.status; b.status = 'expired';
          this.addWhy(b, 'system', was === 'requested' ? 'The owner did not review this request before it was due to start, so it expired. Nothing was charged.' : 'The time passed while you were on the waitlist, so the request expired. Nothing was charged.');
          this.log('system', 'booking.expired', `${r.name}, ${fmtDT(b.start)} — ${was} request expired`, { bookingId: b.id, resourceId: r.id, subjectUserId: b.userId });
          this.notify(b.userId, `Your ${was === 'requested' ? 'unreviewed request' : 'waitlisted request'} for ${r.name} expired.`, '#/booking/' + b.id); changed = true;
        }
      }
      if (changed) this.save();
      return changed;
    }

    // ---------- views for the UI ----------
    visibleBookings(userId) {
      const u = this.user(userId);
      return this.db.bookings.filter(b => b.userId === userId || u.role === 'admin' || this.canManage(userId, this.res(b.resourceId))).sort((a, b) => b.start - a.start);
    }
    auditFor(viewerId, f = {}) {
      const v = this.user(viewerId), managed = new Set(this.managedResources(viewerId).map(r => r.id)), q = (f.q || '').toLowerCase();
      return this.db.audit.filter(e => v.role === 'admin' || e.actorId === viewerId || e.subjectUserId === viewerId || (e.resourceId && managed.has(e.resourceId)))
        .filter(e => !f.bookingId || e.bookingId === f.bookingId).filter(e => !f.incidentId || e.incidentId === f.incidentId)
        .filter(e => !q || (e.action + ' ' + e.detail + ' ' + e.reason + ' ' + this.name(e.actorId)).toLowerCase().includes(q)).slice().reverse();
    }
    visibleIncidents(userId) {
      const u = this.user(userId);
      return this.db.incidents.filter(i => i.userId === userId || u.role === 'admin' || this.canManage(userId, this.res(i.resourceId))).sort((a, b) => b.createdAt - a.createdAt);
    }
  }

  // ---------- demo data ----------
  function emptyDB() {
    return { v: 1, seq: 1000, clockOffset: 0, users: [], resources: [], bookings: [], incidents: [], audit: [], notifications: [], claims: [], extensions: [], ledger: [], trainings: [] };
  }
  function seedEngine(opts = {}) {
    const db = emptyDB(), eng = new Engine(db, Object.assign({}, opts, { onChange: () => {} })), real = eng._now();
    const D = (daysAgo, h, m = 0) => { const d = new Date(real); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime(); };
    const at = ms => eng.setNow(ms);
    db.trainings = [
      { id: 't_3dp', name: 'FDM 3D Printer Safety & Operation' }, { id: 't_laser', name: 'Laser Cutter Safety Certification' },
      { id: 't_cam', name: 'Camera & Studio Basics' }, { id: 't_scope', name: 'Bench Electronics & Oscilloscope Safety' }
    ];
    const mk = (id, name, email, role, membership, org, credits, trainings = []) => {
      const credentials = {};
      trainings.forEach(t => { credentials[t] = { verifiedBy: 'u_admin', verifiedAt: real - 40 * DAY, expires: real + 300 * DAY, evidence: 'Seeded demo record' }; });
      db.users.push({ id, name, email, pw: pwHash(email, 'demo123'), role, status: 'verified', org, membership, idRef: 'DEMO-' + id.slice(2).toUpperCase(), requestedRole: null, credits, credentials, strikes: 0, createdAt: real - 60 * DAY });
    };
    mk('u_admin', 'Dr. Kavya Menon', 'admin@demo.edu', 'admin', 'staff', 'Office of Research & Innovation', 100);
    mk('u_rao', 'Prof. Arjun Rao', 'owner@demo.edu', 'owner', 'staff', 'Electronics & Computing Dept.', 100);
    mk('u_farah', 'Ms. Farah Khan', 'owner.media@demo.edu', 'owner', 'staff', 'Makerspace & Media Lab', 100);
    mk('u_ravi', 'Ravi Nair (Lab Technician)', 'manager@demo.edu', 'manager', 'staff', 'Makerspace & Media Lab', 100);
    mk('u_ananya', 'Ananya Iyer', 'ananya@demo.edu', 'user', 'student', 'B.Tech Mechanical, Year 3', 40, ['t_3dp', 't_laser']);
    mk('u_rahul', 'Rahul Verma', 'rahul@demo.edu', 'user', 'student', 'B.Sc Physics, Year 2', 40);
    mk('u_sneha', 'Dr. Sneha Pillai', 'sneha@demo.edu', 'user', 'research', 'AI Research Group', 140, ['t_scope', 't_3dp']);
    mk('u_imran', 'Imran Sheikh', 'imran@demo.edu', 'user', 'community', 'Early-stage startup (community member)', 120, ['t_3dp', 't_laser', 't_cam']);
    db.users.push({ id: 'u_neha', name: 'Neha Das', email: 'neha@demo.edu', pw: pwHash('neha@demo.edu', 'demo123'), role: 'user', status: 'pending', org: 'M.Des Design, Year 1', membership: 'student', idRef: 'DEMO-NEHA', requestedRole: null, credits: 40, credentials: {}, strikes: 0, createdAt: real - 2 * HOUR });

    at(D(30, 9));
    const base = { days: [], start: '', end: '', maxActive: 2, maxAdvanceDays: 14, trainings: [], allowedMemberships: [] };
    const R = {};
    R.printer = eng.createResource('u_farah', Object.assign({}, base, {
      name: 'Prusa MK4 3D Printer Bay', category: 'Fabrication', location: 'Makerspace · Block C, Room 104',
      description: 'Two calibrated FDM printers (PLA/PETG) with a slicing workstation. Ideal for prototypes, enclosures and fixtures.',
      rules: 'Use institute filament or log your own. Never leave a print unattended for more than 10 minutes. Remove all waste and clean the bed before returning. No ABS or nylon.',
      tags: ['3d printing', 'prototype', 'enclosure', 'cad', 'plastic', 'fabrication'], days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00',
      maxHoursPerBooking: 4, maxHoursPerWeek: 8, creditsPerHour: 2, deposit: 5, trainings: ['t_3dp'], checklist: ['Print bed clean and level', 'Nozzle free of residue', 'No filament waste left behind', 'Enclosure and cables intact']
    }));
    R.laser = eng.createResource('u_farah', Object.assign({}, base, {
      name: '80W CO2 Laser Cutter', category: 'Fabrication', location: 'Makerspace · Block C, Room 106',
      description: 'Cuts and engraves acrylic, plywood and card up to 600×400 mm. Scarce, high-demand resource with staff supervision.',
      rules: 'Staff supervision required. Closed-toe shoes, extraction fan on at all times, never leave the machine running unattended. Approved materials only (no PVC, no unlabelled plastics).',
      tags: ['laser', 'cutting', 'engraving', 'acrylic', 'wood', 'fabrication'], days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '17:00',
      maxHoursPerBooking: 3, maxHoursPerWeek: 6, maxActive: 1, creditsPerHour: 4, deposit: 10, trainings: ['t_laser'], requiresSupervision: true,
      checklist: ['Lens clean', 'Bed free of debris', 'Extraction filter OK', 'Machine powered down']
    }));
    R.camera = eng.createResource('u_farah', Object.assign({}, base, {
      name: 'Mirrorless Camera Kit (A7 + 2 lenses)', category: 'Media', location: 'Media Lab · Block D, Equipment Cage',
      description: 'Full-frame mirrorless body, 24-70 mm and 50 mm lenses, tripod, two batteries and a 128 GB card. Same-day loan.',
      rules: 'Return same day with batteries charged and card handed over for copying. Use the rain cover outdoors. Never change lenses in dusty or wet conditions.',
      tags: ['camera', 'video', 'photography', 'film', 'shoot', 'media'], days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '17:00',
      maxHoursPerBooking: 6, maxHoursPerWeek: 12, creditsPerHour: 1, deposit: 20, trainings: ['t_cam'], checklist: ['Body and screen undamaged', 'Both lenses clean', 'Tripod complete', 'Batteries and card present']
    }));
    R.room = eng.createResource('u_rao', Object.assign({}, base, {
      name: 'Seminar Room B-204 (30 seats)', category: 'Space', location: 'Block B, Room 204',
      description: 'Projector, whiteboards and movable seating for workshops, team meetings and student clubs.',
      rules: 'Leave the room as you found it. Switch off the projector and lights. No food near the AV desk. Maximum 30 people.',
      tags: ['meeting', 'workshop', 'seminar', 'presentation', 'team', 'room', 'space'], days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '20:00',
      maxHoursPerBooking: 3, maxHoursPerWeek: 9, creditsPerHour: 0, deposit: 0, checklist: ['Furniture reset', 'Projector off', 'Whiteboards clean', 'No litter']
    }));
    R.scope = eng.createResource('u_rao', Object.assign({}, base, {
      name: 'Oscilloscope Bench (4-channel, 200 MHz)', category: 'Electronics', location: 'Electronics Lab · Block A, Bench 6',
      description: 'Bench with a 4-channel digital oscilloscope, function generator and regulated supplies for circuit debugging.',
      rules: 'Use isolated probes on mains-referenced circuits. Report any probe damage immediately. Power supplies off and probes stowed when you leave.',
      tags: ['oscilloscope', 'electronics', 'circuit', 'signal', 'debugging', 'hardware'], days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00',
      maxHoursPerBooking: 4, maxHoursPerWeek: 8, creditsPerHour: 2, deposit: 15, trainings: ['t_scope'], checklist: ['Probes complete (x4)', 'Screen and knobs intact', 'Supplies off', 'Bench clear']
    }));
    R.gpu = eng.createResource('u_rao', Object.assign({}, base, {
      name: 'GPU Workstation (RTX 4090, 64 GB RAM)', category: 'Computing', location: 'Computing Lab · Block A, Room 12',
      description: 'High-end workstation for model training, rendering and simulation. Reserved for research and staff members to protect scarce capacity.',
      rules: 'Save work to your own storage; the disk is wiped weekly. No crypto-mining, no personal data on the machine. Log off when finished.',
      tags: ['gpu', 'ml', 'ai', 'deep learning', 'training', 'compute', 'rendering'], days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '22:00',
      maxHoursPerBooking: 6, maxHoursPerWeek: 12, creditsPerHour: 3, deposit: 0, allowedMemberships: ['research', 'staff'], checklist: ['Desktop clean', 'Machine responsive', 'Peripherals present']
    }));
    ['printer', 'laser', 'camera'].forEach(k => eng.addManager('u_farah', R[k].id, 'manager@demo.edu'));

    // history, simulated by driving the real engine with a moving clock (so the audit trail is authentic)
    const pastSession = (userId, r, daysAgo, startH, hours, o = {}) => {
      let da = daysAgo; while (!r.availability.days.includes(new Date(D(da, 12)).getDay())) da++;
      const s = D(da, startH), e = s + hours * HOUR, staff = r.ownerId;
      const form = rating => ({ rating, checklist: Object.fromEntries(r.checklist.map(i => [i, true])), notes: rating === 'good' || rating === 'excellent' ? '' : 'See notes' });
      at(s - 20 * HOUR); const b = eng.requestBooking(userId, { resourceId: r.id, start: s, end: e, purpose: o.purpose || 'Coursework project build session' });
      at(s - 18 * HOUR); eng.decideBooking(staff, b.id, 'approve', '');
      at(s - 3 * MIN); eng.checkIn(userId, b.id, form('good'));
      at(o.lateMin ? e + o.lateMin * MIN : e - 5 * MIN); eng.checkOut(userId, b.id, form(o.out || 'good'));
      if (o.confirm !== false) { at(e + (o.lateMin || 0) * MIN + 25 * MIN); eng.confirmReturn(staff, b.id, {}); }
      return b;
    };
    pastSession('u_imran', R.laser, 13, 10, 3, { purpose: 'Cutting acrylic panels for a product demo unit' });
    pastSession('u_sneha', R.gpu, 12, 9, 6, { purpose: 'Training a vision model for the lab project' });
    pastSession('u_ananya', R.printer, 14, 10, 4, { purpose: 'Printing gearbox housing prototypes' });
    pastSession('u_imran', R.laser, 9, 10, 3, { purpose: 'Second batch of enclosure panels for pilot customers' });
    pastSession('u_sneha', R.gpu, 8, 9, 6, { purpose: 'Fine-tuning run for the lab project' });
    pastSession('u_rahul', R.room, 5, 15, 2, { purpose: 'Physics society study session' });
    pastSession('u_imran', R.laser, 6, 13, 3, { purpose: 'Engraving brand plates for pilot units' });
    const late = pastSession('u_ananya', R.printer, 7, 10, 2, { lateMin: 22, purpose: 'Printing bracket prototypes for the robotics team' });
    const lateInc = db.incidents.find(i => i.bookingId === late.id);
    if (lateInc) { at(D(6, 9)); eng.resolveIncident('u_ravi', lateInc.id, { strike: false, forfeitDeposit: false, note: 'Print finished late and the student told staff in advance. No penalty.' }); }
    pastSession('u_sneha', R.gpu, 3, 9, 6, { purpose: 'Evaluation runs and benchmarking' });
    pastSession('u_imran', R.camera, 1, 10, 4, { confirm: false, purpose: 'Shooting a product walkthrough video for the startup' });

    // present day: back to real time
    db.clockOffset = 0;
    const open = (r, from, h) => { let d = from; while (!r.availability.days.includes(new Date(D(-d, 12)).getDay())) d++; return D(-d, h); };
    const s1 = open(R.laser, 1, 10);
    const b1 = eng.requestBooking('u_imran', { resourceId: R.laser.id, start: s1, end: s1 + 2 * HOUR, purpose: 'Cutting the final batch of acrylic housings for customer pilots' });
    eng.decideBooking('u_ravi', b1.id, 'approve', 'Certified, within fair-use limits, supervised by Ravi.');
    const s2 = open(R.gpu, 1, 14);
    eng.requestBooking('u_sneha', { resourceId: R.gpu.id, start: s2, end: s2 + 4 * HOUR, purpose: 'Final training run for the conference paper experiments' });
    const s3 = open(R.printer, 2, 10);
    eng.requestBooking('u_ananya', { resourceId: R.printer.id, start: s3, end: s3 + 3 * HOUR, purpose: 'Printing the enclosure for my capstone sensor board' });
    eng.submitClaim('u_rahul', 't_3dp', 'Makerspace workshop receipt WS-2291');
    // only the notifications from "now" stay unread
    db.notifications.forEach(n => { if (n.ts < real - 60e3) n.read = true; });
    eng.onChange = opts.onChange || (() => {});
    return eng;
  }

  return { Engine, seedEngine, emptyDB, CFG, CATEGORIES, MEMBERSHIPS, RATINGS, INCIDENT_TYPES, DAYNAMES, MIN, HOUR, DAY, fmtT, fmtD, fmtDT, ymd, daysText, startOfDay, minOfDay, hm, pad, hash, weekStart, round1 };
});
