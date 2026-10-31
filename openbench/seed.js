// Fictional demo data only. Institution, people and equipment are invented.
const { db, log } = require('./db');
const L = require('./lib');
const DAY = 864e5, H = 36e5;

function reset() {
  for (const t of ['users','sessions','resources','resource_managers','user_certs','cert_requests','bookings','extensions','incidents','notifications','audit']) db.run('DELETE FROM ' + t);
}
function seed() {
  const now = Date.now();
  // Future demo slots skip Sundays (most resources are closed) so the data always looks realistic
  const workday = off => { let d = off; if (off > 0) while (L.local(now + d * DAY).dow === 0) d++; return d; };
  const at = (off, hm) => L.toTs(L.local(now + workday(off) * DAY).date, hm);
  const pw = L.hashPw('demo1234');
  const U = (name, email, role, type, org, idn, status, strikes = 0) =>
    db.run('INSERT INTO users(name,email,pass_hash,role,member_type,org,id_number,status,strikes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', name, email, pw, role, type, org, idn, status, strikes, now - 30 * DAY).id;
  const NIT = 'Nalanda Institute of Technology (fictional)';
  const admin = U('Dr. Meera Iyer', 'admin@openbench.demo', 'admin', 'faculty', NIT, 'NIT-ADM-001', 'verified');
  const o1 = U('Prof. Arjun Rao', 'owner.fablab@openbench.demo', 'owner', 'faculty', NIT + ' - Fab Lab', 'NIT-FAC-114', 'verified');
  const o2 = U('Dr. Kavita Nair', 'owner.media@openbench.demo', 'owner', 'faculty', NIT + ' - Central Instrumentation & Media', 'NIT-FAC-207', 'verified');
  const mgr = U('Rohan Das', 'manager@openbench.demo', 'manager', 'staff', NIT + ' - Fab Lab technician', 'NIT-STF-031', 'verified');
  const ana = U('Ananya Sharma', 'ananya@openbench.demo', 'user', 'student', NIT + ' - B.Tech Mechanical', 'NIT-2022-0457', 'verified');
  const vik = U('Vikram Singh', 'vikram@openbench.demo', 'user', 'startup', 'Pixelforge Labs (fictional startup)', 'EXT-STP-0092', 'verified');
  const sara = U('Sara Khan', 'sara@openbench.demo', 'user', 'researcher', NIT + ' - PhD, Computer Science', 'NIT-PHD-0311', 'verified');
  const ish = U('Ishaan Patel', 'ishaan@openbench.demo', 'user', 'student', NIT + ' - B.Tech Electronics', 'NIT-2023-1120', 'verified', 1);
  const tom = U('Tom Becker', 'tom@openbench.demo', 'user', 'community', 'Riverside Maker Collective (fictional)', 'COM-0007', 'unverified');

  const R = (owner, name, cat, emoji, loc, desc, rules, tags, o) => db.run(
    `INSERT INTO resources(owner_id,name,category,emoji,location,description,rules,tags,required_cert,verified_only,allowed_types,supervised,auto_approve,high_demand,deposit,max_hours,max_active,weekly_quota,open_days,open_from,open_to,status,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`,
    owner, name, cat, emoji, loc, desc, rules, tags, o.cert || null, o.ver ?? 1, o.types || '', o.sup || 0, o.auto || 0, o.hd || 0, o.dep || 0, o.maxh || 4, o.act || 2, o.wk || 8,
    o.days || '1,2,3,4,5', o.from ?? 540, o.to ?? 1080, now - 20 * DAY).id;

  const laser = R(o1, '80W CO2 Laser Cutter', 'Fabrication', '🔦', 'Fab Lab, Block C, Room 012', 'Cuts and engraves acrylic, plywood, MDF, leather and card up to 900x600 mm. Staff-supervised sessions only.',
    'Bring your own material (no PVC or vinyl). Ventilation must stay on. Never leave the machine running unattended. Report any flame immediately.', 'laser,cutting,engraving,fabrication,acrylic,wood,makerspace', { cert: 'Laser Safety Level 1', types: 'student,faculty,researcher,startup', sup: 1, hd: 1, dep: 1000, maxh: 3, act: 1, wk: 6, days: '1,2,3,4,5,6', from: 600, to: 1080 });
  const printer = R(o1, 'Prusa 3D Printer Bay (4 printers)', 'Fabrication', '🧊', 'Fab Lab, Block C, Room 014', 'Four FDM printers (PLA/PETG). Slicing laptop provided. Good for prototypes and enclosures.',
    'Use only supplied filament types. First layer must be watched. Remove prints and clean the bed before you leave.', '3d,printing,prototype,fabrication,makerspace,plastic', { cert: '3D Printing Basics', dep: 500, maxh: 4, act: 2, wk: 8, days: '1,2,3,4,5,6', from: 540, to: 1140 });
  const cnc = R(o1, 'Benchtop CNC Router', 'Fabrication', '⚙️', 'Fab Lab, Block C, Room 016', 'Small-format CNC for wood, plastics and soft aluminium. PCB isolation milling possible.',
    'Eye and ear protection compulsory. Staff must approve the toolpath before the first cut.', 'cnc,milling,router,aluminium,wood,pcb,fabrication', { cert: 'CNC Safety', types: 'student,faculty,researcher,startup', sup: 1, hd: 1, dep: 2000, maxh: 2, act: 1, wk: 4 });
  const gpu = R(o2, 'GPU Workstation (RTX 4090, 128 GB RAM)', 'Computing', '🖥️', 'Computing Lab, Block A, Room 101', 'Single high-end workstation for model training, rendering and simulation. Remote shell access is not provided - use in person.',
    'No cryptocurrency mining. Save work to your own storage; the disk is wiped weekly. Jobs must be monitored.', 'gpu,ml,ai,training,deep,learning,render,compute,simulation', { types: 'student,faculty,researcher,startup', hd: 1, maxh: 8, act: 1, wk: 16, from: 480, to: 1200 });
  const camera = R(o2, 'Mirrorless Camera & Gimbal Kit', 'Media', '📷', 'Media Centre, Block B, Room 003', 'Full-frame mirrorless camera, 3 lenses, gimbal, tripod, two LED panels and audio recorder. In-house use or same-day loan.',
    'Return with all accessories and cards formatted. Report scratches or dust on the sensor.', 'camera,video,film,photo,shoot,gimbal,media', { dep: 1500, maxh: 6, act: 1, wk: 12, days: '1,2,3,4,5,6', from: 540, to: 1080 });
  const studio = R(o2, 'Podcast Studio Room', 'Spaces', '🎙️', 'Media Centre, Block B, Room 005', 'Acoustically treated room with 4 microphones, mixer and monitors. Seats 4.',
    'No food or drinks. Leave the room tidy. Do not change mixer routing.', 'studio,podcast,audio,record,room', { auto: 1, maxh: 2, act: 2, wk: 4, from: 540, to: 1260, days: '1,2,3,4,5,6' });
  const room = R(o2, 'Seminar Room B-204', 'Spaces', '🏛️', 'Block B, 2nd floor', 'Room for 30 with projector, whiteboards and video-conferencing. Open to verified community groups.',
    'Chairs reset to rows before leaving. No amplified music. Leave the projector powered off.', 'room,meeting,workshop,seminar,community', { auto: 1, maxh: 4, act: 2, wk: 12, days: '0,1,2,3,4,5,6', from: 480, to: 1260 });
  const scope = R(o2, 'Oscilloscope & Signal Analyzer Bench', 'Electronics', '📈', 'Electronics Lab, Block D, Room 210', '4-channel 500 MHz oscilloscope, spectrum analyzer, function generators and bench PSUs.',
    'Probe ratings must be respected. Mains-powered devices require an isolation transformer.', 'oscilloscope,electronics,circuit,signal,measure,debug,analyzer', { cert: 'Electronics Lab Safety', types: 'student,faculty,researcher,startup', dep: 800, maxh: 4, act: 2, wk: 10 });

  for (const r of [laser, printer, cnc]) db.run('INSERT INTO resource_managers VALUES(?,?)', r, mgr);
  const cert = (u, c, by) => db.run('INSERT INTO user_certs(user_id,cert,granted_by,granted_at,expires_at) VALUES(?,?,?,?,?)', u, c, by, now - 15 * DAY, now + 300 * DAY);
  cert(ana, 'Laser Safety Level 1', mgr); cert(ana, '3D Printing Basics', mgr); cert(ish, '3D Printing Basics', mgr); cert(ish, 'Laser Safety Level 1', mgr);
  cert(sara, 'Electronics Lab Safety', o2);

  const B = (resource, user, s, e, type, purpose, status, x = {}) => {
    const id = db.run(`INSERT INTO bookings(resource_id,user_id,start_ts,end_ts,purpose,purpose_type,status,decision_reason,decided_by,decided_at,priority_score,deposit_status,checkin_at,checkin_by,checkin_condition,checkin_notes,checkout_at,checkout_condition,checkout_notes,late_minutes,return_confirmed_at,return_confirmed_by,return_note,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, resource, user, s, e, purpose, type, status, x.reason || null, x.by || null, x.by ? Math.min(s, now) - 2 * H : null, x.score ?? null, x.dep || 'none',
      x.ci ? s : null, x.ci ? (x.ciBy || user) : null, x.ci || null, x.ciN || null, x.co ? e : null, x.co || null, x.coN || null, x.late || 0, x.conf ? e + H : null, x.conf ? x.by : null, x.confN || null, Math.min(s, now) - 3 * DAY).id;
    const ts0 = Math.min(s, now) - 3 * DAY;
    log({ actor: db.get('SELECT * FROM users WHERE id=?', user), action: 'booking_requested', entity: 'booking', entity_id: id, booking_id: id, resource_id: resource, details: { start: s, end: e, purpose_type: type }, ts: ts0 });
    if (x.by) log({ actor: db.get('SELECT * FROM users WHERE id=?', x.by), action: 'booking_approved', entity: 'booking', entity_id: id, booking_id: id, resource_id: resource, reason: x.reason, ts: ts0 + H });
    if (x.ci) log({ actor: db.get('SELECT * FROM users WHERE id=?', x.ciBy || user), action: 'check_in', entity: 'booking', entity_id: id, booking_id: id, resource_id: resource, details: { condition: x.ci, notes: x.ciN }, ts: s });
    if (x.co) log({ actor: db.get('SELECT * FROM users WHERE id=?', user), action: 'check_out', entity: 'booking', entity_id: id, booking_id: id, resource_id: resource, details: { condition: x.co, notes: x.coN, late_minutes: x.late || 0 }, ts: e });
    if (x.conf) log({ actor: db.get('SELECT * FROM users WHERE id=?', x.by), action: 'return_confirmed', entity: 'booking', entity_id: id, booking_id: id, resource_id: resource, details: { deposit: x.dep }, reason: x.confN, ts: e + H });
    return id;
  };
  // Dr Sara: heavy recent GPU use -> lower fairness priority (transparent)
  for (const d of [2, 4, 6, 9, 12]) B(gpu, sara, at(-d, '08:00'), at(-d, '16:00'), 'research', 'Transformer training run', 'completed', { reason: 'Meets all requirements', by: o2, ci: 'good', co: 'good', conf: 1 });
  // Past completed laser job (clean record)
  B(laser, ana, at(-5, '11:00'), at(-5, '13:00'), 'coursework', 'Acrylic gears for Machine Design course', 'completed', { reason: 'Coursework priority', by: mgr, dep: 'released', ci: 'good', ciBy: mgr, co: 'good', conf: 1, confN: 'Clean return. Deposit released.' });
  // Past print with minor damage -> resolved incident, warning, ishaan strike 1
  const bd = B(printer, ish, at(-3, '14:00'), at(-3, '16:00'), 'project', 'Enclosure prototype', 'completed', { reason: 'Approved', by: mgr, dep: 'withheld', ci: 'good', ciBy: mgr, co: 'fair', coN: 'Build plate scratched', conf: 1, confN: 'Deposit withheld for plate replacement.' });
  const inc = db.run(`INSERT INTO incidents(booking_id,resource_id,user_id,reporter_id,type,severity,description,summary,status,resolution,resolved_by,penalty,auto,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    bd, printer, ish, mgr, 'damage', 'medium', 'Build plate has a gouge from removing a print with a metal scraper.', 'Assistive summary (rule-generated, not a decision): damage incident, severity medium. Needs human review.', 'resolved', 'Plate replaced from deposit. Verbal warning about scraper use.', mgr, 'strike', 0, at(-3, '16:30'), at(-2, '10:00')).id;
  log({ actor: db.get('SELECT * FROM users WHERE id=?', mgr), action: 'incident_resolved', entity: 'incident', entity_id: inc, booking_id: bd, resource_id: printer, details: { penalty: 'strike' }, reason: 'Plate replaced from deposit. Verbal warning about scraper use.', ts: at(-2, '10:00') });
  // Live scenarios for the demo
  B(laser, ana, at(1, '11:00'), at(1, '13:00'), 'coursework', 'Laser-cut enclosure for capstone project', 'approved', { reason: 'Certified, coursework priority, no conflicts.', by: mgr, dep: 'held', score: 78 });
  const w = B(laser, ish, at(1, '12:00'), at(1, '14:00'), 'project', 'Cutting PCB stencil', 'waitlisted', { reason: 'This time overlaps an approved booking. You are on the waiting list and will be notified if the slot opens.' });
  B(printer, ana, at(2, '10:00'), at(2, '12:00'), 'coursework', 'Printing mechanism parts for Design Studio', 'pending');
  B(camera, vik, at(1, '09:00'), at(1, '14:00'), 'project', 'Product demo video for startup pitch', 'pending');
  // Overdue: checked in, window ended 30 minutes ago (the sweep will flag it)
  B(scope, sara, now - 3 * H, now - 30 * 60000, 'research', 'Characterising sensor front-end', 'checked_in', { reason: 'Certified', by: o2, ci: 'good', ciN: 'Probes present, bench tidy' });

  db.run('INSERT INTO notifications(user_id,ts,text,link) VALUES(?,?,?,?)', ana, now - H, 'Your laser cutter booking tomorrow was approved by Rohan Das.', '#/bookings');
  db.run('INSERT INTO cert_requests(user_id,resource_id,cert,note,created_at) VALUES(?,?,?,?,?)', vik, cnc, 'CNC Safety', 'Need to mill an aluminium bracket for our product.', now - 5 * H);
  return { w };
}
module.exports = { seed, reset };
