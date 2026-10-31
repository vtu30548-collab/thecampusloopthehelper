/* OpenBench front-end: vanilla JS single-page app. All dynamic text passes through esc(). */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = { user: null, meta: { tz: 'Asia/Kolkata', demo: true, categories: [], memberTypes: [] } };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } } };

async function api(path, o = {}) {
  const t = store.get('ob_token');
  const r = await fetch('/api' + path, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && t) { store.set('ob_token', null); S.user = null; location.hash = '#/login'; }
  if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.data = j; throw e; }
  return j;
}
function toast(m, bad) { const t = $('#toast'); t.textContent = m; t.style.background = bad ? 'var(--red)' : ''; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3800); }

// ---------- formatting ----------
const dtf = () => new Intl.DateTimeFormat('en-IN', { timeZone: S.meta.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const dt = ts => ts ? dtf().format(new Date(ts)) : '-';
const lp = ts => { const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: S.meta.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts)).forEach(x => p[x.type] = x.value); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, hm: `${p.hour}:${p.minute}` }; };
const tm = ts => lp(ts).hm;
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const label = s => String(s || '').replace(/_/g, ' ');
const chip = (s, t) => `<span class="chip ${esc(s)}">${esc(t || label(s))}</span>`;
const money = n => 'INR ' + Number(n).toLocaleString('en-IN');
const isMgr = () => S.user && (S.user.manages || S.user.role === 'admin');
const todayStr = () => lp(Date.now()).date;

// ---------- shell ----------
function renderTop() {
  const u = S.user, h = location.hash || '#/';
  const nav = (href, text) => `<a href="${href}" class="${h.startsWith(href) ? 'on' : ''}">${text}</a>`;
  $('#top').innerHTML = `<a class="brand" href="#/"><i></i>OpenBench</a><nav aria-label="Main">${u ? nav('#/discover', 'Discover') + nav('#/bookings', 'My bookings') + (isMgr() ? nav('#/manage', 'Manage') : '') + (u.role === 'admin' ? nav('#/admin', 'Admin') : '') : ''}${nav('#/guide', 'Judge guide')}</nav>
  ${u ? `<div class="user"><div class="who"><b>${esc(u.name)}</b><br><small>${esc(label(u.role))} ${chip(u.status)}</small></div><button class="bell" data-act="bell" aria-label="Notifications">🔔${u.unread ? `<b>${u.unread}</b>` : ''}</button><button class="btn ghost sm" data-act="logout">Sign out</button></div><div id="notif" role="dialog" aria-label="Notifications"></div>` : `<a class="btn sm" href="#/login">Sign in</a>`}`;
}
async function loadUser() { if (!store.get('ob_token')) { S.user = null; return; } try { S.user = await api('/me'); } catch { S.user = null; } }

