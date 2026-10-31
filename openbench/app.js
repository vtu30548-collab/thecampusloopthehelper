/* OpenBench UI — renders views from the rules engine (logic.js) and wires up actions. */
(function () {
  'use strict';
  const OB = window.OB, { fmtT, fmtD, fmtDT, ymd, daysText, HOUR, MIN, DAY } = OB;
  const KEY = 'openbench.db.v1', SKEY = 'openbench.user';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable: app still works in memory */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const EMOJI = { Fabrication: '🛠️', Electronics: '🔌', Computing: '💻', Media: '🎥', Space: '🏛️' };
  const STATUS = {
    requested: ['Pending review', 'warn'], waitlisted: ['Waitlisted', 'info'], approved: ['Approved', 'ok'], checked_in: ['In use', 'info'],
    returned: ['Returned · awaiting confirmation', 'warn'], completed: ['Completed', 'ok'], rejected: ['Rejected', 'err'], cancelled: ['Cancelled', 'mute'],
    no_show: ['No-show', 'err'], expired: ['Expired', 'mute']
  };
  const INC = { open: ['Open', 'warn'], disputed: ['Disputed · admin review', 'err'], resolved: ['Resolved', 'ok'] };
  const ACTION_LABEL = {
    'user.registered': 'Account created', 'user.verified': 'Account verified', 'user.rejected': 'Account rejected', 'user.role_changed': 'Role changed', 'user.suspended': 'Account suspended', 'user.reinstated': 'Account reinstated',
    'credits.granted': 'Credits granted', 'credential.submitted': 'Training evidence submitted', 'credential.approved': 'Training verified', 'credential.rejected': 'Training rejected',
    'resource.listed': 'Resource listed', 'resource.updated': 'Listing updated', 'resource.status': 'Availability changed', 'resource.manager_added': 'Manager added', 'resource.manager_removed': 'Manager removed',
    'booking.requested': 'Requested', 'booking.approved': 'Approved', 'booking.rejected': 'Rejected', 'booking.waitlisted': 'Waitlisted', 'booking.promoted': 'Promoted from waitlist', 'booking.cancelled': 'Cancelled',
    'booking.checked_in': 'Checked in', 'booking.returned': 'Returned', 'booking.completed': 'Return confirmed', 'booking.no_show': 'No-show', 'booking.overdue': 'Overdue', 'booking.expired': 'Expired', 'booking.conflict': 'Scheduling conflict',
    'extension.requested': 'Extension requested', 'extension.approved': 'Extension approved', 'extension.rejected': 'Extension declined',
    'incident.reported': 'Incident reported', 'incident.comment': 'Incident comment', 'incident.disputed': 'Incident disputed', 'incident.resolved': 'Incident resolved'
  };

  // ---------- state ----------
  const S = { eng: null, uid: null, showNotif: false, filter: { q: '', category: '', eligible: false }, photo: null, tab: {} };

  function save(db) { ls.set(KEY, JSON.stringify(db)); }
  function boot() {
    let db = null;
    const raw = ls.get(KEY);
    if (raw) { try { db = JSON.parse(raw); if (!db || db.v !== 1 || !db.users) db = null; } catch (e) { db = null; } }
    if (db) S.eng = new OB.Engine(db, { onChange: save });
    else { S.eng = OB.seedEngine({ onChange: save }); S.eng.save(); }
    const u = ls.get(SKEY);
    S.uid = u && S.eng.user(u) ? u : null;
    S.eng.tick();
  }
  const E = () => S.eng;
  const me = () => S.eng.user(S.uid);
  function resetDemo() {
    ls.del(KEY); S.eng = OB.seedEngine({ onChange: save }); S.eng.save(); S.uid = null; ls.del(SKEY); location.hash = '#/login'; render();
  }

  // ---------- small view helpers ----------
  const chip = (txt, kind) => `<span class="chip ${kind}">${esc(txt)}</span>`;
  const bchip = b => { const s = STATUS[b.status] || [b.status, 'mute']; return chip(E().isOverdue(b) ? 'Overdue — return now' : s[0], E().isOverdue(b) ? 'err' : s[1]); };
  const when = b => `${esc(fmtD(b.start))} · ${esc(fmtT(b.start))}–${esc(fmtT(b.end))}`;
  const rlink = r => `<a href="#/resource/${r.id}">${esc(r.name)}</a>`;
  const blink = (b, label) => `<a href="#/booking/${b.id}">${label || 'Open'}</a>`;
  const roleName = u => ({ admin: 'Administrator', owner: 'Resource owner', manager: 'Manager', user: 'Member' }[u.role] || u.role);
  const empty = t => `<p class="muted">${esc(t)}</p>`;
  function toast(msg, err) {
    const d = document.createElement('div'); d.className = 'toast' + (err ? ' err' : ''); d.textContent = msg;
    $('#toasts').appendChild(d); setTimeout(() => d.remove(), err ? 6000 : 3500);
  }
  function guard(fn, okMsg) {
    try { const r = fn(); if (okMsg) toast(okMsg); render(); return r; } catch (e) { toast(e.message || String(e), true); }
  }

  // ---------- modal ----------
  function closeModal() { $('#modal-root').innerHTML = ''; }
  function fieldHtml(f) {
    const id = 'mf_' + f.name;
    if (f.type === 'textarea') return `<div class="field"><label for="${id}">${esc(f.label)}</label><textarea id="${id}" name="${f.name}" rows="3" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}"></textarea>${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</div>`;
    if (f.type === 'select') return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" name="${f.name}">${f.options.map(o => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select></div>`;
    if (f.type === 'checkbox') return `<div class="field"><label class="chk"><input type="checkbox" name="${f.name}"> ${esc(f.label)}</label>${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</div>`;
    return `<div class="field"><label for="${id}">${esc(f.label)}</label><input id="${id}" name="${f.name}" type="${f.type || 'text'}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}"></div>`;
  }
  function modalForm(o, cb) {
    $('#modal-root').innerHTML = `<div class="modal-back" data-modal-back><form class="modal" role="dialog" aria-modal="true" aria-labelledby="mt" data-modal-form>
      <h2 id="mt">${esc(o.title)}</h2>${o.intro ? `<p class="muted">${o.intro}</p>` : ''}<div id="merr"></div>
      ${(o.fields || []).map(fieldHtml).join('')}
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn ${o.danger ? 'danger' : 'primary'}">${esc(o.submit || 'Confirm')}</button></div></form></div>`;
    const form = $('[data-modal-form]'); const first = form.querySelector('input,textarea,select'); if (first) first.focus();
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const fd = new FormData(form), vals = {};
      (o.fields || []).forEach(f => { vals[f.name] = f.type === 'checkbox' ? fd.get(f.name) === 'on' : String(fd.get(f.name) || '').trim(); });
      try { cb(vals); closeModal(); render(); } catch (e) { $('#merr').innerHTML = `<div class="banner err" role="alert">${esc(e.message)}</div>`; }
    });
  }

  // ---------- layout ----------
  function nav(route) {
    const u = me(), items = [['', 'Discover'], ['bookings', 'My bookings']];
    if (E().isStaff(u.id)) items.push(['manage', 'Manage']);
    items.push(['incidents', 'Incidents'], ['history', 'Activity log']);
    if (u.role === 'admin') items.push(['admin', 'Admin']);
    items.push(['profile', 'Profile']);
    const cur = route[0] || '';
    return items.map(([h, l]) => `<a href="#/${h}" ${cur === h || (h === '' && ['resource'].includes(cur)) || (h === 'bookings' && cur === 'booking') || (h === 'incidents' && cur === 'incident') ? 'aria-current="page"' : ''}>${l}</a>`).join('');
  }
  function notifPanel() {
    const list = E().db.notifications.filter(n => n.userId === S.uid).sort((a, b) => b.ts - a.ts).slice(0, 25);
    return `<div class="notif" role="region" aria-label="Notifications"><header><b>Notifications</b><button class="btn sm" data-act="readall">Mark all read</button></header>
      ${list.length ? list.map(n => `<button class="item ${n.read ? '' : 'unread'}" data-act="notif" data-id="${n.id}" data-link="${esc(n.link)}">${esc(n.text)}<br><small class="muted">${esc(fmtDT(n.ts))}</small></button>`).join('') : '<p class="muted" style="padding:1rem">Nothing yet.</p>'}</div>`;
  }
  function demoBar() {
    return `<div class="demobar" role="region" aria-label="Demo controls"><div class="wrap"><b>🧪 Demo clock</b><span class="when">${esc(fmtDT(E().now()))}${E().db.clockOffset ? ' (simulated)' : ''} — fast-forward to test check-in, overdue and no-show rules</span>
      <button class="btn" data-act="clk" data-v="15">+15 min</button><button class="btn" data-act="clk" data-v="60">+1 hour</button><button class="btn" data-act="clk" data-v="1440">+1 day</button>
      <button class="btn" data-act="clk-next">Jump to my next booking start</button><button class="btn" data-act="clk-overdue">Make in-use booking overdue</button>
      <button class="btn" data-act="clk" data-v="0">Reset clock</button><button class="btn danger" data-act="reset">Reset demo data</button></div></div>`;
  }
  function shell(route, body) {
    const u = me(), unread = E().db.notifications.filter(n => n.userId === u.id && !n.read).length;
    return `<a class="skip" href="#main">Skip to content</a><header class="top"><div class="wrap">
      <a class="brand" href="#/"><span class="logo" aria-hidden="true">⌂</span>OpenBench</a><nav aria-label="Main">${nav(route)}</nav>
      <div class="right"><span class="pill" title="Your credits balance">◈ ${u.credits} credits</span>
        <button class="bell" data-act="bell" aria-label="Notifications, ${unread} unread" aria-expanded="${S.showNotif}">🔔${unread ? `<b>${unread}</b>` : ''}</button>
        <div class="who"><b>${esc(u.name)}</b><small>${esc(roleName(u))}${u.status !== 'verified' ? ' · ' + esc(u.status) : ''}</small></div>
        <button class="btn sm" data-act="logout">Sign out</button></div></div>${S.showNotif ? notifPanel() : ''}</header>
      <main id="main" tabindex="-1"><div class="wrap">${u.status === 'pending' ? `<div class="banner warn"><b>Your account is awaiting verification.</b> You can browse resources, but an administrator must verify your identity before you can request bookings.</div>` : ''}${u.status === 'suspended' ? `<div class="banner err"><b>Your account is suspended</b> after repeated reviewed incidents. An administrator can review and reinstate it.</div>` : ''}${body}</div></main>${demoBar()}`;
  }

  // ---------- login & registration ----------
  function viewLogin() {
    const demo = [
      ['ananya@demo.edu', 'Ananya · student', 'Trained on 3D printer & laser. Try requesting a resource.'], ['rahul@demo.edu', 'Rahul · student', 'No trainings yet — see how eligibility blocks him, then submit evidence.'],
      ['sneha@demo.edu', 'Dr. Sneha · researcher', 'Can use the GPU workstation (research-only).'], ['imran@demo.edu', 'Imran · community startup', 'Has an approved laser-cutter booking for check-in.'],
      ['owner@demo.edu', 'Prof. Rao · owner', 'Owns the seminar room, oscilloscope bench and GPU.'], ['owner.media@demo.edu', 'Farah · owner', 'Owns printer, laser cutter, camera.'],
      ['manager@demo.edu', 'Ravi · lab manager', 'Reviews requests, checks returns, handles incidents.'], ['admin@demo.edu', 'Dr. Kavya · administrator', 'Verifies accounts, rules on disputes, sees the full audit log.']
    ];
    return `<div class="login-wrap"><div class="hero"><h1>⌂ OpenBench</h1><p>A trusted way for colleges, labs and makerspaces to share underused spaces and equipment — with eligibility checks, human approval, condition records, fair allocation and a tamper-evident activity history.</p></div>
      <div class="split"><div class="card"><h2>Try it with a demo account</h2><p class="muted small">All data is fictional. Password for every demo account: <b>demo123</b>. Click a person to sign in instantly.</p>
        <div class="demo-grid">${demo.map(d => `<button class="demo-btn" data-act="demo" data-email="${d[0]}"><b>${esc(d[1])}</b><span>${esc(d[2])}</span></button>`).join('')}</div></div>
      <div class="stack"><form class="card" data-form="login"><h2>Sign in</h2><div class="field"><label for="le">Email</label><input id="le" name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label for="lp">Password</label><input id="lp" name="password" type="password" required autocomplete="current-password"></div><button class="btn primary">Sign in</button> <a class="btn ghost" href="#/register">Create account</a></form>
      <div class="card"><h2>2-minute judge walkthrough</h2><ol class="small" style="padding-left:1.1rem;margin:0"><li>Sign in as <b>Ananya</b> → Discover → type “I need to cut acrylic” → open the laser cutter.</li>
        <li>Pick a time and see the live eligibility &amp; fair-use checks → submit (or join the waitlist if it clashes).</li><li>Sign in as <b>Ravi</b> → Manage → review with priority scores → Approve (reason is saved).</li>
        <li>Use the <b>demo clock</b> at the bottom to jump to the start → Ananya checks in with a condition report → returns it → Ravi confirms (damage optional).</li><li>Open <b>Activity log</b> for the full, hash-chained history.</li></ol></div></div></div></div>`;
  }
  function viewRegister() {
    return `<div class="login-wrap"><div class="card" style="max-width:560px;margin:0 auto"><h1>Create account</h1><p class="muted">New accounts are verified by an administrator before they can request resources (demo: sign in as admin@demo.edu to verify).</p>
      <form data-form="register"><div class="field"><label for="rn">Full name</label><input id="rn" name="name" required></div><div class="field"><label for="re">Email</label><input id="re" name="email" type="email" required></div>
      <div class="field"><label for="rp">Password (6+ characters)</label><input id="rp" name="password" type="password" required minlength="6"></div>
      <div class="field"><label for="rm">Membership</label><select id="rm" name="membership"><option value="student">Student</option><option value="research">Researcher</option><option value="staff">Staff</option><option value="community">Community / startup member</option></select></div>
      <div class="field"><label for="ro">Organisation / programme</label><input id="ro" name="org"></div>
      <div class="field"><label for="ri">Institutional ID or registration number</label><input id="ri" name="idRef" required><small class="muted">Used only by administrators to verify you.</small></div>
      <div class="field"><label class="chk"><input type="checkbox" name="wantsOwner"> I want to list resources (owner access)</label></div>
      <button class="btn primary">Register</button> <a class="btn ghost" href="#/login">Back</a></form></div></div>`;
  }

  // ---------- discover ----------
  function eligChip(el) {
    if (!el) return '';
    if (el.eligible) return chip('✓ You can request this', 'ok');
    const f = el.checks.find(c => !c.pass);
    return chip('Needs: ' + f.label.replace(/^Training: /, ''), 'warn');
  }
  function resourceCard(x) {
    const r = x.resource, av = r.availability;
    return `<article class="card res"><div class="top"><div class="emoji" aria-hidden="true">${EMOJI[r.category] || '📦'}</div><div><h3><a href="#/resource/${r.id}">${esc(r.name)}</a></h3>
      <div class="muted small">${esc(r.category)} · ${esc(r.location)}</div></div></div>
      <p class="small" style="margin:.6rem 0">${esc(r.description)}</p>
      <div>${r.tags.slice(0, 6).map(t => `<span class="tag ${x.reasons.some(q => t.includes(q)) ? 'hit' : ''}">${esc(t)}</span>`).join('')}</div>
      <p class="small muted" style="margin:.5rem 0">🕒 ${esc(daysText(av.days))}, ${av.start}–${av.end} · max ${r.limits.maxHoursPerBooking} h/booking · ${r.creditsPerHour ? r.creditsPerHour + ' cr/h' : 'free'}${r.deposit ? ' + ' + r.deposit + ' deposit' : ''}</p>
      <div class="row">${r.status !== 'active' ? chip(r.status === 'paused' ? 'Paused' : 'Under maintenance', 'err') : ''}${eligChip(x.eligibility)}${r.requiresSupervision ? chip('Supervised', 'info') : ''}${x.reasons.length ? chip('Matches: ' + x.reasons.join(', '), 'info') : ''}</div></article>`;
  }
  function viewBrowse() {
    const f = S.filter, list = E().search({ q: f.q, category: f.category, userId: S.uid, onlyEligible: f.eligible });
    return `<div class="hero"><h1>Find a resource you can actually use</h1><p>Describe what you want to do. We match it to spaces and equipment, and check your eligibility before you ask — training, membership and fair-use limits are shown up front.</p>
      <form class="searchbar" data-form="search" role="search"><div><label class="sr" for="q">What do you need to do?</label><input id="q" name="q" value="${esc(f.q)}" placeholder="e.g. “cut acrylic panels”, “train a model”, “film a product video”, “room for 20 people”"></div>
      <div><label class="sr" for="cat">Category</label><select id="cat" name="category"><option value="">All categories</option>${OB.CATEGORIES.map(c => `<option ${f.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div><button class="btn primary">Search</button></form>
      <label class="chk small"><input type="checkbox" form="sf" id="eligOnly" data-act="eligtoggle" ${f.eligible ? 'checked' : ''}> Show only resources I’m eligible for now</label></div>
      <h2>${list.length} resource${list.length === 1 ? '' : 's'}${f.q ? ` matching “${esc(f.q)}”` : ''}</h2>
      ${list.length ? `<div class="grid g2">${list.map(resourceCard).join('')}</div>` : '<div class="card">No resources match. Try fewer words, or clear the filters.</div>'}`;
  }

  // ---------- resource detail ----------
  function calendar(r) {
    const av = r.availability, lo = OB.hm(av.start), hi = OB.hm(av.end), now = E().now(), out = [];
    for (let i = 0; i < 7; i++) {
      const day = OB.startOfDay(now + i * DAY), dow = new Date(day).getDay(), label = `${i === 0 ? 'Today' : fmtD(day).replace(/,.*/, '')} ${new Date(day).getDate()}`;
      if (!av.days.includes(dow)) { out.push(`<div class="calrow"><div class="calday">${esc(label)}</div><div class="calbar"><span class="closed">Closed</span></div></div>`); continue; }
      const from = day + lo * MIN, to = day + hi * MIN, pct = ms => Math.max(0, Math.min(100, (ms - from) / (to - from) * 100));
      const segs = E().busyBlocks(r.id, from, to).map(b => `<span class="seg ${b.kind}" style="left:${pct(b.start)}%;width:${pct(b.end) - pct(b.start)}%" title="${b.kind === 'pending' ? 'Request pending' : 'Booked'} ${esc(fmtT(b.start))}–${esc(fmtT(b.end))}"></span>`).join('');
      const past = now > from ? `<span class="seg" style="left:0;width:${pct(now)}%;background:var(--mute-bg);opacity:.9"></span>` : '';
      out.push(`<div class="calrow"><div class="calday">${esc(label)}</div><div class="calbar"><span class="seg open" style="left:0;width:100%"></span>${segs}${past}</div></div>`);
    }
    return `<div class="calaxis"><span></span><div><span>${av.start}</span><span>${av.end}</span></div></div>${out.join('')}
      <div class="legend"><span><i style="background:var(--ok-bg)"></i>Free</span><span><i style="background:var(--err)"></i>Booked</span><span><i style="background:var(--warn)"></i>Request pending</span></div>`;
  }
  function checksList(checks) {
    return `<ul class="checks">${checks.map(c => `<li class="${c.pass ? 'pass' : 'fail'}"><span class="mark" aria-hidden="true">${c.pass ? '✓' : '✕'}</span><span class="sr">${c.pass ? 'Met:' : 'Not met:'}</span><div><b>${esc(c.label)}</b><small>${esc(c.pass ? c.detail : (c.fix || c.detail))}</small></div></li>`).join('')}</ul>`;
  }
  function defaultSlot(r) {
    const now = E().now(), av = r.availability;
    for (let i = 0; i < 15; i++) {
      const d = new Date(OB.startOfDay(now + i * DAY)); if (!av.days.includes(d.getDay())) continue;
      const end = d.getTime() + OB.hm(av.end) * MIN; if (end - now < 2 * HOUR) continue;
      return { date: ymd(d.getTime()), time: av.start };
    }
    return { date: ymd(now + DAY), time: av.start };
  }
  function viewResource(id) {
    const r = E().res(id); if (!r) return `<p>Resource not found. <a href="#/">Back to Discover</a></p>`;
    const u = me(), el = E().eligibility(u.id, r.id), av = r.availability, L = r.limits, staff = E().canManage(u.id, r), d = defaultSlot(r);
    const durs = []; for (let h = 0.5; h <= L.maxHoursPerBooking + 1e-9; h += 0.5) durs.push(h);
    const recent = staff ? E().db.bookings.filter(b => b.resourceId === r.id).sort((a, b) => b.start - a.start).slice(0, 8) : [];
    return `<a class="back" href="#/">← All resources</a>
      <div class="split"><div class="stack">
        <div class="card"><div class="row between"><div><h1>${EMOJI[r.category] || ''} ${esc(r.name)}</h1><p class="muted">${esc(r.category)} · ${esc(r.location)} · owned by ${esc(E().name(r.ownerId))}</p></div>
          <div>${r.status === 'active' ? chip('Accepting requests', 'ok') : chip(r.status === 'paused' ? 'Paused' : 'Maintenance', 'err')}</div></div>
          ${r.status !== 'active' ? `<div class="banner err">${esc(r.statusNote || '')}</div>` : ''}
          <p>${esc(r.description)}</p>
          <h3>Usage rules &amp; conditions</h3><p style="white-space:pre-wrap">${esc(r.rules)}</p>${r.requiresSupervision ? '<div class="banner info">🧑‍🏫 Staff supervision is required for every session.</div>' : ''}
          <h3>Access terms</h3><ul class="small"><li>Open ${esc(daysText(av.days))}, ${av.start}–${av.end}</li><li>Up to ${L.maxHoursPerBooking} h per booking · ${L.maxHoursPerWeek} h per person per week · ${L.maxActive} open request(s) at a time · up to ${L.maxAdvanceDays} days ahead</li>
          <li>${r.creditsPerHour ? r.creditsPerHour + ' credits per hour' : 'Free to use'}${r.deposit ? ` · ${r.deposit}-credit refundable deposit (held until the return is confirmed and any damage report is resolved)` : ''}</li>
          <li>Return checklist: ${esc(r.checklist.join('; '))}</li></ul>
          <div>${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
        <div class="card"><h2>Availability — next 7 days</h2>${calendar(r)}</div>
        ${staff ? `<div class="card"><div class="row between"><h2>Resource controls</h2><div class="row">${E().user(u.id).role === 'admin' || r.ownerId === u.id ? `<a class="btn sm" href="#/resource/${r.id}/edit">Edit listing</a>` : ''}
          <button class="btn sm" data-act="rstatus" data-id="${r.id}">Pause / maintenance / reopen</button></div></div>
          <p class="small muted">Managers: ${r.managerIds.length ? r.managerIds.map(m => esc(E().name(m)) + (r.ownerId === u.id || u.role === 'admin' ? ` <button class="btn sm ghost" data-act="rmmgr" data-id="${r.id}" data-uid="${m}" aria-label="Remove ${esc(E().name(m))}">✕</button>` : '')).join(', ') : 'none'}</p>
          ${r.ownerId === u.id || u.role === 'admin' ? `<form class="row" data-form="addmgr" data-id="${r.id}"><label class="sr" for="mg">Manager email</label><input id="mg" name="email" type="email" placeholder="manager email" style="max-width:260px" required><button class="btn sm">Add manager</button></form>` : ''}
          <h3 style="margin-top:1rem">Recent bookings</h3>${recent.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Status</th><th></th></tr></thead><tbody>${recent.map(b => `<tr><td>${when(b)}</td><td>${esc(E().name(b.userId))}</td><td>${bchip(b)}</td><td>${blink(b)}</td></tr>`).join('')}</tbody></table></div>` : empty('No bookings yet.')}</div>` : ''}
      </div>
      <aside class="stack"><div class="card"><h2>Can I use this?</h2>${checksList(el.checks)}
        ${el.eligible ? '<div class="banner ok">You meet every access requirement.</div>' : '<div class="banner warn">You don’t meet every requirement yet. Fix the items marked ✕ — see Profile → Training &amp; credentials.</div>'}</div>
        <form class="card" data-form="request" data-id="${r.id}" id="reqform"><h2>Request a booking</h2>
          <div class="field"><label for="rd">Date</label><input id="rd" name="date" type="date" value="${d.date}" min="${ymd(E().now())}" required></div>
          <div class="row"><div class="field" style="flex:1"><label for="rt">Start time</label><input id="rt" name="time" type="time" step="900" value="${d.time}" required></div>
          <div class="field" style="flex:1"><label for="rl">Duration</label><select id="rl" name="dur">${durs.map(h => `<option value="${h}" ${h === Math.min(1, L.maxHoursPerBooking) ? 'selected' : ''}>${h} h</option>`).join('')}</select></div></div>
          <div class="field"><label for="rpu">What will you use it for?</label><textarea id="rpu" name="purpose" rows="3" required minlength="10" placeholder="A short description helps the owner decide."></textarea></div>
          <div id="preview" aria-live="polite"></div><button class="btn primary" id="reqbtn">Submit request</button></form></aside></div>`;
  }
  function updatePreview() {
    const f = $('#reqform'); if (!f) return;
    const r = E().res(f.dataset.id), fd = new FormData(f);
    const start = new Date(fd.get('date') + 'T' + fd.get('time')).getTime(), end = start + Number(fd.get('dur')) * HOUR;
    const p = E().previewRequest(S.uid, r.id, start, end);
    const failing = [...p.eligibility.checks, ...p.slot].filter(c => !c.pass);
    const kind = !p.canSubmit ? 'err' : p.outcome === 'waitlist' ? 'info' : 'ok';
    const head = !p.canSubmit ? 'This request can’t be submitted yet' : p.outcome === 'waitlist' ? 'This time is taken — you’ll join the fair waitlist' : 'Ready to submit — goes to the owner for review';
    $('#preview').innerHTML = `<div class="banner ${kind}"><b>${head}</b>${!p.canSubmit ? `<ul>${failing.map(c => `<li>${esc(c.label)} — ${esc(c.fix || c.detail)}</li>`).join('')}</ul>` : `<ul>${p.explanation.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`}</div>
      <p class="small muted">Cost if approved: <b>${p.cost}</b> credits${p.deposit ? ` + ${p.deposit} deposit held (refunded after a clean return)` : ''}. Nothing is charged until the owner approves.</p>`;
    $('#reqbtn').textContent = p.outcome === 'waitlist' && p.canSubmit ? 'Join waitlist' : 'Submit request';
  }

  // ---------- booking page ----------
  const photoField = name => `<div class="field"><label for="ph_${name}">Photo of condition (optional)</label><input id="ph_${name}" type="file" accept="image/*" data-photo><div class="photoprev"></div></div>`;
  function condForm(r, key, title, submit) {
    return `<h3>${esc(title)}</h3><fieldset class="field"><legend>Overall condition</legend>${OB.RATINGS.map((x, i) => `<label class="chk" style="margin-right:.8rem"><input type="radio" name="rating" value="${x}" ${i === 1 ? 'checked' : ''}> ${x[0].toUpperCase() + x.slice(1)}</label>`).join('')}</fieldset>
      <fieldset class="field"><legend>Checklist</legend>${r.checklist.map(c => `<label class="chk" style="display:flex"><input type="checkbox" name="chk" value="${esc(c)}" checked> ${esc(c)}</label>`).join('')}<small class="muted">Untick anything that is wrong or missing and explain below.</small></fieldset>
      <div class="field"><label for="nt_${key}">Notes (required for “fair” or “damaged”)</label><textarea id="nt_${key}" name="notes" rows="2"></textarea></div>${photoField(key)}<button class="btn primary">${esc(submit)}</button>`;
  }
  const parseCond = fd => ({ rating: fd.get('rating'), notes: String(fd.get('notes') || ''), checklist: Object.fromEntries(fd.getAll('chk').map(c => [c, true])), photo: S.photo });
  function condView(c, title, r) {
    if (!c) return `<div class="cond empty"><b>${esc(title)}</b><p class="muted small">Not recorded yet.</p></div>`;
    const bad = Object.entries(c.checklist).filter(([, v]) => !v).map(([k]) => k);
    return `<div class="cond"><b>${esc(title)}</b> <span class="muted small">${esc(fmtDT(c.at))} by ${esc(E().name(c.by))}</span><div class="row" style="margin:.4rem 0">${chip(c.rating[0].toUpperCase() + c.rating.slice(1), c.rating === 'damaged' ? 'err' : c.rating === 'fair' ? 'warn' : 'ok')}</div>
      ${bad.length ? `<p class="small" style="color:var(--err)">Checklist issues: ${esc(bad.join(', '))}</p>` : '<p class="small muted">Checklist complete.</p>'}${c.notes ? `<p class="small">“${esc(c.notes)}”</p>` : ''}${c.photo ? `<img class="photo" alt="Condition photo, ${esc(title)}" src="${esc(c.photo)}">` : ''}</div>`;
  }
  function priorityTable(p) {
    return `<table class="mini"><tbody>${p.parts.map(x => `<tr><td>${esc(x.label)}</td><td class="num">${x.points > 0 && x.label !== 'Base score' ? '+' : ''}${x.points}</td></tr>`).join('')}</tbody><tfoot><tr><th>Priority score</th><th class="num">${p.total}</th></tr></tfoot></table>`;
  }
  function viewBooking(id) {
    const b = E().bk(id), u = me(); if (!b) return `<p>Booking not found. <a href="#/bookings">My bookings</a></p>`;
    const r = E().res(b.resourceId), mine = b.userId === u.id, staff = E().canManage(u.id, r);
    if (!mine && !staff) return `<div class="card"><h2>Not available</h2><p>You can only open bookings you made or that are for resources you manage (privacy).</p><a href="#/bookings">Back</a></div>`;
    const pend = E().db.extensions.filter(x => x.bookingId === b.id && x.status === 'pending')[0];
    const comp = staff && ['requested', 'waitlisted'].includes(b.status) ? E().competitors(b.id) : [];
    const hist = E().auditFor(u.id, { bookingId: b.id }).slice().reverse(), incs = b.incidentIds.map(i => E().inc(i));
    const canCancel = ['requested', 'waitlisted', 'approved'].includes(b.status) && (mine || staff);
    let actions = '';
    if (staff && !mine && b.status === 'requested') actions += `<div class="card"><h2>Your decision</h2><p class="small muted">Every decision is recorded with your reason, and the requester sees it.</p><div class="row"><button class="btn ok" data-act="decide" data-d="approve" data-id="${b.id}">Approve</button><button class="btn" data-act="decide" data-d="waitlist" data-id="${b.id}">Waitlist</button><button class="btn danger" data-act="decide" data-d="reject" data-id="${b.id}">Reject</button></div></div>`;
    if (staff && !mine && b.status === 'waitlisted') actions += `<div class="card"><h2>Waitlisted request</h2><p class="small muted">It will move to review automatically if the slot frees up.</p><button class="btn danger" data-act="decide" data-d="reject" data-id="${b.id}">Reject</button></div>`;
    if (b.status === 'approved' && (mine || staff)) actions += `<form class="card" data-form="checkin" data-id="${b.id}"><h2>Check in</h2><p class="small muted">Opens ${OB.CFG.EARLY_CHECKIN_MIN} min before the start. Record the condition <b>before</b> you use it — this protects you from being blamed for earlier damage.</p>${condForm(r, 'in', 'Initial condition', 'Check in')}</form>`;
    if (b.status === 'checked_in' && (mine || staff)) actions += `<form class="card" data-form="checkout" data-id="${b.id}"><h2>Return</h2>${E().isOverdue(b) ? '<div class="banner err">This booking is overdue. Please return it now.</div>' : ''}${condForm(r, 'out', 'Final condition', 'Return resource')}</form>`;
    if (b.status === 'checked_in' && mine && !pend) actions += `<div class="card"><h2>Need more time?</h2><form class="row" data-form="extreq" data-id="${b.id}"><label class="sr" for="xm">Extra minutes</label><select id="xm" name="minutes" style="max-width:150px"><option>15</option><option>30</option><option>45</option><option>60</option></select><button class="btn">Request extension</button></form></div>`;
    if (b.status === 'approved' && mine && !pend) actions += `<div class="card"><h2>Need more time?</h2><form class="row" data-form="extreq" data-id="${b.id}"><label class="sr" for="xm">Extra minutes</label><select id="xm" name="minutes" style="max-width:150px"><option>15</option><option>30</option><option>60</option></select><button class="btn">Request extension</button></form></div>`;
    if (pend) actions += `<div class="card"><h2>Extension requested</h2><p>+${pend.minutes} minutes (until ${esc(fmtT(pend.newEnd))}).</p>${staff && !mine ? `<div class="row"><button class="btn ok" data-act="ext" data-yes="1" data-id="${pend.id}">Approve</button><button class="btn danger" data-act="ext" data-yes="0" data-id="${pend.id}">Decline</button></div>` : '<p class="muted small">Waiting for staff.</p>'}</div>`;
    if (b.status === 'returned' && staff && !mine) actions += `<form class="card" data-form="confirm" data-id="${b.id}"><h2>Confirm return</h2><p class="small muted">Check the resource and compare with the before/after records. ${b.conditionWorsened ? '<b style="color:var(--err)">Condition is worse than at check-in.</b>' : ''}</p>
      <div class="field"><label for="cn">Staff notes (optional)</label><textarea id="cn" name="notes" rows="2"></textarea></div>
      <div class="field"><label class="chk"><input type="checkbox" name="dmg"> Report damage found on inspection</label></div><div class="field"><label for="cd">Damage description</label><textarea id="cd" name="damage" rows="2" placeholder="What is damaged, and how?"></textarea></div>
      <div class="field"><label for="cs">Severity</label><select id="cs" name="sev"><option>low</option><option selected>medium</option><option>high</option></select></div><button class="btn primary">Confirm return &amp; release deposit</button></form>`;
    const priorityBlock = ['requested', 'waitlisted'].includes(b.status) ? `<div class="card"><h2>Fair-allocation score${mine ? ' (yours)' : ''}</h2>${priorityTable(E().priority(b))}${b.status === 'waitlisted' ? `<p class="small">Waitlist position: <b>${E().waitlistPosition(b)}</b></p>` : ''}<p class="small muted">Scores are public and rule-based: waiting time and low recent use raise priority; heavy recent use and reviewed strikes lower it. The owner always makes the final decision.</p></div>` : '';
    const compBlock = comp.length ? `<div class="card"><h2>Competing requests for this time</h2><p class="small muted">Shown so the decision is transparent. Highest priority first.</p><div class="tablewrap"><table><thead><tr><th>User</th><th>Time</th><th>Status</th><th>Priority</th></tr></thead><tbody>${comp.map(c => `<tr><td>${esc(E().name(c.booking.userId))}</td><td>${when(c.booking)}</td><td>${bchip(c.booking)}</td><td><details><summary><b>${c.priority.total}</b></summary>${priorityTable(c.priority)}</details></td></tr>`).join('')}</tbody></table></div></div>` : '';
    return `<a class="back" href="#/bookings">← Bookings</a><div class="split"><div class="stack">
      <div class="card"><div class="row between"><div><h1>${rlink(r)}</h1><p class="muted">${when(b)} · requested by ${esc(E().name(b.userId))}</p></div><div>${bchip(b)}</div></div>
        <p><b>Purpose:</b> ${esc(b.purpose)}</p><p class="small muted">Cost ${b.cost} credits${b.deposit ? ` · deposit ${b.deposit} (${esc(b.depositState === 'none' ? 'not yet held' : b.depositState)})` : ''}${b.lateMinutes ? ` · returned ${b.lateMinutes} min late` : ''}</p>
        <div class="row">${canCancel ? `<button class="btn danger sm" data-act="cancel" data-id="${b.id}">Cancel booking</button>` : ''}${['approved', 'checked_in', 'returned', 'completed'].includes(b.status) ? `<button class="btn sm" data-act="incnew" data-id="${b.id}">Report an issue</button>` : ''}</div></div>
      <div class="card"><h2>Why is it in this state?</h2><ul class="why">${b.why.slice().reverse().map(w => `<li><b>${esc(w.by === 'system' ? 'System' : E().name(w.by))}</b> <span class="muted small">${esc(fmtDT(w.ts))}</span><br>${esc(w.text)}</li>`).join('')}</ul></div>
      ${actions}${compBlock}
      <div class="card"><h2>Condition records</h2><div class="condgrid">${condView(b.checkIn, 'Before use (check-in)', r)}${condView(b.checkOut, 'After use (return)', r)}</div></div>
      ${incs.length ? `<div class="card"><h2>Incidents</h2>${incs.map(i => `<p><a href="#/incident/${i.id}">${esc(i.type)} — ${esc(i.description.slice(0, 90))}</a> ${chip(INC[i.status][0], INC[i.status][1])}</p>`).join('')}</div>` : ''}
      </div><aside class="stack">${priorityBlock}<div class="card"><h2>Complete history</h2>${hist.length ? `<ul class="timeline">${hist.map(e => `<li class="${e.actorId === 'system' ? 'sys' : ''}"><b>${esc(ACTION_LABEL[e.action] || e.action)}</b><br><span class="small">${esc(e.detail)}</span>${e.reason ? `<br><span class="small muted">“${esc(e.reason)}”</span>` : ''}<br><time>${esc(fmtDT(e.ts))} · ${esc(E().name(e.actorId))}</time></li>`).join('')}</ul>` : empty('No history.')}<p class="small muted">Both parties see the same record. <a href="#/history">Open the full activity log</a>.</p></div></aside></div>`;
  }

  // ---------- my bookings & manage ----------
  function bookingTable(list, withUser) {
    if (!list.length) return empty('Nothing here.');
    return `<div class="tablewrap"><table><thead><tr><th>Resource</th><th>When</th>${withUser ? '<th>Requested by</th>' : ''}<th>Status</th><th></th></tr></thead><tbody>${list.map(b => `<tr><td>${rlink(E().res(b.resourceId))}</td><td>${when(b)}</td>${withUser ? `<td>${esc(E().name(b.userId))}</td>` : ''}<td>${bchip(b)}</td><td>${blink(b, 'View')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function viewBookings() {
    const u = me(), all = E().db.bookings.filter(b => b.userId === u.id).sort((a, b) => b.start - a.start);
    const open = all.filter(b => ['requested', 'waitlisted', 'approved', 'checked_in', 'returned'].includes(b.status)), past = all.filter(b => !open.includes(b));
    const used = E().usageStats(u.id);
    return `<h1>My bookings</h1><div class="kpis"><div class="kpi"><b>${open.length}</b><span>Open</span></div><div class="kpi"><b>${used.completed}</b><span>Completed</span></div><div class="kpi"><b>${used.hours30} h</b><span>Used in last 30 days</span></div><div class="kpi"><b>${u.credits}</b><span>Credits</span></div></div>
      <div class="card"><h2>Open &amp; upcoming</h2>${bookingTable(open)}</div><div class="card" style="margin-top:1rem"><h2>Past</h2>${bookingTable(past)}</div><p><a class="btn primary" href="#/">Find a resource</a></p>`;
  }
  function viewManage() {
    const u = me(), mine = E().managedResources(u.id), ids = new Set(mine.map(r => r.id));
    const bs = E().db.bookings.filter(b => ids.has(b.resourceId));
    const pend = bs.filter(b => b.status === 'requested').sort((a, b) => a.start - b.start), ret = bs.filter(b => b.status === 'returned'), use = bs.filter(b => b.status === 'checked_in');
    const wl = bs.filter(b => b.status === 'waitlisted'), appr = bs.filter(b => b.status === 'approved' && b.start > E().now()).sort((a, b) => a.start - b.start);
    const exts = E().db.extensions.filter(x => x.status === 'pending' && ids.has(E().bk(x.bookingId).resourceId));
    const claims = E().db.claims.filter(c => c.status === 'pending' && E().claimReviewers(c.trainingId).has(u.id));
    const incs = E().visibleIncidents(u.id).filter(i => i.status !== 'resolved' && ids.has(i.resourceId) || (u.role === 'admin' && i.status === 'disputed'));
    return `<h1>Manage</h1><div class="kpis"><div class="kpi"><b>${pend.length}</b><span>Need a decision</span></div><div class="kpi"><b>${ret.length}</b><span>Returns to confirm</span></div><div class="kpi"><b>${use.length}</b><span>In use now</span></div><div class="kpi"><b>${claims.length}</b><span>Training to verify</span></div><div class="kpi"><b>${incs.length}</b><span>Open incidents</span></div></div>
      <div class="stack"><div class="card"><h2>Requests awaiting your decision</h2>${bookingTable(pend, true)}</div>
      <div class="card"><h2>Returned — confirm &amp; inspect</h2>${bookingTable(ret, true)}</div><div class="card"><h2>In use now</h2>${bookingTable(use, true)}</div>
      ${exts.length ? `<div class="card"><h2>Extension requests</h2>${exts.map(x => { const b = E().bk(x.bookingId); return `<p>${esc(E().name(b.userId))} · ${rlink(E().res(b.resourceId))} +${x.minutes} min — ${blink(b, 'review')}</p>`; }).join('')}</div>` : ''}
      <div class="card"><h2>Training &amp; credential evidence to verify</h2>${claims.length ? `<div class="tablewrap"><table><thead><tr><th>Member</th><th>Training</th><th>Evidence</th><th></th></tr></thead><tbody>${claims.map(c => `<tr><td>${esc(E().name(c.userId))}</td><td>${esc(E().training(c.trainingId).name)}</td><td>${esc(c.evidence)}</td><td class="row"><button class="btn ok sm" data-act="claim" data-yes="1" data-id="${c.id}">Verify</button><button class="btn danger sm" data-act="claim" data-yes="0" data-id="${c.id}">Reject</button></td></tr>`).join('')}</tbody></table></div>` : empty('No evidence waiting.')}</div>
      ${incs.length ? `<div class="card"><h2>Open incidents</h2>${incs.map(i => `<p><a href="#/incident/${i.id}">${esc(i.type)} · ${esc(E().res(i.resourceId).name)}</a> — ${esc(i.description.slice(0, 90))} ${chip(INC[i.status][0], INC[i.status][1])}</p>`).join('')}</div>` : ''}
      <div class="card"><h2>Upcoming approved &amp; waitlisted</h2>${bookingTable([...appr, ...wl], true)}</div>
      <div class="card"><div class="row between"><h2>My resources</h2>${u.role === 'owner' || u.role === 'admin' ? '<a class="btn primary" href="#/resource/new">+ List a resource</a>' : ''}</div>
        ${mine.length ? `<div class="tablewrap"><table><thead><tr><th>Resource</th><th>Status</th><th>Role</th></tr></thead><tbody>${mine.map(r => `<tr><td>${rlink(r)}</td><td>${r.status === 'active' ? chip('Active', 'ok') : chip(r.status, 'err')}</td><td>${r.ownerId === u.id ? 'Owner' : 'Manager'}</td></tr>`).join('')}</tbody></table></div>` : empty('You do not manage any resources.')}</div></div>`;
  }

  // ---------- resource form ----------
  function viewResourceForm(id) {
    const u = me(), r = id ? E().res(id) : null;
    if (id && !r) return '<p>Not found.</p>';
    if (!(u.role === 'owner' || u.role === 'admin')) return `<div class="card"><h2>Owner access needed</h2><p>Only verified owners can list resources. Register with “I want to list resources” and ask an administrator to approve.</p></div>`;
    const v = r || { name: '', category: 'Fabrication', location: '', description: '', rules: '', tags: [], availability: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }, limits: { maxHoursPerBooking: 3, maxHoursPerWeek: 6, maxActive: 2, maxAdvanceDays: 14 }, creditsPerHour: 0, deposit: 0, eligibility: { trainings: [], allowedMemberships: [] }, checklist: ['Overall condition', 'All parts present'], requiresSupervision: false };
    const num = (n, label, val, step = 1, min = 0) => `<div class="field"><label for="f_${n}">${label}</label><input id="f_${n}" name="${n}" type="number" step="${step}" min="${min}" value="${val}" required></div>`;
    return `<a class="back" href="${r ? '#/resource/' + r.id : '#/manage'}">← Back</a><form class="card" data-form="resource" ${r ? `data-id="${r.id}"` : ''}><h1>${r ? 'Edit listing' : 'List a resource'}</h1>
      <div class="field"><label for="f_name">Name</label><input id="f_name" name="name" value="${esc(v.name)}" required></div>
      <div class="row"><div class="field" style="flex:1"><label for="f_cat">Category</label><select id="f_cat" name="category">${OB.CATEGORIES.map(c => `<option ${v.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field" style="flex:2"><label for="f_loc">Location</label><input id="f_loc" name="location" value="${esc(v.location)}" required></div></div>
      <div class="field"><label for="f_desc">Description</label><textarea id="f_desc" name="description" rows="3" required>${esc(v.description)}</textarea></div>
      <div class="field"><label for="f_rules">Usage rules &amp; conditions</label><textarea id="f_rules" name="rules" rows="3" required>${esc(v.rules)}</textarea></div>
      <div class="field"><label for="f_tags">Keywords (comma separated — used for matching)</label><input id="f_tags" name="tags" value="${esc(v.tags.join(', '))}"></div>
      <fieldset class="field"><legend>Open days</legend><div class="checkgrid">${OB.DAYNAMES.map((d, i) => `<label class="chk"><input type="checkbox" name="days" value="${i}" ${v.availability.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></fieldset>
      <div class="row"><div class="field"><label for="f_s">Opens</label><input id="f_s" type="time" name="start" value="${v.availability.start}" required></div><div class="field"><label for="f_e">Closes</label><input id="f_e" type="time" name="end" value="${v.availability.end}" required></div></div>
      <h3>Fair-use limits</h3><div class="row">${num('maxHoursPerBooking', 'Max hours per booking', v.limits.maxHoursPerBooking, 0.5, 0.5)}${num('maxHoursPerWeek', 'Max hours per person / week', v.limits.maxHoursPerWeek, 0.5, 0.5)}${num('maxActive', 'Open requests per person', v.limits.maxActive, 1, 1)}${num('maxAdvanceDays', 'Book up to (days ahead)', v.limits.maxAdvanceDays, 1, 1)}</div>
      <h3>Credits</h3><div class="row">${num('creditsPerHour', 'Credits per hour (0 = free)', v.creditsPerHour, 0.5)}${num('deposit', 'Refundable deposit', v.deposit, 1)}</div>
      <fieldset class="field"><legend>Required trainings / certifications</legend><div class="checkgrid">${E().db.trainings.map(t => `<label class="chk"><input type="checkbox" name="trainings" value="${t.id}" ${v.eligibility.trainings.includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div></fieldset>
      <fieldset class="field"><legend>Allowed membership types (none ticked = everyone verified)</legend><div class="checkgrid">${OB.MEMBERSHIPS.map(m => `<label class="chk"><input type="checkbox" name="mem" value="${m}" ${v.eligibility.allowedMemberships.includes(m) ? 'checked' : ''}> ${m}</label>`).join('')}</div></fieldset>
      <div class="field"><label for="f_chk">Condition checklist for check-in / return (one item per line)</label><textarea id="f_chk" name="checklist" rows="4">${esc(v.checklist.join('\n'))}</textarea></div>
      <div class="field"><label class="chk"><input type="checkbox" name="sup" ${v.requiresSupervision ? 'checked' : ''}> Staff supervision required</label></div>
      <button class="btn primary">${r ? 'Save changes' : 'Publish listing'}</button></form>`;
  }

  // ---------- incidents ----------
  function viewIncidents() {
    const list = E().visibleIncidents(S.uid);
    return `<h1>Incidents</h1><p class="muted">Damage, delays, no-shows and conflicts. Automatic records never apply a penalty — a person always reviews and decides, and users can dispute decisions.</p>
      <div class="card">${list.length ? `<div class="tablewrap"><table><thead><tr><th>Type</th><th>Resource</th><th>User</th><th>Reported</th><th>Status</th><th></th></tr></thead><tbody>${list.map(i => `<tr><td>${esc(i.type)}${i.auto ? ' <span class="muted small">(auto)</span>' : ''}${i.preExisting ? ' <span class="muted small">(pre-existing)</span>' : ''}</td><td>${rlink(E().res(i.resourceId))}</td><td>${esc(E().name(i.userId))}</td><td>${esc(fmtDT(i.createdAt))}</td><td>${chip(INC[i.status][0], INC[i.status][1])}</td><td><a href="#/incident/${i.id}">Open</a></td></tr>`).join('')}</tbody></table></div>` : empty('No incidents. 🎉')}</div>`;
  }
  function viewIncident(id) {
    const i = E().inc(id), u = me(); if (!i) return '<p>Not found.</p>';
    const r = E().res(i.resourceId), b = E().bk(i.bookingId), staff = E().canManage(u.id, r), mine = i.userId === u.id;
    if (!staff && !mine) return `<div class="card"><h2>Not available</h2><p>Incidents are only visible to the user concerned and the resource staff.</p></div>`;
    const hist = E().auditFor(u.id, { incidentId: i.id }).slice().reverse();
    return `<a class="back" href="#/incidents">← Incidents</a><div class="split"><div class="stack"><div class="card"><div class="row between"><h1>${esc(i.type[0].toUpperCase() + i.type.slice(1))} incident</h1>${chip(INC[i.status][0], INC[i.status][1])}</div>
      <p class="muted">${rlink(r)} · ${blink(b, 'booking')} · user ${esc(E().name(i.userId))} · reported by ${esc(E().name(i.reporterId))}${i.auto ? ' (automatic record)' : ''}</p><p>${esc(i.description)}</p>${i.preExisting ? '<div class="banner info">Documented as already present at check-in — it cannot be penalised.</div>' : ''}
      ${i.disputeReason ? `<div class="banner warn"><b>Dispute from the user:</b> ${esc(i.disputeReason)}</div>` : ''}
      ${i.resolution ? `<div class="banner ${i.resolution.strike || i.resolution.forfeit ? 'err' : 'ok'}"><b>Decision by ${esc(E().name(i.resolution.by))}:</b> ${i.resolution.strike || i.resolution.forfeit ? [i.resolution.strike ? 'strike recorded' : '', i.resolution.forfeit ? 'deposit forfeited' : ''].filter(Boolean).join(' + ') : 'no penalty'}.<br>${esc(i.resolution.note)}</div>` : ''}
      <h3>Discussion</h3>${i.thread.length ? i.thread.map(t => `<div class="thread"><b>${esc(E().name(t.by))}</b> <span class="muted small">${esc(fmtDT(t.ts))}</span><br>${esc(t.text)}</div>`).join('') : empty('No comments yet.')}
      <form data-form="respond" data-id="${i.id}"><div class="field"><label for="rsp">Add a comment</label><textarea id="rsp" name="text" rows="2" required></textarea></div><button class="btn">Post comment</button></form></div>
      ${(staff && !mine && (i.status !== 'disputed' || u.role === 'admin')) ? `<form class="card" data-form="resolve" data-id="${i.id}"><h2>${i.status === 'disputed' ? 'Administrator ruling' : 'Review &amp; resolve'}</h2><p class="small muted">A penalty is never automatic. Record your reasoning — the user can see it and may dispute it.</p>
        <div class="field"><label class="chk"><input type="checkbox" name="strike" ${i.applied.strike ? 'checked' : ''} ${i.preExisting ? 'disabled' : ''}> Record a strike (${OB.CFG.STRIKE_LIMIT} strikes suspend the account pending admin review)</label></div>
        <div class="field"><label class="chk"><input type="checkbox" name="forfeit" ${i.applied.forfeit ? 'checked' : ''} ${i.preExisting || !b.deposit ? 'disabled' : ''}> Forfeit the ${b.deposit}-credit deposit</label></div>
        <div class="field"><label for="rn2">Reasoning</label><textarea id="rn2" name="note" rows="3" required></textarea></div><button class="btn primary">${i.status === 'resolved' ? 'Update decision' : 'Resolve incident'}</button></form>` : ''}
      ${mine && ['open', 'resolved'].includes(i.status) && !i.auto ? '' : ''}${mine && ['open', 'resolved'].includes(i.status) ? `<div class="card"><h2>Disagree?</h2><p class="small muted">Escalate to an administrator for an independent ruling.</p><button class="btn" data-act="dispute" data-id="${i.id}">Dispute this incident</button></div>` : ''}</div>
      <aside class="card"><h2>History</h2><ul class="timeline">${hist.map(e => `<li class="${e.actorId === 'system' ? 'sys' : ''}"><b>${esc(ACTION_LABEL[e.action] || e.action)}</b><br><span class="small">${esc(e.detail)}</span>${e.reason ? `<br><span class="small muted">“${esc(e.reason)}”</span>` : ''}<br><time>${esc(fmtDT(e.ts))} · ${esc(E().name(e.actorId))}</time></li>`).join('')}</ul></aside></div>`;
  }

  // ---------- activity log ----------
  function viewHistory() {
    const q = S.tab.hq || '', list = E().auditFor(S.uid, { q }), v = E().verifyAudit(), u = me();
    return `<h1>Activity log</h1><p class="muted">${u.role === 'admin' ? 'Every important action on the platform.' : 'Every action involving you or the resources you manage.'} Entries are chained with hashes, so any later edit is detectable.</p>
      <div class="banner ${v.valid ? 'ok' : 'err'}">${v.valid ? `✓ Integrity check passed — ${v.count} entries, chain unbroken.` : `✕ The log has been altered. First broken entry: #${v.brokenAt + 1}.`}</div>
      <form class="row" data-form="auditsearch" role="search" style="margin:.6rem 0"><label class="sr" for="aq">Search the log</label><input id="aq" name="q" value="${esc(q)}" placeholder="Search actions, names, reasons…" style="max-width:360px"><button class="btn">Search</button></form>
      <div class="card"><div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details &amp; reason</th><th>Seal</th></tr></thead><tbody>${list.slice(0, 200).map(e => `<tr><td class="small">${esc(fmtDT(e.ts))}</td><td>${esc(E().name(e.actorId))}</td><td>${esc(ACTION_LABEL[e.action] || e.action)}</td><td>${esc(e.detail)}${e.reason ? `<br><span class="muted small">“${esc(e.reason)}”</span>` : ''}${e.bookingId ? ` <a class="small" href="#/booking/${e.bookingId}">booking</a>` : ''}${e.incidentId ? ` <a class="small" href="#/incident/${e.incidentId}">incident</a>` : ''}</td><td class="mono small muted" title="Hash of this entry, chained to the previous one">${esc(String(e.hash).slice(0, 8))}</td></tr>`).join('')}</tbody></table></div>${list.length > 200 ? '<p class="muted small">Showing the 200 most recent entries.</p>' : ''}</div>`;
  }

  // ---------- profile ----------
  function viewProfile() {
    const u = me(), ledger = E().db.ledger.filter(l => l.userId === u.id).sort((a, b) => b.ts - a.ts).slice(0, 12), st = E().usageStats(u.id), claims = E().db.claims.filter(c => c.userId === u.id).sort((a, b) => b.createdAt - a.createdAt);
    const have = Object.keys(u.credentials);
    return `<h1>Profile</h1><div class="split"><div class="stack"><div class="card"><h2>${esc(u.name)}</h2><p class="muted">${esc(u.email)} · ${esc(roleName(u))} · ${esc(u.membership)} member<br>${esc(u.org)}</p>
      <p>${u.status === 'verified' ? chip('✓ Verified by the institution', 'ok') : chip(u.status, u.status === 'pending' ? 'warn' : 'err')}</p><p class="small muted">Your institutional ID (${esc(u.idRef.slice(0, 3))}•••) is visible only to administrators.</p></div>
      <div class="card"><h2>Training &amp; credentials</h2>${have.length ? `<ul>${have.map(t => `<li>${chip('✓ Verified', 'ok')} ${esc(E().training(t).name)} <span class="muted small">— valid until ${esc(fmtD(u.credentials[t].expires))}</span></li>`).join('')}</ul>` : empty('No verified trainings yet.')}
        <h3>Submit new evidence</h3><form data-form="claim"><div class="field"><label for="ct">Training</label><select id="ct" name="training">${E().db.trainings.filter(t => !u.credentials[t.id]).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="ce">Certificate number or reference</label><input id="ce" name="evidence" required placeholder="e.g. cert no., receipt, instructor name"></div><button class="btn">Submit for verification</button></form>
        ${claims.length ? `<h3>Your requests</h3>${claims.map(c => `<p class="small">${esc(E().training(c.trainingId).name)} — ${chip(c.status, c.status === 'approved' ? 'ok' : c.status === 'pending' ? 'warn' : 'err')} ${c.reason ? esc(c.reason) : ''}</p>`).join('')}` : ''}</div></div>
      <aside class="stack"><div class="card"><h2>Fair-use summary</h2><ul class="small"><li>${st.hours30} h used in the last 30 days</li><li>${st.completed} completed · ${st.cancelled} cancelled (${st.lateCancels} late) · ${st.noShows} no-shows · ${st.lateReturns} late returns</li><li>${st.strikes} reviewed strike${st.strikes === 1 ? '' : 's'} (suspension at ${OB.CFG.STRIKE_LIMIT})</li></ul></div>
      <div class="card"><h2>Credits · ${u.credits}</h2>${ledger.length ? `<table class="mini"><tbody>${ledger.map(l => `<tr><td>${esc(l.reason)}<br><span class="muted">${esc(fmtDT(l.ts))}</span></td><td class="num" style="color:${l.delta < 0 ? 'var(--err)' : 'var(--ok)'}">${l.delta > 0 ? '+' : ''}${l.delta}</td></tr>`).join('')}</tbody></table>` : empty('No credit activity yet.')}</div></aside></div>`;
  }

  // ---------- admin ----------
  function viewAdmin() {
    const u = me(); if (u.role !== 'admin') return '<div class="card"><h2>Administrators only</h2></div>';
    const pend = E().db.users.filter(x => x.status === 'pending'), flags = E().integrityFlags(), susp = E().db.users.filter(x => x.status === 'suspended'), disp = E().db.incidents.filter(i => i.status === 'disputed');
    const v = E().verifyAudit();
    return `<h1>Administration</h1><div class="kpis"><div class="kpi"><b>${pend.length}</b><span>Accounts to verify</span></div><div class="kpi"><b>${disp.length}</b><span>Disputes to rule on</span></div><div class="kpi"><b>${susp.length}</b><span>Suspended</span></div><div class="kpi"><b>${E().db.audit.length}</b><span>Audit entries ${v.valid ? '✓' : '✕'}</span></div></div>
      <div class="stack"><div class="card"><h2>Accounts awaiting verification</h2>${pend.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Membership</th><th>ID reference</th><th>Wants owner</th><th></th></tr></thead><tbody>${pend.map(x => `<tr><td>${esc(x.name)}<br><span class="small muted">${esc(x.org)}</span></td><td>${esc(x.email)}</td><td>${esc(x.membership)}</td><td class="mono">${esc(x.idRef)}</td><td>${x.requestedRole ? 'Yes' : 'No'}</td><td class="row"><button class="btn ok sm" data-act="verify" data-yes="1" data-id="${x.id}">Verify</button><button class="btn danger sm" data-act="verify" data-yes="0" data-id="${x.id}">Reject</button></td></tr>`).join('')}</tbody></table></div>` : empty('All accounts are verified.')}</div>
      ${disp.length ? `<div class="card"><h2>Disputed incidents</h2>${disp.map(i => `<p><a href="#/incident/${i.id}">${esc(i.type)} — ${esc(E().name(i.userId))}</a>: ${esc(i.disputeReason)}</p>`).join('')}</div>` : ''}
      ${susp.length ? `<div class="card"><h2>Suspended accounts</h2>${susp.map(x => `<p>${esc(x.name)} (${x.strikes} strikes) <button class="btn sm" data-act="reinstate" data-id="${x.id}">Review &amp; reinstate</button></p>`).join('')}</div>` : ''}
      <div class="card"><h2>Fair-use flags <span class="muted small">(advisory — no automatic penalties)</span></h2>${flags.length ? flags.map(f => `<p><b>${esc(E().name(f.userId))}</b></p><ul class="small">${f.flags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`).join('') : empty('No unusual usage patterns detected.')}</div>
      <div class="card"><h2>Users &amp; roles</h2><div class="tablewrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Credits</th><th></th></tr></thead><tbody>${E().db.users.map(x => `<tr><td>${esc(x.name)}<br><span class="small muted">${esc(x.email)}</span></td>
        <td><form class="row" data-form="role" data-id="${x.id}"><label class="sr" for="ro_${x.id}">Role for ${esc(x.name)}</label><select id="ro_${x.id}" name="role" style="width:130px">${['user', 'owner', 'manager', 'admin'].map(r => `<option ${x.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select><button class="btn sm">Set</button></form></td>
        <td>${chip(x.status, x.status === 'verified' ? 'ok' : x.status === 'pending' ? 'warn' : 'err')}</td><td>${x.credits}</td><td><button class="btn sm" data-act="grant" data-id="${x.id}">Grant credits</button></td></tr>`).join('')}</tbody></table></div></div></div>`;
  }

  // ---------- router / render ----------
  function render() {
    const root = $('#app'), route = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!S.uid || !me()) {
      S.uid = null; root.innerHTML = route[0] === 'register' ? viewRegister() : viewLogin(); return;
    }
    if (route[0] === 'login' || route[0] === 'register') { location.hash = '#/'; return; }
    E().tick();
    let body;
    try {
      switch (route[0] || '') {
        case '': body = viewBrowse(); break;
        case 'resource': body = route[1] === 'new' ? viewResourceForm() : route[2] === 'edit' ? viewResourceForm(route[1]) : viewResource(route[1]); break;
        case 'booking': body = viewBooking(route[1]); break;
        case 'bookings': body = viewBookings(); break;
        case 'manage': body = E().isStaff(S.uid) ? viewManage() : '<div class="card"><h2>Staff only</h2></div>'; break;
        case 'incidents': body = viewIncidents(); break;
        case 'incident': body = viewIncident(route[1]); break;
        case 'history': body = viewHistory(); break;
        case 'profile': body = viewProfile(); break;
        case 'admin': body = viewAdmin(); break;
        default: body = '<div class="card"><h2>Page not found</h2><a href="#/">Go to Discover</a></div>';
      }
    } catch (e) { console.error(e); body = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a href="#/">Back to Discover</a></div>`; }
    const scroll = window.scrollY, active = document.activeElement && document.activeElement.id;
    root.innerHTML = shell(route, body);
    if (route[0] === 'resource' && route[1] && route[1] !== 'new' && route[2] !== 'edit') updatePreview();
    if (S._keepScroll) { window.scrollTo(0, scroll); S._keepScroll = false; }
    if (active && $('#' + active)) { try { $('#' + active).focus(); } catch (e) { /* ignore */ } }
  }
  window.addEventListener('hashchange', () => { S.showNotif = false; S.photo = null; render(); window.scrollTo(0, 0); const m = $('#main'); if (m) m.focus({ preventScroll: true }); });

  // ---------- events ----------
  document.addEventListener('input', ev => { if (ev.target.closest && ev.target.closest('#reqform')) updatePreview(); });
  document.addEventListener('change', ev => {
    const t = ev.target;
    if (t.closest && t.closest('#reqform')) updatePreview();
    if (t.id === 'eligOnly') { S.filter.eligible = t.checked; render(); }
    if (t.matches && t.matches('input[data-photo]') && t.files[0]) {
      const file = t.files[0], prev = t.parentElement.querySelector('.photoprev'), fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); S.photo = c.toDataURL('image/jpeg', 0.6);
          prev.innerHTML = `<img class="photo" alt="Selected photo preview" src="${S.photo}" style="max-height:140px">`;
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    }
  });
  function login(email, pw) { const u = E().login(email, pw); S.uid = u.id; ls.set(SKEY, u.id); location.hash = '#/'; render(); }
  document.addEventListener('submit', ev => {
    const f = ev.target.closest && ev.target.closest('form[data-form]'); if (!f) return;
    ev.preventDefault();
    const fd = new FormData(f), id = f.dataset.id, kind = f.dataset.form;
    const rid = () => { const m = location.hash.match(/booking\/(\w+)/); return m && m[1]; };
    const done = () => { S.photo = null; };
    switch (kind) {
      case 'login': return guard(() => login(fd.get('email'), fd.get('password')));
      case 'register': return guard(() => { const u = E().register({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password'), membership: fd.get('membership'), org: fd.get('org'), idRef: fd.get('idRef'), wantsOwner: fd.get('wantsOwner') === 'on' }); login(u.email, fd.get('password')); toast('Account created. An administrator will verify it.'); });
      case 'search': S.filter.q = String(fd.get('q') || ''); S.filter.category = String(fd.get('category') || ''); return render();
      case 'auditsearch': S.tab.hq = String(fd.get('q') || ''); return render();
      case 'request': return guard(() => {
        const start = new Date(fd.get('date') + 'T' + fd.get('time')).getTime(), end = start + Number(fd.get('dur')) * HOUR;
        const b = E().requestBooking(S.uid, { resourceId: id, start, end, purpose: fd.get('purpose') });
        toast(b.status === 'waitlisted' ? 'Added to the waitlist — see why on the next page.' : 'Request sent to the owner for review.'); location.hash = '#/booking/' + b.id;
      });
      case 'checkin': return guard(() => { E().checkIn(S.uid, id, parseCond(fd)); done(); }, 'Checked in. Condition recorded.');
      case 'checkout': return guard(() => { E().checkOut(S.uid, id, parseCond(fd)); done(); }, 'Returned. Staff will confirm.');
      case 'confirm': return guard(() => { E().confirmReturn(S.uid, id, { notes: fd.get('notes'), damage: fd.get('dmg') === 'on' ? { description: fd.get('damage'), severity: fd.get('sev') } : null }); }, 'Return confirmed.');
      case 'extreq': return guard(() => E().requestExtension(S.uid, id, fd.get('minutes')), 'Extension requested.');
      case 'resource': return guard(() => {
        const d = { name: fd.get('name'), category: fd.get('category'), location: fd.get('location'), description: fd.get('description'), rules: fd.get('rules'), tags: String(fd.get('tags') || '').split(','), days: fd.getAll('days'), start: fd.get('start'), end: fd.get('end'),
          maxHoursPerBooking: fd.get('maxHoursPerBooking'), maxHoursPerWeek: fd.get('maxHoursPerWeek'), maxActive: fd.get('maxActive'), maxAdvanceDays: fd.get('maxAdvanceDays'), creditsPerHour: fd.get('creditsPerHour'), deposit: fd.get('deposit'),
          trainings: fd.getAll('trainings'), allowedMemberships: fd.getAll('mem'), checklist: String(fd.get('checklist') || '').split('\n'), requiresSupervision: fd.get('sup') === 'on' };
        const r = id ? E().updateResource(S.uid, id, d) : E().createResource(S.uid, d); toast(id ? 'Listing updated.' : 'Resource listed.'); location.hash = '#/resource/' + r.id;
      });
      case 'claim': return guard(() => E().submitClaim(S.uid, fd.get('training'), fd.get('evidence')), 'Sent to the reviewers.');
      case 'addmgr': return guard(() => E().addManager(S.uid, id, fd.get('email')), 'Manager added.');
      case 'role': return guard(() => E().setRole(S.uid, id, fd.get('role')), 'Role updated.');
      case 'respond': return guard(() => E().respondIncident(S.uid, id, fd.get('text')), 'Comment posted.');
      case 'resolve': return guard(() => E().resolveIncident(S.uid, id, { strike: fd.get('strike') === 'on', forfeitDeposit: fd.get('forfeit') === 'on', note: fd.get('note') }), 'Decision recorded.');
    }
  });
  document.addEventListener('click', ev => {
    const back = ev.target.closest('[data-modal-back]'); if (back && ev.target === back) return closeModal();
    if (ev.target.closest('[data-close]')) return closeModal();
    if (S.showNotif && !ev.target.closest('.notif') && !ev.target.closest('[data-act=bell]')) { S.showNotif = false; render(); }
    const el = ev.target.closest('[data-act]'); if (!el || el.tagName === 'INPUT') return;
    const act = el.dataset.act, id = el.dataset.id, yes = el.dataset.yes === '1';
    switch (act) {
      case 'demo': return guard(() => login(el.dataset.email, 'demo123'));
      case 'logout': S.uid = null; ls.del(SKEY); location.hash = '#/login'; return render();
      case 'bell': S.showNotif = !S.showNotif; return render();
      case 'readall': E().db.notifications.filter(n => n.userId === S.uid).forEach(n => { n.read = true; }); E().save(); return render();
      case 'notif': { const n = E().db.notifications.find(x => x.id === id); if (n) { n.read = true; E().save(); } S.showNotif = false; if (el.dataset.link) { if (location.hash === el.dataset.link) render(); else location.hash = el.dataset.link; } else render(); return; }
      case 'clk': { const v = Number(el.dataset.v); if (v === 0) E().db.clockOffset = 0; else E().setNow(E().now() + v * MIN); E().tick(); E().save(); toast(v ? 'Clock moved forward.' : 'Clock reset.'); return render(); }
      case 'clk-next': {
        const u = me(), ms = E().db.bookings.filter(b => b.status === 'approved' && b.start > E().now() - 14 * MIN && (b.userId === u.id || E().canManage(u.id, E().res(b.resourceId)))).sort((a, b) => a.start - b.start)[0];
        if (!ms) return toast('You have no upcoming approved booking. Get one approved first.', true);
        E().setNow(ms.start); E().tick(); E().save(); toast('Moved to the start of ' + E().res(ms.resourceId).name + '. Check-in is open.'); location.hash = '#/booking/' + ms.id; return render();
      }
      case 'clk-overdue': {
        const u = me(), ms = E().db.bookings.filter(b => b.status === 'checked_in' && (b.userId === u.id || E().canManage(u.id, E().res(b.resourceId)))).sort((a, b) => a.end - b.end)[0];
        if (!ms) return toast('Nothing is in use right now. Check a booking in first.', true);
        E().setNow(ms.end + 20 * MIN); E().tick(); E().save(); toast('Moved 20 minutes past the end time.'); return render();
      }
      case 'reset': if (confirm('Reset all demo data and the clock?')) resetDemo(); return;
      case 'eligtoggle': return;
      case 'decide': {
        const d = el.dataset.d, T = { approve: ['Approve request', 'Approve', false, false], reject: ['Reject request', 'Reject request', true, true], waitlist: ['Place on waitlist', 'Waitlist', true, false] }[d];
        return modalForm({ title: T[0], intro: d === 'approve' ? 'Credits are charged and the deposit held on approval. Add a note if you like.' : 'The requester will see your reason.', submit: T[1], danger: d === 'reject', fields: [{ name: 'reason', label: d === 'approve' ? 'Note (optional)' : 'Reason', type: 'textarea', required: T[3] || d === 'waitlist' }] }, v => { E().decideBooking(S.uid, id, d, v.reason); toast('Decision recorded.'); });
      }
      case 'cancel': return modalForm({ title: 'Cancel booking', intro: 'Cancelling an approved booking less than 24 hours before the start is recorded as a late cancellation for fair-use review.', submit: 'Cancel booking', danger: true, fields: [{ name: 'reason', label: 'Reason', type: 'textarea' }] }, v => { E().cancelBooking(S.uid, id, v.reason); toast('Booking cancelled.'); });
      case 'ext': { const yesN = yes; return yesN ? guard(() => E().decideExtension(S.uid, id, true), 'Extension approved.') : modalForm({ title: 'Decline extension', submit: 'Decline', danger: true, fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }] }, v => E().decideExtension(S.uid, id, false, v.reason)); }
      case 'incnew': return modalForm({ title: 'Report an issue', intro: 'Reports are shared with the resource staff and recorded in the history.', submit: 'Submit report', fields: [{ name: 'type', label: 'Type', type: 'select', options: OB.INCIDENT_TYPES.map(t => [t, t]) }, { name: 'severity', label: 'Severity', type: 'select', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] }, { name: 'description', label: 'What happened?', type: 'textarea', required: true }] }, v => { const i = E().reportIncident(S.uid, id, v); toast('Reported.'); location.hash = '#/incident/' + i.id; });
      case 'dispute': return modalForm({ title: 'Dispute this incident', intro: 'An administrator will review it independently of the staff who decided.', submit: 'Escalate', fields: [{ name: 'reason', label: 'Why do you disagree?', type: 'textarea', required: true }] }, v => { E().disputeIncident(S.uid, id, v.reason); toast('Escalated to an administrator.'); });
      case 'rstatus': return modalForm({ title: 'Change availability', intro: 'Users with approved future bookings are notified.', submit: 'Update', fields: [{ name: 'status', label: 'Status', type: 'select', options: [['active', 'Active — accepting requests'], ['paused', 'Paused'], ['maintenance', 'Under maintenance']] }, { name: 'reason', label: 'Reason (shown to users when not active)', type: 'textarea' }] }, v => E().setResourceStatus(S.uid, id, v.status, v.reason));
      case 'rmmgr': return guard(() => E().removeManager(S.uid, id, el.dataset.uid), 'Manager removed.');
      case 'claim': return yes ? guard(() => E().reviewClaim(S.uid, id, true), 'Training verified.') : modalForm({ title: 'Reject evidence', submit: 'Reject', danger: true, fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }] }, v => E().reviewClaim(S.uid, id, false, v.reason));
      case 'verify': return yes ? guard(() => E().verifyUser(S.uid, id, true), 'Account verified.') : modalForm({ title: 'Reject account', submit: 'Reject', danger: true, fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }] }, v => E().verifyUser(S.uid, id, false, v.reason));
      case 'grant': return modalForm({ title: 'Grant credits', submit: 'Grant', fields: [{ name: 'amount', label: 'Amount (1–500)', type: 'number', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }] }, v => E().grantCredits(S.uid, id, v.amount, v.reason));
      case 'reinstate': return modalForm({ title: 'Reinstate account', submit: 'Reinstate', fields: [{ name: 'reason', label: 'Reason / review notes', type: 'textarea', required: true }] }, v => E().reinstateUser(S.uid, id, v.reason));
    }
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { if ($('[data-modal-form]')) closeModal(); else if (S.showNotif) { S.showNotif = false; render(); } } });

  // keep time-driven events live (reminders, overdue, no-show) without clobbering forms the user is typing in
  setInterval(() => {
    if (!S.uid || $('[data-modal-form]')) return;
    const a = document.activeElement; if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { E().tick(); return; }
    if (E().tick()) { S._keepScroll = true; render(); }
  }, 20000);

  boot();
  if (!location.hash) location.hash = S.uid ? '#/' : '#/login';
  render();
})();