// ---------- router ----------
const routes = [[/^#\/login$/, pgLogin], [/^#\/guide$/, pgGuide], [/^#\/discover$/, pgDiscover], [/^#\/resource\/(\d+)$/, pgResource], [/^#\/bookings$/, pgBookings], [/^#\/booking\/(\d+)$/, pgBooking], [/^#\/manage$/, pgManage], [/^#\/resource-edit\/(\d+|new)$/, pgResEdit], [/^#\/admin$/, pgAdmin]];
async function route() {
  const h = location.hash || '#/';
  if (h === '#/' || h === '#') return (location.hash = S.user ? '#/discover' : '#/login');
  await loadUser(); renderTop();
  const app = $('#app');
  if (!S.user && !['#/login', '#/guide'].includes(h)) return (location.hash = '#/login');
  for (const [re, fn] of routes) { const m = h.match(re); if (m) { app.innerHTML = '<p class="empty">Loading...</p>'; try { app.innerHTML = await fn(...m.slice(1)); } catch (e) { app.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; } window.scrollTo(0, 0); return; } }
  app.innerHTML = '<div class="empty">Page not found. <a href="#/discover">Go to Discover</a></div>';
}
window.addEventListener('hashchange', route);

// ---------- pages ----------
const DEMOS = [
  ['ananya', 'Ananya Sharma', 'Student, laser-certified', 'Book the laser cutter, check eligibility, see fairness scores'],
  ['owner.media', 'Dr. Kavita Nair', 'Resource owner (Media & Computing)', 'List resources, approve auto-approved rooms, review incidents'],
  ['manager', 'Rohan Das', 'Fab Lab manager', 'Approve/waitlist requests, check users in on site, confirm returns'],
  ['admin', 'Dr. Meera Iyer', 'Administrator', 'Verify identities, audit trail integrity, fair-use watch, appeals'],
  ['vikram', 'Vikram Singh', 'Startup founder (needs training)', 'See blocked booking + request training'],
  ['tom', 'Tom Becker', 'Community member (unverified)', 'See identity-verification gate'],
];
async function pgLogin() {
  S.meta = await api('/meta');
  return `<div class="hero"><section class="stack"><h1>Unlock the labs, tools and rooms your campus isn't using.</h1>
  <p style="font-size:1.1rem">OpenBench lets institutions share spaces and equipment with <b>verified</b> people - with training checks, human approval, <b>fair allocation</b>, before/after condition records and a <b>tamper-evident audit trail</b>.</p>
  <div class="card"><h3>Judge quick start - one click, no passwords</h3><p class="muted">All demo accounts use password <code>demo1234</code>. Sign in as any role:</p><div class="demo">${DEMOS.map(d => `<button data-act="quick" data-email="${d[0]}@openbench.demo"><b>${esc(d[1])} - <span class="muted">${esc(d[2])}</span></b><small>${esc(d[3])}</small></button>`).join('')}</div>
  <p><a href="#/guide">Read the 10-step judge walkthrough →</a></p></div></section>
  <section class="card"><div class="tabs"><button class="on" data-act="authtab" data-t="in">Sign in</button><button data-act="authtab" data-t="up">Create account</button></div>
  <form data-form="login" id="f-in" class="stack"><div><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username"></div><div><label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password"></div><div class="err"></div><button class="btn">Sign in</button></form>
  <form data-form="register" id="f-up" class="stack" hidden><div><label>Full name</label><input name="name" required></div><div><label>Email</label><input name="email" type="email" required></div><div><label>Password (8+ characters)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
  <div class="fields"><div><label>Member type</label><select name="member_type">${S.meta.memberTypes.map(t => `<option>${t}</option>`).join('')}</select></div><div><label>Organisation</label><input name="org"></div></div><div><label>Institutional ID / reference</label><input name="id_number"></div>
  <p class="muted" style="font-size:.85rem">New accounts start <b>unverified</b>. An administrator checks your ID before you can request restricted resources.</p><div class="err"></div><button class="btn">Create account</button></form></section></div>`;
}
function pgGuide() {
  return `<h1>Judge walkthrough: one full sharing journey in ~5 minutes</h1><p class="muted">Every step below maps to the 10-step lifecycle in the problem statement. Sign in from the <a href="#/login">login page</a> with one click.</p>
  <ol class="steps">
  <li><b>List a resource (owner)</b> - Sign in as <i>Dr. Kavita Nair</i> → Manage → Resources → <i>List a new resource</i>. Set training requirement, deposit, limits, opening hours and eligibility. (Or just use the pre-listed items.)</li>
  <li><b>Discover & check eligibility (user)</b> - Sign in as <i>Ananya Sharma</i> → Discover. Try the smart search: <code>engrave acrylic for a prototype</code>. Each card says whether you are eligible and exactly what is missing.</li>
  <li><b>Submit a request</b> - Open <i>Podcast Studio Room</i> (low-risk, auto-approved by rule) or <i>Mirrorless Camera Kit</i> (needs owner approval). Press <b>Check my request</b> to see the predicted outcome and your <b>fairness score breakdown</b> before sending. Try an invalid slot (too long, outside hours) to see the explained blocks.</li>
  <li><b>Verification</b> - Sign in as <i>Tom Becker</i> (unverified) → he is blocked. Sign in as <i>Dr. Meera Iyer</i> (admin) → Admin → Users → Verify. <i>Vikram</i> shows the training gate → "Request training" → the owner grants it.</li>
  <li><b>Owner reviews</b> - Sign in as the owner/manager → Manage → <i>Needs review</i>. Requests are ordered by an explainable priority score. Approve, reject or waitlist - a written reason is mandatory and shown to the requester.</li>
  <li><b>Waiting list & conflicts</b> - As <i>Ananya</i>, cancel the approved laser booking for tomorrow. <i>Ishaan's</i> waitlisted request is automatically promoted back to review (and he is notified). Approving two requests for the same slot is impossible.</li>
  <li><b>Check-in with initial condition</b> - Open an approved booking → <b>Check in</b> (supervised equipment: the manager checks the user in on site). <i>Demo mode lets you check in before the slot starts.</i></li>
  <li><b>Return with final condition</b> - User → <b>Check out</b>, choose the condition and add notes. If the condition worsens or damage is flagged, an incident is opened automatically with an <i>assistive summary</i>. Late returns create a delay record.</li>
  <li><b>Incidents, deposits, appeals</b> - Manager confirms the return (release or withhold deposit with a reason), resolves the incident with a human-chosen penalty. The user can appeal; an admin reviews it independently.</li>
  <li><b>Full history</b> - Both parties see the booking timeline. The admin opens Admin → Audit trail and presses <b>Verify chain</b>: every entry is hash-linked, so edits would be detected.</li></ol>
  <div class="card"><h3>Demo accounts (password <code>demo1234</code>)</h3><div class="scroll"><table><tr><th>Email</th><th>Role</th><th>Notes</th></tr>${DEMOS.map(d => `<tr><td>${d[0]}@openbench.demo</td><td>${esc(d[2])}</td><td>${esc(d[3])}</td></tr>`).join('')}<tr><td>owner.fablab@openbench.demo</td><td>Owner (Fab Lab)</td><td>Prof. Arjun Rao</td></tr><tr><td>sara@openbench.demo / ishaan@openbench.demo</td><td>Researcher / Student</td><td>Heavy-use fairness example / waitlisted + strike history</td></tr></table></div>
  <p class="muted">Admin → Overview has a <b>Reset demo data</b> button to restore the starting state at any time.</p></div>`;
}

let disc = { q: '', cat: '', elig: false };
async function pgDiscover() {
  S.meta = await api('/meta');
  setTimeout(loadResults, 0);
  return `<h1>Find a resource</h1><form data-form="search" class="card stack"><div><label for="q">Describe what you need - we match it to equipment and explain why</label><input id="q" name="q" value="${esc(disc.q)}" placeholder="e.g. engrave acrylic for a prototype, record a podcast, train a model"></div>
  <div class="row"><select name="category" style="width:auto"><option value="">All categories</option>${S.meta.categories.map(c => `<option ${disc.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select><label class="chk" style="margin:0"><input type="checkbox" name="elig" ${disc.elig ? 'checked' : ''}> Only what I can book now</label><button class="btn">Search</button></div></form><div id="results" class="grid g2" style="margin-top:16px"></div>`;
}
async function loadResults() {
  const el = $('#results'); if (!el) return;
  const list = await api(`/resources?q=${encodeURIComponent(disc.q)}&category=${encodeURIComponent(disc.cat)}&eligible=${disc.elig ? 1 : 0}`);
  el.innerHTML = list.length ? list.map(r => `<article class="card res"><div class="row between"><span class="em" aria-hidden="true">${esc(r.emoji)}</span>${r.eligible ? chip('ok', '✓ You can book') : chip('bad', 'Requirements missing')}</div>
  <h3><a href="#/resource/${r.id}">${esc(r.name)}</a></h3><div class="muted">${esc(r.category)} · ${esc(r.location)}</div><p>${esc(r.description.slice(0, 130))}${r.description.length > 130 ? '…' : ''}</p>
  <div class="row">${r.required_cert ? chip('warn', 'Training: ' + r.required_cert) : ''}${r.supervised ? chip('info', 'Supervised') : ''}${r.deposit ? chip('', 'Deposit ' + money(r.deposit)) : ''}${r.high_demand ? chip('warn', 'High demand') : ''}${r.auto_approve && !r.high_demand ? chip('ok', 'Auto-approve') : ''}</div>
  <small class="muted">Open ${esc(r.open_text)} · ${r.demand} waiting/pending</small>
  ${r.match_terms ? `<div class="alert info" style="margin:0">Matched on: <b>${r.match_terms.map(esc).join(', ')}</b></div>` : ''}
  ${!r.eligible ? `<small style="color:var(--red)">Missing: ${r.failing.map(esc).join('; ')}</small>` : ''}</article>`).join('') : '<div class="empty card">No resources match. Try different words like "laser", "print", "record", "room".</div>';
}

const slotStrip = r => {
  const days = r.open_days.split(',').map(Number), now = Date.now(); let out = '';
  for (let i = 0; i < 7; i++) {
    const ts = now + i * 864e5, d = lp(ts), dow = new Date(d.date + 'T00:00:00Z').getUTCDay(), open = days.includes(dow), span = r.open_to - r.open_from;
    const segs = open ? r.slots.filter(s => lp(s.start_ts).date === d.date).map(s => { const a = Math.max(0, (lp(s.start_ts).min - r.open_from) / span * 100), b = Math.min(100, (lp(s.end_ts).min - r.open_from) / span * 100); return `<i style="left:${a}%;width:${Math.max(2, b - a)}%" title="Booked ${tm(s.start_ts)}-${tm(s.end_ts)}"></i>`; }).join('') : '';
    out += `<div>${DN[dow]} ${d.date.slice(8)}</div><div class="bar ${open ? '' : 'closed'}" role="img" aria-label="${open ? 'Open, booked slots shown in amber' : 'Closed'}">${segs}</div>`;
  }
  return `<div class="strip">${out}</div><small class="muted">Teal = open (${hm(r.open_from)}-${hm(r.open_to)}). Amber = already booked. Hatched = closed.</small>`;
};
async function pgResource(id) {
  const r = await api('/resources/' + id), el = r.eligibility;
  const d0 = lp(Date.now() + 864e5).date;
  return `<p><a href="#/discover">← All resources</a></p><div class="split"><section class="stack"><div class="card"><div class="row between"><h1>${esc(r.emoji)} ${esc(r.name)}</h1>${r.status !== 'active' ? chip('bad', 'Paused') : ''}</div><p class="muted">${esc(r.category)} · ${esc(r.location)} · Owner: ${esc(r.owner_name)} · Managers: ${r.managers.map(esc).join(', ')}</p><p>${esc(r.description)}</p>
  <h3>Usage rules</h3><p>${esc(r.rules) || '<span class="muted">None specified</span>'}</p>
  <div class="row"><span class="chip">Max ${r.max_hours} h per booking</span><span class="chip">Max ${r.weekly_quota} h per week per person</span><span class="chip">${r.max_active} open request(s) per person</span>${r.deposit ? chip('', 'Deposit ' + money(r.deposit) + ' (simulated)') : ''}${r.supervised ? chip('info', 'Staff-supervised') : ''}${r.high_demand ? chip('warn', 'High demand: fairness ranking applies') : ''}${r.auto_approve && !r.high_demand ? chip('ok', 'Auto-approved by rule when all checks pass') : ''}</div></div>
  <div class="card"><h2>Am I eligible?</h2><ul class="req">${el.checks.map(c => `<li><span class="ic ${c.ok ? 'y' : 'n'}">${c.ok ? '✓' : '✗'}</span><div><b>${esc(c.label)}</b><br><small class="muted">${esc(c.detail)}</small></div></li>`).join('')}</ul>
  ${!el.checks.find(c => c.key === 'cert')?.ok && r.required_cert ? (r.my_cert_request?.status === 'pending' ? '<div class="alert warn">Training request pending with the owner.</div>' : `<form data-form="reqcert" data-id="${r.id}" class="row"><input name="note" placeholder="Note to the trainer (optional)" style="flex:1"><button class="btn amber sm">Request training</button></form>`) : ''}</div>
  <div class="card"><h2>Next 7 days</h2>${slotStrip(r)}</div></section>
  <aside class="card stack" style="align-self:start"><h2>Request this resource</h2><form data-form="book" data-id="${r.id}" class="stack" id="bookform">
  <div class="fields"><div><label for="bd">Date</label><input id="bd" type="date" name="date" min="${todayStr()}" value="${d0}" required></div><div><label for="bs">Start</label><input id="bs" type="time" name="start" step="900" value="${hm(Math.max(r.open_from, 600))}" required></div><div><label for="be">End</label><input id="be" type="time" name="end" step="900" value="${hm(Math.min(r.open_to, Math.max(r.open_from, 600) + 60 * Math.min(2, r.max_hours)))}" required></div></div>
  <div class="fields"><div><label>Purpose type</label><select name="purpose_type"><option value="coursework">Coursework (+15)</option><option value="research">Research (+10)</option><option value="project">Project (+5)</option><option value="personal">Personal (+0)</option></select></div><div><label>People</label><input type="number" name="attendees" min="1" max="50" value="1"></div></div>
  <div><label>What will you do? (shown to the owner)</label><textarea name="purpose" required minlength="5" placeholder="Describe the work and why you need this resource"></textarea></div>
  <div id="preview"></div><div class="row"><button type="button" class="btn ghost" data-act="check" data-id="${r.id}">Check my request</button><button class="btn" ${r.status !== 'active' ? 'disabled' : ''}>Submit request</button></div><small class="muted">Times are in ${esc(S.meta.tz)}. Important decisions are made by a human, with a written reason.</small></form></aside></div>
  ${r.can_manage ? `<p><a class="btn ghost sm" href="#/manage">Open manager console</a> ${r.owner_id === S.user.id || S.user.role === 'admin' ? `<a class="btn ghost sm" href="#/resource-edit/${r.id}">Edit conditions</a>` : ''}</p>` : ''}`;
}
function previewHtml(o) {
  if (!o.ok) return `<div class="alert bad"><b>This request can't be submitted yet:</b><ul>${o.problems.map(p => `<li>${esc(p.msg)}</li>`).join('')}</ul></div>`;
  const cls = o.outcome === 'waitlisted' ? 'warn' : 'good', name = { pending: 'Goes to the owner for review', waitlisted: 'Would join the waiting list', approved_auto: 'Would be auto-approved' }[o.outcome];
  return `<div class="alert ${cls}"><b>${name}</b><br>${esc(o.explanation)}</div><div class="card" style="padding:12px"><div class="row between"><b>Your fairness priority</b><span class="big">${o.priority.score}</span></div>${o.priority.parts.map(p => `<div class="score"><span>${esc(p.label)}</span><span class="p ${p.points < 0 ? 'neg' : 'pos'}">${p.points > 0 ? '+' : ''}${p.points}</span></div>`).join('')}<small class="muted">Priority only orders competing requests. It never approves anything by itself.</small></div>`;
}

async function pgBookings() {
  const list = await api('/bookings/mine');
  const group = (title, f) => { const l = list.filter(f); return l.length ? `<h2>${title}</h2><div class="grid g2">${l.map(bCard).join('')}</div>` : ''; };
  return `<h1>My bookings</h1><div class="kpi"><div><b>${S.user.hours_30d} h</b>used in last 30 days</div><div><b>${S.user.strikes}</b>strike(s)</div><div><b>${S.user.certs.length}</b>certification(s)</div></div>
  <p class="muted">${S.user.certs.map(esc).join(' · ') || 'No certifications yet'}</p>
  ${group('Needs your attention', b => ['approved', 'checked_in'].includes(b.status))}${group('Waiting for a decision', b => ['pending', 'waitlisted'].includes(b.status))}${group('Returned - awaiting owner confirmation', b => b.status === 'returned')}${group('History', b => ['completed', 'rejected', 'cancelled', 'no_show'].includes(b.status))}
  ${list.length ? '' : '<div class="empty card">No bookings yet. <a href="#/discover">Find a resource</a>.</div>'}`;
}
const bCard = b => `<a class="card stack" style="text-decoration:none;color:inherit" href="#/booking/${b.id}"><div class="row between"><b>${esc(b.resource_emoji)} ${esc(b.resource_name)}</b>${b.is_overdue ? chip('overdue', 'OVERDUE') : chip(b.status)}</div><div>${dt(b.start_ts)} → ${tm(b.end_ts)}</div><small class="muted">${esc(b.purpose)}</small>${b.decision_reason ? `<small>Why: ${esc(b.decision_reason)}</small>` : ''}</a>`;

const condSel = (name, sel = 'good') => `<select name="${name}">${['excellent', 'good', 'fair', 'poor'].map(c => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('')}</select>`;
async function pgBooking(id) {
  const b = await api('/bookings/' + id), me = S.user, P = b.perms, st = b.status, canAct = P.isRequester || P.isManager;
  const reqName = b.requester ? b.requester.name : me.name;
  let act = '';
  if (P.isManager && ['pending', 'waitlisted'].includes(st)) act += `<div class="card"><h2>Decision</h2><form data-form="decide" data-id="${b.id}" class="stack"><div><label>Reason (required to reject or waitlist; shown to the requester)</label><textarea name="reason"></textarea></div><div class="row"><button class="btn" name="decision" value="approve">Approve</button><button class="btn amber" name="decision" value="waitlist">Waitlist</button><button class="btn danger" name="decision" value="reject">Reject</button></div></form></div>`;
  if (st === 'approved') {
    if (b.supervised && !P.isManager) act += `<div class="alert info">Supervised resource: staff will check you in on site after verifying your ID and training. (Demo: sign in as the lab manager.)</div>`;
    else act += `<div class="card"><h2>Check in${P.isManager && !P.isRequester ? ' (on behalf of user)' : ''}</h2><form data-form="checkin" data-id="${b.id}" class="stack"><div class="fields"><div><label>Condition you find it in</label>${condSel('condition')}</div></div><div><label>Notes (scratches, missing items, existing issues)</label><textarea name="notes"></textarea></div><button class="btn">Record check-in</button>${S.meta.demo ? '<small class="muted">Demo mode: early check-in allowed so you can finish the journey now.</small>' : ''}</form></div>`;
  }
  if (st === 'checked_in') act += `<div class="card"><h2>Return &amp; check out</h2><form data-form="checkout" data-id="${b.id}" class="stack"><div class="fields"><div><label>Condition now (was <b>${esc(b.checkin_condition)}</b>)</label>${condSel('condition', b.checkin_condition)}</div></div><div><label>Notes</label><textarea name="notes"></textarea></div><label class="chk"><input type="checkbox" name="damage"> I caused or found damage</label><div><label>Damage description (if any)</label><textarea name="damage_description"></textarea></div><button class="btn">Return resource</button></form></div>`;
  if (P.isRequester && ['approved', 'checked_in'].includes(st)) act += `<details><summary>Need more time? Request an extension</summary><form data-form="extend" data-id="${b.id}" class="stack"><div class="fields"><div><label>New end time</label><input type="time" name="end" step="900" required></div></div><div><label>Reason</label><input name="reason" required></div><button class="btn sm">Request extension</button></form></details>`;
  if (P.isManager && st === 'returned') act += `<div class="card"><h2>Confirm return</h2><p>Compare the condition: <b>${esc(b.checkin_condition)}</b> → <b>${esc(b.checkout_condition)}</b>${b.late_minutes ? ` · ${b.late_minutes} min late` : ''}</p><form data-form="confirm" data-id="${b.id}" class="stack">${b.deposit_status === 'held' ? `<div><label>Deposit (${money(b.deposit)}, simulated)</label><select name="deposit_action"><option value="release">Release to user</option><option value="withhold">Withhold (reason required)</option></select></div>` : ''}<div><label>Note</label><input name="note"></div><button class="btn">Confirm return</button></form></div>`;
  if (['pending', 'waitlisted', 'approved'].includes(st) && canAct) act += `<details><summary>${P.isRequester ? 'Cancel this booking' : 'Revoke this booking'}</summary><form data-form="cancel" data-id="${b.id}" class="stack"><div><label>Reason ${P.isRequester ? '(optional)' : '(required)'}</label><input name="reason"></div><button class="btn danger sm">${P.isRequester ? 'Cancel booking' : 'Revoke booking'}</button>${P.isRequester && st === 'approved' ? '<small class="muted">Cancelling within 2 hours of the start is recorded as a late cancellation (visible in the fair-use watch).</small>' : ''}</form></details>`;
  if (canAct) act += `<details><summary>Report damage, delay or an incident</summary><form data-form="incident" data-id="${b.id}" class="stack"><div class="fields"><div><label>Type</label><select name="type"><option>damage</option><option>delay</option><option>conflict</option><option>safety</option><option>other</option></select></div><div><label>Severity</label><select name="severity"><option>low</option><option>medium</option><option>high</option></select></div></div><div><label>What happened?</label><textarea name="description" required></textarea></div><button class="btn amber sm">Submit report</button></form></details>`;
  for (const x of b.extensions.filter(x => x.status === 'pending' && P.isManager)) act += `<div class="card"><b>Extension requested</b> until ${dt(x.new_end_ts)}<br><small>${esc(x.reason)}</small><form data-form="extdecide" data-id="${x.id}" class="row" style="margin-top:8px"><input name="reason" placeholder="Reason (required to decline)" style="flex:1"><button class="btn sm" name="decision" value="approve">Approve</button><button class="btn danger sm" name="decision" value="decline">Decline</button></form></div>`;
  const incs = b.incidents.map(i => `<div class="card stack"><div class="row between"><b>Incident #${i.id}: ${esc(i.type)}</b><span>${chip(i.severity)} ${chip(i.status)}</span></div><p>${esc(i.description)}</p><small class="muted">${esc(i.summary)}</small>${i.resolution ? `<div class="alert info"><b>Resolution (${esc(i.penalty)}):</b> ${esc(i.resolution)}</div>` : ''}${i.appeal ? `<div class="alert warn"><b>Appeal:</b> ${esc(i.appeal)}${i.appeal_decision ? `<br><b>Decision:</b> ${esc(i.appeal_decision)}` : ''}</div>` : ''}
    ${i.status === 'open' && P.isManager ? `<form data-form="resolve" data-id="${i.id}" class="stack"><div><label>Resolution note (kept in audit trail)</label><textarea name="resolution" required></textarea></div><div><label>Penalty (human decision)</label><select name="penalty"><option value="none">No penalty</option><option value="warning">Warning</option><option value="strike">Strike</option>${me.role === 'admin' ? '<option value="suspend">Suspend account</option>' : ''}</select></div><button class="btn sm">Resolve incident</button></form>` : ''}
    ${i.status === 'resolved' && !i.appeal && i.user_id === me.id && i.penalty !== 'none' ? `<details><summary>Appeal this decision</summary><form data-form="appeal" data-id="${i.id}" class="stack"><textarea name="text" required></textarea><button class="btn sm">Submit appeal</button></form></details>` : ''}
    ${i.status === 'appealed' && me.role === 'admin' ? `<form data-form="appealdecide" data-id="${i.id}" class="stack"><input name="note" placeholder="Decision note" required><div class="row"><button class="btn sm" name="decision" value="overturn">Overturn penalty</button><button class="btn ghost sm" name="decision" value="uphold">Uphold</button></div></form>` : ''}</div>`).join('');
  const pr = b.priority;
  return `<p><a href="#/${P.isManager && !P.isRequester ? 'manage' : 'bookings'}">← Back</a></p><div class="split"><section class="stack">
  <div class="card stack"><div class="row between"><h1>${esc(b.resource_emoji)} ${esc(b.resource_name)}</h1>${b.is_overdue ? chip('overdue', 'OVERDUE') : chip(st)}</div>
  <div class="fields"><div><small class="muted">When</small><br><b>${dt(b.start_ts)} → ${tm(b.end_ts)}</b></div><div><small class="muted">Where</small><br>${esc(b.resource_location)}</div><div><small class="muted">Booked by</small><br>${esc(reqName)}</div></div>
  <div><small class="muted">Purpose (${esc(b.purpose_type)})</small><br>${esc(b.purpose)}</div>
  ${b.decision_reason ? `<div class="alert ${st === 'rejected' ? 'bad' : st === 'approved' || st === 'completed' ? 'good' : 'warn'}"><b>Why this status?</b><br>${esc(b.decision_reason)}</div>` : ''}
  ${b.deposit ? `<div>Deposit ${money(b.deposit)}: ${chip(b.deposit_status === 'withheld' ? 'bad' : b.deposit_status === 'held' ? 'warn' : 'ok', b.deposit_status)} <small class="muted">(simulated)</small></div>` : ''}
  ${b.checkin_at ? `<div class="fields"><div><small class="muted">Checked in</small><br>${dt(b.checkin_at)}<br>Condition: ${chip(b.checkin_condition === 'poor' ? 'bad' : 'ok', b.checkin_condition)}<br><small>${esc(b.checkin_notes || '')}</small></div>${b.checkout_at ? `<div><small class="muted">Returned</small><br>${dt(b.checkout_at)}${b.late_minutes ? ` (${b.late_minutes} min late)` : ''}<br>Condition: ${chip(b.checkout_condition === 'poor' || b.checkout_condition === 'fair' ? 'warn' : 'ok', b.checkout_condition)}<br><small>${esc(b.checkout_notes || '')}</small></div>` : ''}</div>` : ''}
  ${b.return_note ? `<small>Owner note: ${esc(b.return_note)}</small>` : ''}
  ${P.isManager && b.requester ? `<div class="alert info"><b>Requester (privacy-limited view):</b> ${esc(b.requester.name)} · ${esc(b.requester.member_type)} · ${esc(b.requester.org)} · ${chip(b.requester.status)} · ${b.requester.strikes} strike(s)<br>Certifications: ${b.requester.certs.map(esc).join(', ') || 'none'}${b.requester.email ? `<br>Contact (shared because approved): ${esc(b.requester.email)}` : '<br><small>Contact details stay hidden until a booking is approved.</small>'}</div>` : ''}</div>
  ${pr && P.isManager ? `<div class="card"><div class="row between"><h3>Fairness priority (advisory)</h3><span class="big">${pr.score}</span></div>${pr.parts.map(p => `<div class="score"><span>${esc(p.label)}</span><span class="p ${p.points < 0 ? 'neg' : 'pos'}">${p.points > 0 ? '+' : ''}${p.points}</span></div>`).join('')}</div>` : ''}
  ${b.competing && b.competing.length ? `<div class="card"><h3>Competing requests for this time</h3>${b.competing.map(c => `<div class="score"><a href="#/booking/${c.id}">${esc(c.name)} - ${dt(c.start_ts)}</a><span>${chip(c.status)} priority ${c.priority.score}</span></div>`).join('')}</div>` : ''}
  ${act}${incs}</section>
  <aside class="card" style="align-self:start"><h2>Complete history</h2><p class="muted" style="font-size:.85rem">Visible to the requester and the managers. Each entry is hash-chained.</p><ul class="tl">${b.audit.map(a => `<li><b>${esc(label(a.action))}</b> <small class="muted">· ${esc(a.actor_name)}</small><br><small>${dt(a.ts)}</small>${a.reason ? `<br>“${esc(a.reason)}”` : ''}${a.details ? `<br><small class="muted">${esc(Object.entries(JSON.parse(a.details)).map(([k, v]) => k + ': ' + (typeof v === 'number' && v > 1e12 ? dt(v) : v)).join(' · '))}</small>` : ''}<div class="h">#${a.id} ${esc((a.hash || '').slice(0, 12))}</div></li>`).join('')}</ul></aside></div>`;
}

let mtab = 'review';
async function pgManage() {
  const o = await api('/manage/overview'), B = o.bookings;
  const review = B.filter(b => ['pending', 'waitlisted'].includes(b.status)).sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0));
  const prog = B.filter(b => ['approved', 'checked_in', 'returned'].includes(b.status)).sort((a, b) => (b.is_overdue ? 1 : 0) - (a.is_overdue ? 1 : 0));
  const openInc = o.incidents.filter(i => ['open', 'appealed'].includes(i.status));
  const tabs = [['review', 'Needs review', review.length], ['prog', 'In progress', prog.filter(b => b.is_overdue || b.status === 'returned').length], ['inc', 'Incidents', openInc.length], ['ext', 'Extensions', o.extensions.length], ['train', 'Training requests', o.certReqs.length], ['res', 'Resources', 0]];
  const row = b => `<tr><td><a href="#/booking/${b.id}"><b>${esc(b.resource_name)}</b></a><br><small class="muted">${dt(b.start_ts)} → ${tm(b.end_ts)}</small></td><td>${esc(b.requester.name)}<br><small class="muted">${esc(b.requester.member_type)} · ${b.requester.strikes} strike(s)</small></td><td>${esc(b.purpose_type)}<br><small>${esc(b.purpose.slice(0, 60))}</small></td><td>${b.priority ? `<b>${b.priority.score}</b>` : ''}</td><td>${b.is_overdue ? chip('overdue', 'OVERDUE') : chip(b.status)}</td><td><a class="btn sm ghost" href="#/booking/${b.id}">${b.status === 'returned' ? 'Confirm return' : ['pending', 'waitlisted'].includes(b.status) ? 'Review' : 'Open'}</a></td></tr>`;
  const tbl = (l, empty) => l.length ? `<div class="scroll"><table><tr><th>Resource / time</th><th>Requester</th><th>Purpose</th><th>Priority</th><th>Status</th><th></th></tr>${l.map(row).join('')}</table></div>` : `<div class="empty card">${empty}</div>`;
  let body = '';
  if (mtab === 'review') body = `<div class="alert info">Requests are sorted by <b>explainable priority</b> (open a request to see the breakdown). You always make the final decision.</div>` + tbl(review, 'Nothing waiting for review.');
  if (mtab === 'prog') body = tbl(prog, 'No active bookings.');
  if (mtab === 'inc') body = o.incidents.length ? `<div class="scroll"><table><tr><th>#</th><th>Resource</th><th>User</th><th>Type</th><th>Status</th><th></th></tr>${o.incidents.map(i => `<tr><td>${i.id}</td><td>${esc(i.resource_name)}</td><td>${esc(i.user_name)}</td><td>${esc(i.type)} ${chip(i.severity)}${i.auto ? ' <small class="muted">(auto-flagged)</small>' : ''}</td><td>${chip(i.status)}</td><td><a class="btn sm ghost" href="#/booking/${i.booking_id}">Open</a></td></tr>`).join('')}</table></div>` : '<div class="empty card">No incidents.</div>';
  if (mtab === 'ext') body = o.extensions.length ? o.extensions.map(x => `<div class="card"><b>${esc(x.user_name)}</b> · ${esc(x.resource_name)}: ${dt(x.old_end)} → <b>${dt(x.new_end_ts)}</b><br><small>${esc(x.reason)}</small><form data-form="extdecide" data-id="${x.id}" class="row" style="margin-top:8px"><input name="reason" placeholder="Reason (required to decline)" style="flex:1"><button class="btn sm" name="decision" value="approve">Approve</button><button class="btn danger sm" name="decision" value="decline">Decline</button></form></div>`).join('') : '<div class="empty card">No pending extensions.</div>';
  if (mtab === 'train') body = o.certReqs.length ? o.certReqs.map(c => `<div class="card"><b>${esc(c.user.name)}</b> (${esc(c.user.member_type)}, ${chip(c.user.status)}) requests <b>${esc(c.cert)}</b> for ${esc(c.resource_name)}<br><small>${esc(c.note || '')}</small><form data-form="certdecide" data-id="${c.id}" class="row" style="margin-top:8px"><input name="note" placeholder="Note (required to decline)" style="flex:1"><button class="btn sm" name="decision" value="grant">Grant certification</button><button class="btn danger sm" name="decision" value="decline">Decline</button></form></div>`).join('') : '<div class="empty card">No training requests.</div>';
  if (mtab === 'res') body = `<div class="row between"><h2>Resources you manage</h2>${S.user.role !== 'user' && S.user.role !== 'manager' ? '<a class="btn" href="#/resource-edit/new">+ List a new resource</a>' : ''}</div><div class="grid g2">${o.resources.map(r => `<div class="card stack"><b>${esc(r.emoji)} ${esc(r.name)}</b> ${r.status !== 'active' ? chip('bad', 'paused') : ''}<small class="muted">${esc(r.location)} · ${r.demand} waiting/pending</small><div class="row"><a class="btn ghost sm" href="#/resource/${r.id}">View</a>${r.is_owner ? `<a class="btn ghost sm" href="#/resource-edit/${r.id}">Edit conditions</a>` : ''}</div></div>`).join('')}</div>`;
  return `<h1>Manager console</h1><div class="tabs" role="tablist">${tabs.map(t => `<button class="${mtab === t[0] ? 'on' : ''}" data-act="mtab" data-t="${t[0]}">${t[1]}${t[2] ? `<span class="n">${t[2]}</span>` : ''}</button>`).join('')}</div>${body}`;
}

async function pgResEdit(id) {
  const isNew = id === 'new', r = isNew ? { emoji: '🔧', category: 'Fabrication', verified_only: 1, max_hours: 4, max_active: 2, weekly_quota: 8, open_days: '1,2,3,4,5', open_from: 540, open_to: 1080, allowed_types: '', deposit: 0, status: 'active' } : await api('/resources/' + id);
  const days = String(r.open_days).split(','), types = String(r.allowed_types || '').split(',');
  S.meta = await api('/meta');
  const chk = (n, l, v) => `<label class="chk"><input type="checkbox" name="${n}" ${v ? 'checked' : ''}>${l}</label>`;
  return `<p><a href="#/manage">← Back</a></p><h1>${isNew ? 'List a new resource' : 'Edit conditions'}</h1><form data-form="resource" data-id="${id}" class="card stack">
  <div class="fields"><div><label>Name</label><input name="name" required value="${esc(r.name)}"></div><div><label>Icon</label><input name="emoji" value="${esc(r.emoji)}" maxlength="4"></div><div><label>Category</label><select name="category">${S.meta.categories.map(c => `<option ${c === r.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div><div><label>Location</label><input name="location" required value="${esc(r.location)}"></div></div>
  <div><label>Description</label><textarea name="description">${esc(r.description)}</textarea></div><div><label>Usage rules & conditions</label><textarea name="rules">${esc(r.rules)}</textarea></div><div><label>Search keywords (comma separated)</label><input name="tags" value="${esc(r.tags)}"></div>
  <h3>Access conditions</h3><div class="fields"><div><label>Required training / certification</label><input name="required_cert" value="${esc(r.required_cert)}" placeholder="e.g. Laser Safety Level 1"></div><div><label>Deposit (INR, simulated)</label><input type="number" name="deposit" min="0" value="${r.deposit}"></div></div>
  <div><label>Eligible member types (none ticked = everyone)</label><div class="row">${S.meta.memberTypes.map(t => `<label class="chk"><input type="checkbox" name="allowed_types" value="${t}" ${types.includes(t) ? 'checked' : ''}>${t}</label>`).join('')}</div></div>
  ${chk('verified_only', 'Require verified identity', r.verified_only)}${chk('supervised', 'Staff-supervised: a manager must check users in', r.supervised)}${chk('auto_approve', 'Auto-approve low-risk requests when all rules pass and nobody else competes (ignored for supervised / high-demand)', r.auto_approve)}${chk('high_demand', 'High demand: always human review, fairness ranking applies', r.high_demand)}
  <h3>Fair-use limits</h3><div class="fields"><div><label>Max hours per booking</label><input type="number" step="0.5" name="max_hours" value="${r.max_hours}"></div><div><label>Max hours per person per week</label><input type="number" name="weekly_quota" value="${r.weekly_quota}"></div><div><label>Max open requests per person</label><input type="number" name="max_active" value="${r.max_active}"></div></div>
  <h3>Availability</h3><div class="row">${DN.map((d, i) => `<label class="chk"><input type="checkbox" name="day" value="${i}" ${days.includes(String(i)) ? 'checked' : ''}>${d}</label>`).join('')}</div><div class="fields"><div><label>Opens</label><input type="time" name="open_from" value="${hm(r.open_from)}"></div><div><label>Closes</label><input type="time" name="open_to" value="${hm(r.open_to)}"></div>${isNew ? '' : `<div><label>Status</label><select name="status"><option value="active" ${r.status === 'active' ? 'selected' : ''}>Active</option><option value="paused" ${r.status === 'paused' ? 'selected' : ''}>Paused (hidden from search)</option></select></div>`}</div>
  <div class="err"></div><button class="btn">${isNew ? 'List resource' : 'Save changes'}</button></form>`;
}

let atab = 'over';
async function pgAdmin() {
  const tabs = [['over', 'Overview'], ['users', 'Users & verification'], ['fair', 'Fair-use watch'], ['audit', 'Audit trail']];
  let body = '';
  if (atab === 'over') { const s = await api('/admin/stats'); body = `<div class="kpi"><div><b>${s.users}</b>users</div><div><b>${s.resources}</b>resources</div><div><b>${s.audit_entries}</b>audit entries</div><div><b>${s.incidents_open}</b>open incidents/appeals</div></div><h3 style="margin-top:16px">Bookings by status</h3><div class="row">${s.bookings.map(b => chip(b.status, `${label(b.status)}: ${b.c}`)).join('')}</div>${s.appeals.length ? `<h3>Appeals awaiting your independent review</h3>${s.appeals.map(a => `<div class="card"><b>${esc(a.user_name)}</b> appeals incident #${a.id} (${esc(a.penalty)}): “${esc(a.appeal)}”<br><small>Original resolution: ${esc(a.resolution)}</small><form data-form="appealdecide" data-id="${a.id}" class="row" style="margin-top:8px"><input name="note" placeholder="Decision note" required style="flex:1"><button class="btn sm" name="decision" value="overturn">Overturn</button><button class="btn ghost sm" name="decision" value="uphold">Uphold</button></form></div>`).join('')}` : ''}${S.meta.demo ? '<hr><button class="btn danger sm" data-act="reset">Reset demo data</button> <small class="muted">Restores the seeded starting state.</small>' : ''}`; }
  if (atab === 'users') { const u = await api('/admin/users'); body = `<div class="scroll"><table><tr><th>Name</th><th>Type / org</th><th>ID</th><th>Status</th><th>Role</th><th>Action</th></tr>${u.map(x => `<tr><td><b>${esc(x.name)}</b><br><small class="muted">${esc(x.email)}</small></td><td>${esc(x.member_type)}<br><small class="muted">${esc(x.org)}</small></td><td>${esc(x.id_number)}</td><td>${chip(x.status)}${x.strikes ? ` ${x.strikes} strike(s)` : ''}</td><td>${esc(x.role)}</td><td><div class="row">${x.status !== 'verified' ? `<button class="btn sm" data-act="ustatus" data-id="${x.id}" data-s="verified">Verify ID</button>` : ''}${x.status !== 'suspended' && x.role !== 'admin' ? `<button class="btn sm danger" data-act="ustatus" data-id="${x.id}" data-s="suspended">Suspend</button>` : ''}${x.status === 'suspended' ? `<button class="btn sm ghost" data-act="ustatus" data-id="${x.id}" data-s="verified">Reinstate</button>` : ''}</div></td></tr>`).join('')}</table></div><p class="muted">ID numbers are masked. Verification is a manual admin decision; in production this would integrate with the institution's SSO or registry.</p>`; }
  if (atab === 'fair') { const f = await api('/admin/fairuse'); body = `<p class="muted">Rule-based signals for human follow-up. Nothing here applies a penalty automatically.</p><div class="scroll"><table><tr><th>User</th><th>Hours (30d)</th><th>Requests (7d)</th><th>Late cancels</th><th>No-shows</th><th>Late returns</th><th>Signals</th></tr>${f.map(x => `<tr><td><b>${esc(x.name)}</b><br><small class="muted">${esc(x.member_type)}</small></td><td>${x.hours_30d}</td><td>${x.requests_7d}</td><td>${x.late_cancels}</td><td>${x.no_shows}</td><td>${x.late_returns}</td><td>${x.flags.length ? x.flags.map(t => chip('warn', t)).join(' ') : '<small class="muted">none</small>'}</td></tr>`).join('')}</table></div>`; }
  if (atab === 'audit') { const [a, v] = await Promise.all([api('/audit'), api('/audit/verify')]); body = `<div class="alert ${v.ok ? 'good' : 'bad'}">${v.ok ? `✓ Hash chain intact: ${v.checked} entries verified (head ${esc(v.head)}…)` : `✗ Chain broken at entry #${v.broken_at}`} <button class="btn ghost sm" data-act="verify">Verify chain</button></div><div class="scroll"><table><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Booking</th><th>Reason</th></tr>${a.map(x => `<tr><td>${x.id}</td><td>${dt(x.ts)}</td><td>${esc(x.actor_name)}</td><td>${esc(label(x.action))}</td><td>${x.booking_id ? `<a href="#/booking/${x.booking_id}">#${x.booking_id}</a>` : ''}</td><td>${esc(x.reason || '')}</td></tr>`).join('')}</table></div>`; }
  return `<h1>Administration</h1><div class="tabs">${tabs.map(t => `<button class="${atab === t[0] ? 'on' : ''}" data-act="atab" data-t="${t[0]}">${t[1]}</button>`).join('')}</div>${body}`;
}

// ---------- events ----------
const rerender = () => route();
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); const notif = $('#notif');
  if (notif && notif.classList.contains('open') && !e.target.closest('#notif') && !(el && el.dataset.act === 'bell')) notif.classList.remove('open');
  if (!el) return; const a = el.dataset.act;
  try {
    if (a === 'quick') { const r = await api('/auth/login', { method: 'POST', body: { email: el.dataset.email, password: 'demo1234' } }); store.set('ob_token', r.token); location.hash = '#/discover'; if (location.hash === '#/discover') route(); }
    else if (a === 'logout') { try { await api('/auth/logout', { method: 'POST' }); } catch { } store.set('ob_token', null); S.user = null; location.hash = '#/login'; route(); }
    else if (a === 'authtab') { $('#f-in').hidden = el.dataset.t !== 'in'; $('#f-up').hidden = el.dataset.t !== 'up'; document.querySelectorAll('[data-act=authtab]').forEach(b => b.classList.toggle('on', b === el)); }
    else if (a === 'bell') { const n = $('#notif'); if (n.classList.toggle('open')) { const l = await api('/notifications'); n.innerHTML = l.length ? l.map(x => `<a href="${esc(x.link || '#/bookings')}" class="${x.read ? '' : 'unread'}">${esc(x.text)}<small class="muted">${dt(x.ts)}</small></a>`).join('') : '<p class="empty">No notifications</p>'; await api('/notifications/read', { method: 'POST' }); const b = $('.bell b'); if (b) b.remove(); } }
    else if (a === 'check') { const f = $('#bookform'), d = Object.fromEntries(new FormData(f)); $('#preview').innerHTML = previewHtml(await api(`/resources/${el.dataset.id}/check`, { method: 'POST', body: d })); }
    else if (a === 'mtab') { mtab = el.dataset.t; rerender(); }
    else if (a === 'atab') { atab = el.dataset.t; rerender(); }
    else if (a === 'ustatus') { await api(`/admin/users/${el.dataset.id}/status`, { method: 'POST', body: { status: el.dataset.s } }); toast('User updated'); rerender(); }
    else if (a === 'verify') rerender();
    else if (a === 'reset') { if (confirm('Reset all demo data?')) { await api('/admin/reset-demo', { method: 'POST' }); toast('Demo data restored'); rerender(); } }
  } catch (err) { toast(err.message, true); }
});
const FORMS = {
  login: async d => { const r = await api('/auth/login', { method: 'POST', body: d }); store.set('ob_token', r.token); location.hash = '#/discover'; route(); },
  register: async d => { const r = await api('/auth/register', { method: 'POST', body: d }); store.set('ob_token', r.token); toast('Account created. An admin must verify your ID before you can book restricted resources.'); location.hash = '#/discover'; route(); },
  search: async d => { disc = { q: d.q || '', cat: d.category || '', elig: !!d.elig }; await loadResults(); },
  reqcert: async (d, f) => { await api(`/resources/${f.dataset.id}/request-cert`, { method: 'POST', body: d }); toast('Training request sent to the owner'); rerender(); },
  book: async (d, f) => { const r = await api(`/resources/${f.dataset.id}/book`, { method: 'POST', body: d }); toast(r.status === 'approved' ? 'Auto-approved by rule!' : r.status === 'waitlisted' ? 'Added to the waiting list' : 'Request sent for review'); location.hash = '#/booking/' + r.id; },
  decide: async (d, f) => { const r = await api(`/bookings/${f.dataset.id}/decide`, { method: 'POST', body: d }); toast('Decision recorded: ' + r.status); rerender(); },
  cancel: async (d, f) => { await api(`/bookings/${f.dataset.id}/cancel`, { method: 'POST', body: d }); toast('Cancelled'); rerender(); },
  checkin: async (d, f) => { await api(`/bookings/${f.dataset.id}/checkin`, { method: 'POST', body: d }); toast('Check-in recorded'); rerender(); },
  checkout: async (d, f) => { const r = await api(`/bookings/${f.dataset.id}/checkout`, { method: 'POST', body: d }); toast('Returned.' + (r.flags.length ? ' An incident was opened for review: ' + r.flags.join(', ') : '')); rerender(); },
  confirm: async (d, f) => { await api(`/bookings/${f.dataset.id}/confirm-return`, { method: 'POST', body: d }); toast('Return confirmed'); rerender(); },
  extend: async (d, f) => { await api(`/bookings/${f.dataset.id}/extend`, { method: 'POST', body: d }); toast('Extension requested'); rerender(); },
  extdecide: async (d, f) => { await api(`/extensions/${f.dataset.id}/decide`, { method: 'POST', body: d }); toast('Done'); rerender(); },
  incident: async (d, f) => { await api(`/bookings/${f.dataset.id}/incident`, { method: 'POST', body: d }); toast('Report submitted to the managers'); rerender(); },
  resolve: async (d, f) => { await api(`/incidents/${f.dataset.id}/resolve`, { method: 'POST', body: d }); toast('Incident resolved'); rerender(); },
  appeal: async (d, f) => { await api(`/incidents/${f.dataset.id}/appeal`, { method: 'POST', body: d }); toast('Appeal sent to an administrator'); rerender(); },
  appealdecide: async (d, f) => { await api(`/incidents/${f.dataset.id}/appeal-decision`, { method: 'POST', body: d }); toast('Appeal decided'); rerender(); },
  certdecide: async (d, f) => { await api(`/cert-requests/${f.dataset.id}/decide`, { method: 'POST', body: { grant: d.decision === 'grant', note: d.note } }); toast('Done'); rerender(); },
  resource: async (d, f) => {
    const g = n => [...f.querySelectorAll(`[name=${n}]:checked`)].map(x => x.value);
    const body = { ...d, allowed_types: g('allowed_types'), open_days: g('day').join(','), open_from: toMin(d.open_from), open_to: toMin(d.open_to), verified_only: !!d.verified_only, supervised: !!d.supervised, auto_approve: !!d.auto_approve, high_demand: !!d.high_demand };
    const isNew = f.dataset.id === 'new', r = await api(isNew ? '/resources' : '/resources/' + f.dataset.id, { method: isNew ? 'POST' : 'PUT', body });
    toast(isNew ? 'Resource listed' : 'Saved'); location.hash = '#/manage'; if (!isNew || true) route();
  },
};
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const d = Object.fromEntries(new FormData(f, e.submitter)); f.querySelectorAll('input[type=checkbox]').forEach(c => { if (!['allowed_types', 'day'].includes(c.name)) d[c.name] = c.checked; });
  const err = f.querySelector('.err'); if (err) err.innerHTML = '';
  const btns = f.querySelectorAll('button'); btns.forEach(b => b.disabled = true);
  try { await FORMS[f.dataset.form](d, f); }
  catch (x) { const msg = esc(x.message) + (x.data && x.data.problems ? `<ul>${x.data.problems.map(p => `<li>${esc(p.msg)}</li>`).join('')}</ul>` : ''); const box = f.querySelector('#preview') || err; if (box) box.innerHTML = `<div class="alert bad">${msg}</div>`; toast(x.message, true); }
  finally { btns.forEach(b => b.disabled = false); }
});
(async () => { try { S.meta = await api('/meta'); } catch { } route(); setInterval(async () => { if (S.user) { try { const m = await api('/me'); if (m.unread !== S.user.unread) { S.user = m; renderTop(); } } catch { } } }, 20000); })();
