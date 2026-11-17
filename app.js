/* ที่จอดรถ — ระบบลงข้อมูลที่จอดรถของแผนก ITC2
   - ล็อกอินด้วย Google และใช้ได้เฉพาะอีเมลที่ผู้ดูแลเพิ่มไว้ (ตรวจซ้ำที่ Firestore Rules)
   - ข้อมูลอยู่ใน Firestore คอลเลกชัน "parkings" (รูปแบบเดิม ใช้ข้อมูลเก่าต่อได้) 1 เอกสาร = 1 รายการ, docKind = zone/perm/temp/trash
   - กันจองชนกันระหว่างเครื่องด้วยเอกสารดัชนีในคอลเลกชัน "locks" + transaction
   - เปิดด้วย ?demo=1 เพื่อทดลองโดยไม่เชื่อม Firebase (ข้อมูลอยู่ในเบราว์เซอร์นี้เท่านั้น) */
(() => {
'use strict';

/* ================= ค่าตั้งต้น ================= */
const firebaseConfig = {
  apiKey: 'AIzaSyD4P7YULqTyFn4D7A_TYPiUg9X0ablviAQ',
  authDomain: 'itc2-parking-system.firebaseapp.com',
  projectId: 'itc2-parking-system',
  storageBucket: 'itc2-parking-system.firebasestorage.app',
  messagingSenderId: '280376216669',
  appId: '1:280376216669:web:dfa2385ae970e217b1d1b4'
};
const TZ = 'Asia/Bangkok', COLL = 'parkings', LOCKS = 'locks', TRASH_MS = 30 * 864e5, DEMO_KEY = 'parking_demo_v4';
const FREE_ZONES = ['หน้าตึก 2.2', 'โรงไฟฟ้า'];
const PERM_ZONES = ['pilot plant', 'บ่อบำบัดน้ำเสีย'];
const KINDS = ['Supplier', 'ผู้ติดต่อภายนอก', 'ผู้สมัครงาน', 'ลูกค้า'];
const VIP_KIND = 'ลูกค้า VIP';
const TAG_TXT = { vip: 'ลูกค้า VIP', exec: 'ผู้บริหาร' };
const COMPANY_MAP = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('บริษัท ไอ-เทล คอร์ปอเรชั่น จำกัด (มหาชน) สมุทรสาคร');
const ST_TXT = { now: 'กำลังจอด', today: 'จะเข้าวันนี้', upcoming: 'จองล่วงหน้า', expired: 'สิ้นสุดแล้ว', cancelled: 'ยกเลิก' };
const DEMO = new URLSearchParams(location.search).has('demo');

/* ================= ตัวช่วย ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const nowHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const toD = s => new Date(s + 'T12:00:00+07:00');
const addDays = (s, n) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); };
const fD = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const fDS = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short' });
const fDL = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fTs = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDate = s => s ? fD.format(toD(s)) : '';
const fmtTs = ms => ms ? fTs.format(new Date(ms)) : '—';
const hm2m = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + m; };
const m2hm = m => { m = Math.max(0, Math.min(1439, Math.round(m))); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const normSlot = s => String(s ?? '').trim().toLowerCase();
const normPlate = p => String(p || '').replace(/[\s\-.]/g, '').toUpperCase();
/* ทะเบียนหลายคัน: คั่นด้วย , หรือเว้นวรรค เช่น "ฎณ9050 2ขก5950 8ขง92" → "ฎณ9050, 2ขก5950, 8ขง92" */
function fmtPlates(v) {
  const t = String(v || '').trim().replace(/\s+/g, ' '); if (!t) return '';
  let parts = /[,;\/\n]/.test(t) ? t.split(/[,;\/\n]+/) : (t.match(/\d?\s?[ก-ฮ]{1,3}\s?-?\s?\d{1,4}/g) || []);
  parts = parts.map(x => x.trim()).filter(Boolean);
  if (parts.length < 2 || normPlate(parts.join('')) !== normPlate(t.replace(/[,;\/\n]/g, ''))) return t;   // แยกไม่ครบ ใช้ตามที่พิมพ์
  return parts.join(', ');
}
const overlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
const safeUrl = u => /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(String(u || '')) ? String(u) : '';
const short = (s, n = 10) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const firstName = s => String(s || '').replace(/^(นาย|นางสาว|นาง|น\.ส\.|คุณ|mr\.?|mrs\.?|ms\.?|บจ\.|บมจ\.|หจก\.|บริษัท|ห้างหุ้นส่วนจำกัด)\s*/i, '').split(/\s+/)[0];
class UserErr extends Error {}

function parseSlots(text) {
  const out = [], seen = new Set();
  const add = l => { const k = normSlot(l); if (k && !seen.has(k)) { seen.add(k); out.push(String(l).trim()); } };
  String(text || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).forEach(tok => {
    const m = tok.match(/^([A-Za-z]*)(\d+)\s*[-–~]\s*\1?(\d+)$/);
    if (m) { let a = +m[2], b = +m[3]; if (a > b) [a, b] = [b, a]; if (b - a > 999) b = a + 999; for (let i = a; i <= b; i++) add(m[1] + i); } else add(tok);
  });
  return out.slice(0, 1000);
}
function slotsText(slots) {
  const out = []; let i = 0; const sp = v => { const m = String(v).match(/^([A-Za-z]*)(\d+)$/); return m ? [m[1], +m[2]] : null; };
  while (i < slots.length) {
    const a = sp(slots[i]);
    if (a) { let j = i; while (j + 1 < slots.length) { const b = sp(slots[j + 1]); if (b && b[0] === a[0] && b[1] === sp(slots[j])[1] + 1) j++; else break; }
      out.push(j > i + 1 ? `${slots[i]}-${slots[j]}` : j > i ? `${slots[i]}, ${slots[j]}` : slots[i]); i = j + 1; }
    else { out.push(slots[i]); i++; }
  }
  return out.join(', ');
}

/* ================= สถานะ ================= */
let docs = new Map();                 // id -> เอกสารดิบ (แหล่งข้อมูลจริง)
let db = { zones: [], permanent: [], temp: [], trash: [], checks: [] };
let user = null, isAdmin = false, isGuard = false, access = { members: [], admins: [], guards: [], names: {} };
/* บัญชีผู้ใช้: ล็อกอินด้วยชื่อผู้ใช้ + รหัสผ่าน (Firebase Email/Password) ผู้ดูแลสร้างบัญชีให้ใน Firebase Console
   ชื่อผู้ใช้ที่ไม่มี @ จะถูกแปลงเป็น <ชื่อ>@parking.local ภายในระบบ (ไม่มีการส่งอีเมลจริง) */
const USER_DOMAIN = 'parking.local';
const toLogin = u => { u = String(u || '').trim().toLowerCase(); return u.includes('@') ? u : `${u}@${USER_DOMAIN}`; };
const shortId = em => { em = String(em || ''); return em.endsWith('@' + USER_DOMAIN) ? em.slice(0, -(USER_DOMAIN.length + 1)) : em; };
const ROLE_TXT = { admin: 'ผู้ดูแลระบบ', member: 'สมาชิก', guard: 'ผู้ตรวจ (รปภ.)' };
function readAccess(d) { d = d || {}; return { members: d.members || [], admins: d.admins || [], guards: d.guards || [], names: d.names || {} }; }
function roleOf(em) { em = String(em || '').toLowerCase(); return access.admins.includes(em) ? 'admin' : access.members.includes(em) ? 'member' : access.guards.includes(em) ? 'guard' : ''; }
function applyRole() { const r = roleOf(user && user.email); isAdmin = r === 'admin'; isGuard = r === 'guard'; document.body.classList.toggle('as-guard', isGuard); return r; }
const GUARD_TABS = ['map', 'today', 'chk', 'set'];
/* รปภ. เพิ่มรถชั่วคราวได้ แก้/ยกเลิกได้เฉพาะรายการที่ตัวเองเพิ่ม (กฎ Firestore ตรวจซ้ำ) */
const ownTemp = t => !!t && !!t.createdAcct && t.createdAcct === myAcct();
const canEditTemp = t => !isGuard || ownTemp(t);
function guardTrim(root) {   // ซ่อนปุ่มที่ รปภ. ใช้ไม่ได้
  if (!isGuard || !root) return;
  root.querySelectorAll('[data-act]').forEach(b => {
    const a = b.dataset.act;
    if (a === 'edit-temp' || a === 'cancel-temp') { if (!canEditTemp(db.temp.find(x => x.id === b.dataset.id))) b.remove(); }
    else if (GUARD_DENY.has(a)) b.remove();
  });
  root.querySelectorAll('.p-actions').forEach(e => { if (!e.children.length) e.remove(); });
}
let fs = null, col = null, locks = null, auth = null, unsub = [];
let netState = 'wait';
const S = {                           // สถานะหน้าจอ
  tab: 'map', zone: null, cZone: null, cDate: today(), cSlot: null, vDate: today(), vFrom: '08:00', vTo: '17:00', follow: true, view3d: true, zoom: 1,
  sel: null, hl: null, pop: null, dtab: 'perm', tDate: today(), tZone: ''
};
try { const s = JSON.parse(sessionStorage.getItem('parking_ui') || '{}'); ['tab', 'zone', 'view3d', 'dtab', 'cZone', 'tZone'].forEach(k => { if (s[k] !== undefined) S[k] = s[k]; }); } catch (e) {}
const saveUi = () => { try { sessionStorage.setItem('parking_ui', JSON.stringify({ tab: S.tab, zone: S.zone, view3d: S.view3d, dtab: S.dtab, cZone: S.cZone, tZone: S.tZone })); } catch (e) {} };

const isPermZone = z => !!z && !z.free && (z.allowPerm !== undefined ? !!z.allowPerm : PERM_ZONES.includes(String(z.name).trim().toLowerCase()));
const tagOf = (z, s) => (z && z.tags && z.tags[normSlot(s)]) || '';
const isVip = (z, s) => tagOf(z, s) === 'vip';
// ช่องที่รับรถชั่วคราว: สถานที่ช่องประจำ (PILOT PLANT, บ่อบำบัด) รับเฉพาะช่อง VIP / สถานที่อื่นที่มีเลขช่องรับทุกช่อง
const tempSlotsOf = z => !z || z.free ? [] : isPermZone(z) ? z.slots.filter(s => isVip(z, s)) : z.slots;
const acceptsTemp = z => !!z && (z.free || tempSlotsOf(z).length > 0);
const permSlotsOf = z => !z || z.free ? [] : z.slots.filter(s => !isVip(z, s));
const getZone = id => db.zones.find(z => z.id === id);
const zoneName = id => (getZone(id) || { name: '(ไม่พบสถานที่)' }).name;
const capOf = z => z ? (z.free ? (+z.capacity || 0) : z.slots.length) : 0;
const hasSlot = (z, s) => !!z && z.slots.some(x => normSlot(x) === normSlot(s));
const by = () => user ? ((access.names || {})[user.email] || user.name || shortId(user.email)) : '';
const myAcct = () => user && user.email ? String(user.email).toLowerCase() : '';
const whoNow = () => { if (!isGuard) return by(); try { const c = curShift(), n = inspectorFor(c.date, c.sh); return n ? `${n} (${by()})` : by(); } catch (e) { return by(); } };
function stamp(r, a) { const n = Date.now(); r.createdAt = n; r.updatedAt = n; r.createdBy = whoNow(); r.createdAcct = myAcct(); r.log = [{ at: n, a, by: by() }]; return r; }
function touch(r, a) { const n = Date.now(); r.updatedAt = n; r.updatedBy = whoNow(); r.log = (r.log || []).concat({ at: n, a, by: whoNow() }).slice(-40); return r; }

/* จองชั่วคราวได้หลายวันต่อเนื่อง: date = วันแรก, dateTo = วันสุดท้าย (ไม่มี = วันเดียว) ใช้ช่วงเวลา from–to เดียวกันทุกวัน */
const MAX_DAYS = 186;   // จองต่อเนื่องได้สูงสุดประมาณ 6 เดือน
const dEnd = t => t.dateTo && t.dateTo > t.date ? t.dateTo : t.date;
const isMulti = t => dEnd(t) !== t.date;
const onDay = (t, d) => t.date <= d && d <= dEnd(t);
const spanDays = (a, b) => a.date <= dEnd(b) && b.date <= dEnd(a);
const dayCount = t => Math.round((toD(dEnd(t)) - toD(t.date)) / 864e5) + 1;
const daysOf = (t, from) => { const out = []; let d = from && from > t.date ? from : t.date; const e = dEnd(t); while (d <= e && out.length < MAX_DAYS + 1) { out.push(d); d = addDays(d, 1); } return out; };
const focusDate = t => t.date < today() && dEnd(t) >= today() ? today() : t.date;   // วันที่ใช้แสดงในผัง
const fmtRange = t => isMulti(t) ? `${fmtDate(t.date)} – ${fmtDate(dEnd(t))} (${dayCount(t)} วัน)` : fmtDate(t.date);
function tStatus(t) {
  if (t.cancelled) return 'cancelled';
  const d = today(), n = nowHM(), e = dEnd(t);
  if (e < d || (e === d && t.to <= n)) return 'expired';
  if (onDay(t, d)) return t.from <= n && n < t.to ? 'now' : n < t.from ? 'today' : 'upcoming';
  return 'upcoming';
}
const isLive = t => ['now', 'today', 'upcoming'].includes(tStatus(t));
// สถานะของรายการในวันใดวันหนึ่ง (ใช้ในหน้า วันนี้)
function dayStatus(t, d) {
  if (t.cancelled) return 'cancelled';
  const td = today(), n = nowHM();
  if (d < td || (d === td && t.to <= n)) return 'expired';
  if (d === td) return t.from <= n ? 'now' : 'today';
  return 'upcoming';
}

/* ================= สร้าง db จากเอกสาร ================= */
function rebuild() {
  const d = { zones: [], permanent: [], temp: [], trash: [], checks: [] };
  docs.forEach((o, id) => {
    const { docKind, ...rec } = JSON.parse(JSON.stringify(o)); if (!rec.id) rec.id = id;
    if (docKind === 'zone') d.zones.push(rec); else if (docKind === 'perm') d.permanent.push(rec);
    else if (docKind === 'temp') d.temp.push(rec); else if (docKind === 'trash') d.trash.push(rec);
    else if (docKind === 'check') d.checks.push(rec);
  });
  d.zones.sort((a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9) || String(a.name).localeCompare(b.name));
  d.zones.forEach(z => {
    if (z.free === undefined) z.free = !isPermZone(z) && FREE_ZONES.includes(String(z.name).trim());
    if (z.free) { const c = Math.floor(+z.capacity); z.capacity = c > 0 ? c : ((Array.isArray(z.slots) && z.slots.length) || 10); z.slots = []; }
    else {
      if (!Array.isArray(z.slots) || !z.slots.length) { z.slots = []; for (let i = 1; i <= (z.capacity || 0); i++) z.slots.push(String(i)); }
      d.permanent.forEach(p => { if (p.zone === z.id && p.slot && !z.slots.some(x => normSlot(x) === normSlot(p.slot))) z.slots.push(String(p.slot).trim()); });
      z.capacity = z.slots.length;
    }
    z.perRow = Math.max(2, Math.min(40, +z.perRow || (z.free ? 10 : z.slots.length > 30 ? 12 : 10)));
    z.tags = z.tags && typeof z.tags === 'object' ? z.tags : {};
  });
  d.temp.forEach(t => { if (t.slot == null) t.slot = ''; const z = d.zones.find(x => x.id === t.zone); if (z && z.free) t.slot = ''; t.from = t.from || '00:00'; t.to = t.to || '23:59'; });
  db = d;
  if (!db.zones.some(z => z.id === S.zone)) S.zone = db.zones[0] ? db.zones[0].id : null;
  if (!db.zones.some(z => z.id === S.cZone && !z.free)) { const c = db.zones.find(z => !z.free); S.cZone = c ? c.id : null; }
  purgeOldTrash();
  scheduleRender();
}
let purged = new Set();
function purgeOldTrash() {
  if (isGuard) return;   // ผู้ตรวจไม่มีสิทธิ์ลบ
  const old = db.trash.filter(x => x.deletedAt + TRASH_MS <= Date.now() && !purged.has(x.id));
  if (!old.length) return;
  old.forEach(x => purged.add(x.id));
  writeOps(old.map(x => ({ del: x.id })), true);
}

/* ================= ชั้นบันทึกข้อมูล (Firestore หรือโหมดสาธิต) ================= */
const toDoc = (kind, rec) => JSON.parse(JSON.stringify({ ...rec, docKind: kind }));   // ตัดค่า undefined (Firestore ไม่รับ)
function demoSave() { try { localStorage.setItem(DEMO_KEY, JSON.stringify([...docs.entries()])); } catch (e) { toast('บันทึกลงเบราว์เซอร์ไม่ได้'); } }
function writeErr(e) { console.error(e); toast(e && e.code === 'permission-denied' ? 'ไม่มีสิทธิ์บันทึกรายการนี้' : 'บันทึกขึ้นระบบกลางไม่สำเร็จ ระบบจะแสดงข้อมูลล่าสุดจากระบบกลาง'); }
/* ops: [{kind, rec}] หรือ [{del:id}] — อัปเดตหน้าจอทันที แล้วส่งขึ้นระบบกลาง (เขียนเฉพาะรายการที่เปลี่ยน) */
function writeOps(ops, quiet) {
  ops.forEach(o => o.del ? docs.delete(o.del) : docs.set(o.rec.id, toDoc(o.kind, o.rec)));
  if (!fs) { demoSave(); if (!quiet) rebuild(); return Promise.resolve(); }
  if (!quiet) rebuild();
  const jobs = [];
  for (let i = 0; i < ops.length; i += 400) {
    const b = fs.batch();
    ops.slice(i, i + 400).forEach(o => o.del ? b.delete(col.doc(o.del)) : b.set(col.doc(o.rec.id), toDoc(o.kind, o.rec)));
    jobs.push(b.commit());
  }
  return Promise.all(jobs).catch(e => { writeErr(e); throw e; });
}
const put = (kind, rec) => writeOps([{ kind, rec }]);

/* --- ดัชนีกันจองชน (locks) ---
   t_<zone>_<date> : { e: { <bookingId>: {s:slot, f:from, t:to, at} } }   จองชั่วคราวที่ยังใช้งาน
   p_<zone>        : { e: { <permId>: {s:slot, at} } }                     ช่องประจำของพนักงาน
   ทุกการจองอ่านดัชนีใน transaction เดียวกับการบันทึก จึงไม่มีสองเครื่องได้ช่องเดียวกัน */
const lockT = (z, d) => `t_${z}_${d}`, lockP = z => `p_${z}`, lockR = z => `r_${z}`;   // r_<zone> = จองหลายวัน { e: { id: {s,f,t,d1,d2,at} } }
const lockOf = t => isMulti(t) ? lockR(t.zone) : lockT(t.zone, t.date);
function lockEntries(snap) { return snap && snap.exists ? (snap.data().e || {}) : {}; }
function validEntry(id, v, kind) {   // ข้ามรายการในดัชนีที่ค้าง (ถูกลบ/ยกเลิกไปแล้ว) แต่เชื่อรายการใหม่ที่เครื่องนี้ยังไม่เห็น
  const r = kind === 'perm' ? db.permanent.find(p => p.id === id) : db.temp.find(t => t.id === id);
  if (r) return kind === 'perm' ? !!r.active : isLive(r);
  return Date.now() - (v.at || 0) < 10 * 60e3;
}
function dropLock(lid, id) {
  if (!fs) return;
  locks.doc(lid).update(new firebase.firestore.FieldPath('e', id), firebase.firestore.FieldValue.delete()).catch(() => {});
}

/* ================= กฎการจอง ================= */
function competitorsTemp(rec, day, lockE, rangeE) {   // รายการชั่วคราวอื่นในสถานที่เดียวกันที่ยังใช้งานในวันนั้น
  const list = db.temp.filter(t => t.id !== rec.id && t.zone === rec.zone && onDay(t, day) && isLiveOn(t, day)).map(t => ({ id: t.id, s: t.slot || '', f: t.from, t: t.to, name: t.name }));
  const add = (id, v) => { if (id !== rec.id && !list.some(x => x.id === id) && validEntry(id, v, 'temp')) list.push({ id, s: v.s || '', f: v.f, t: v.t, name: 'ผู้ใช้อื่น (เพิ่งบันทึก)' }); };
  if (lockE) Object.entries(lockE).forEach(([id, v]) => add(id, v));
  if (rangeE) Object.entries(rangeE).forEach(([id, v]) => { if (v.d1 <= day && day <= v.d2) add(id, v); });
  return list;
}
function permHolders(zid, lockE, exceptId) {
  const list = db.permanent.filter(p => p.active && p.zone === zid && p.id !== exceptId).map(p => ({ id: p.id, s: p.slot, name: p.name }));
  if (lockE) Object.entries(lockE).forEach(([id, v]) => { if (id !== exceptId && !list.some(x => x.id === id) && validEntry(id, v, 'perm')) list.push({ id, s: v.s, name: 'ผู้ใช้อื่น (เพิ่งบันทึก)' }); });
  return list;
}
function checkTemp(rec, tEs, pE, rE) {   // tEs = { วันที่: รายการในดัชนีของวันนั้น }
  const z = getZone(rec.zone); if (!z) return 'ไม่พบสถานที่';
  if (!rec.name || !rec.plate || !rec.date || !rec.from || !rec.to) return 'กรอกชื่อ ทะเบียน วันที่ และเวลาให้ครบ';
  if (rec.dateTo && rec.dateTo < rec.date) return 'วันสุดท้ายต้องไม่ก่อนวันแรก';
  if (dayCount(rec) > MAX_DAYS) return `จองต่อเนื่องได้สูงสุด ${MAX_DAYS} วัน (ประมาณ 6 เดือน)`;
  if (rec.to <= rec.from) return 'เวลาออกต้องหลังเวลาเข้า';
  if (rec.cancelled || !isLive(rec)) return '';
  const days = daysOf(rec, today()).filter(d => d > today() || rec.to > nowHM()), many = days.length > 1;
  for (const d of days) { const e = checkTempDay(rec, z, d, (tEs || {})[d], pE, rE); if (e) return many ? `${fmtDate(d)}: ${e}` : e; }
  return '';
}
function checkTempDay(rec, z, day, tE, pE, rE) {
  if (!acceptsTemp(z)) return `${z.name} ไม่รับรถชั่วคราว ให้จองที่ ${db.zones.filter(x => x.free).map(x => x.name).join(' หรือ ') || 'พื้นที่จอดอิสระ'}`;
  const pz = isPermZone(z);
  if (pz && !rec.slot) return `เลือกช่อง VIP ใน ${z.name}`;
  if (pz && !isVip(z, rec.slot)) return `ช่อง ${rec.slot} ไม่ใช่ช่องสำหรับรถชั่วคราว ใน ${z.name} รับรถชั่วคราวเฉพาะช่อง VIP`;
  if (pz && rec.kind !== VIP_KIND) return `ช่อง VIP ใช้สำหรับ${VIP_KIND} เท่านั้น`;
  const dup = db.temp.find(t => t.id !== rec.id && onDay(t, day) && normPlate(t.plate) === normPlate(rec.plate) && isLiveOn(t, day) && overlap(t.from, t.to, rec.from, rec.to));
  if (dup) return `ทะเบียน ${rec.plate} มีจองช่วง ${dup.from}–${dup.to} วันนั้นแล้ว (${zoneName(dup.zone)})`;
  const others = competitorsTemp(rec, day, tE, rE).filter(o => overlap(o.f, o.t, rec.from, rec.to));
  const perms = z.free ? [] : permHolders(z.id, pE);
  if (rec.slot) {
    if (!hasSlot(z, rec.slot)) return `ไม่มีช่อง ${rec.slot} ใน ${z.name}`;
    if (!tempSlotsOf(z).some(x => normSlot(x) === normSlot(rec.slot))) return `ช่อง ${rec.slot} ไม่รับรถชั่วคราว`;
    const p = perms.find(x => normSlot(x.s) === normSlot(rec.slot)); if (p) return `ช่อง ${rec.slot} เป็นช่องประจำของ ${p.name}`;
    const o = others.find(x => normSlot(x.s) === normSlot(rec.slot)); if (o) return `ช่อง ${rec.slot} มีจองช่วง ${o.f}–${o.t} แล้ว (${o.name}) เลือกช่องอื่นหรือเปลี่ยนเวลา`;
  }
  const used = pz ? others.filter(o => isVip(z, o.s)).length : perms.length + others.length, cap = pz ? tempSlotsOf(z).length : capOf(z);
  if (used >= cap) return `${z.name} เต็มช่วง ${rec.from}–${rec.to} (${used}/${cap}) เลือกสถานที่อื่นหรือเปลี่ยนเวลา`;
  return '';
}
function checkPerm(rec, pE) {
  const z = getZone(rec.zone);
  if (!rec.name || !rec.empId || !rec.plate || !rec.zone || !rec.slot) return 'กรอกชื่อ รหัสพนักงาน ทะเบียน และเลือกช่องให้ครบ';
  if (!isPermZone(z)) return `ช่องประจำใช้ได้เฉพาะ ${db.zones.filter(isPermZone).map(x => x.name).join(' และ ') || 'สถานที่ที่กำหนด'}`;
  if (!hasSlot(z, rec.slot)) return `ไม่มีช่อง ${rec.slot} ใน ${z.name}`;
  if (isVip(z, rec.slot)) return `ช่อง ${rec.slot} เป็นช่องลูกค้า VIP ใช้เป็นช่องประจำไม่ได้`;
  if (!rec.active) return '';
  const c = permHolders(z.id, pE, rec.id).find(x => normSlot(x.s) === normSlot(rec.slot)); if (c) return `ช่อง ${rec.slot} เป็นช่องประจำของ ${c.name} อยู่แล้ว`;
  const t = db.temp.find(x => x.zone === rec.zone && normSlot(x.slot) === normSlot(rec.slot) && isLive(x));
  if (t) return `ช่อง ${rec.slot} มีจองชั่วคราวของ ${t.name} วันที่ ${fmtRange(t)} ยกเลิกหรือย้ายรายการนั้นก่อน`;
  if (db.permanent.some(p => p.id !== rec.id && p.active && normSlot(p.empId) === normSlot(rec.empId))) return 'รหัสพนักงานนี้มีช่องประจำอยู่แล้ว';
  return '';
}
const offlineErr = e => e && ['unavailable', 'failed-precondition', 'deadline-exceeded'].includes(e.code);
async function saveTemp(rec, old) {
  if (!rec.dateTo || rec.dateTo <= rec.date) delete rec.dateTo;
  let err = checkTemp(rec); if (err) throw new UserErr(err);
  const live = !rec.cancelled && isLive(rec);
  if (!fs) { await put('temp', rec); return; }
  const days = daysOf(rec, today()), multi = isMulti(rec);
  const pRef = locks.doc(lockP(rec.zone)), rRef = locks.doc(lockR(rec.zone));
  const dRefs = (multi ? days : [rec.date]).map(d => [d, locks.doc(lockT(rec.zone, d))]);
  try {
    await fs.runTransaction(async tx => {
      const [pS, rS, ...dS] = await Promise.all([tx.get(pRef), tx.get(rRef), ...dRefs.map(([, r]) => tx.get(r))]);
      const tEs = {}; dRefs.forEach(([d], i) => { tEs[d] = lockEntries(dS[i]); });
      const e2 = checkTemp(rec, tEs, lockEntries(pS), lockEntries(rS)); if (e2) throw new UserErr(e2);
      if (live) {
        const v = { s: rec.slot || '', f: rec.from, t: rec.to, at: Date.now() };
        if (multi) tx.set(rRef, { e: { [rec.id]: { ...v, d1: rec.date, d2: dEnd(rec) } } }, { merge: true });
        else tx.set(dRefs[0][1], { e: { [rec.id]: v } }, { merge: true });
      }
      tx.set(col.doc(rec.id), toDoc('temp', rec));
    });
    docs.set(rec.id, toDoc('temp', rec)); rebuild();
  } catch (e) {
    if (e instanceof UserErr) throw e;
    if (offlineErr(e)) { await put('temp', rec).catch(() => {}); toast('บันทึกแบบออฟไลน์ จะซิงก์เมื่อกลับมาออนไลน์ (ยังตรวจการจองชนกับเครื่องอื่นไม่ได้)'); }
    else { writeErr(e); throw new UserErr('บันทึกไม่สำเร็จ ลองอีกครั้ง'); }
  }
  if (old && lockOf(old) !== lockOf(rec)) dropLock(lockOf(old), rec.id);
  if (!live) dropLock(lockOf(rec), rec.id);
}
async function savePerm(rec, old) {
  let err = checkPerm(rec); if (err) throw new UserErr(err);
  if (!fs) { await put('perm', rec); return; }
  const pRef = locks.doc(lockP(rec.zone));
  try {
    await fs.runTransaction(async tx => {
      const pS = await tx.get(pRef);
      const e2 = checkPerm(rec, lockEntries(pS)); if (e2) throw new UserErr(e2);
      if (rec.active) tx.set(pRef, { e: { [rec.id]: { s: rec.slot, at: Date.now() } } }, { merge: true });
      tx.set(col.doc(rec.id), toDoc('perm', rec));
    });
    docs.set(rec.id, toDoc('perm', rec)); rebuild();
  } catch (e) {
    if (e instanceof UserErr) throw e;
    if (offlineErr(e)) { await put('perm', rec).catch(() => {}); toast('บันทึกแบบออฟไลน์ จะซิงก์เมื่อกลับมาออนไลน์'); }
    else { writeErr(e); throw new UserErr('บันทึกไม่สำเร็จ ลองอีกครั้ง'); }
  }
  if (old && old.zone !== rec.zone) dropLock(lockP(old.zone), rec.id);
  if (!rec.active) dropLock(lockP(rec.zone), rec.id);
}
async function rebuildLocks() {   // สร้างดัชนีใหม่ทั้งหมดจากข้อมูลจริง (หลังนำเข้า/กู้คืน)
  if (!fs) return;
  const want = new Map();
  db.temp.filter(isLive).forEach(t => { const k = lockOf(t); if (!want.has(k)) want.set(k, { e: {} }); want.get(k).e[t.id] = { s: t.slot || '', f: t.from, t: t.to, at: t.updatedAt || Date.now(), ...(isMulti(t) ? { d1: t.date, d2: dEnd(t) } : {}) }; });
  db.permanent.filter(p => p.active).forEach(p => { const k = lockP(p.zone); if (!want.has(k)) want.set(k, { e: {} }); want.get(k).e[p.id] = { s: p.slot, at: p.updatedAt || Date.now() }; });
  const cur = await locks.get(); const ops = [];
  cur.forEach(d => { if (!want.has(d.id)) ops.push(b => b.delete(d.ref)); });
  want.forEach((v, k) => ops.push(b => b.set(locks.doc(k), v)));
  for (let i = 0; i < ops.length; i += 400) { const b = fs.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
}

/* ================= ผังช่องจอด ณ ช่วงเวลา ================= */
function occupancy(z, date, from, to) {
  const temps = db.temp.filter(t => t.zone === z.id && onDay(t, date) && isLiveOn(t, date));
  const inWin = temps.filter(t => overlap(t.from, t.to, from, to));
  if (z.free) return { free: true, cap: capOf(z), items: inWin, used: inWin.length, perm: 0, tmp: inWin.length, loose: [], temps };
  const perm = db.permanent.filter(p => p.active && p.zone === z.id);
  const permBy = new Map(perm.map(p => [normSlot(p.slot), p]));
  const tempBy = new Map(), laterBy = new Map(), loose = [];
  inWin.slice().sort((a, b) => a.from.localeCompare(b.from)).forEach(t => {
    const k = normSlot(t.slot);
    if (t.slot && hasSlot(z, t.slot) && !permBy.has(k) && !tempBy.has(k)) tempBy.set(k, t); else loose.push(t);
  });
  temps.filter(t => !inWin.includes(t) && t.slot).forEach(t => { const k = normSlot(t.slot); if (!laterBy.has(k)) laterBy.set(k, []); laterBy.get(k).push(t); });
  const items = z.slots.map(s => { const k = normSlot(s); return { slot: s, perm: permBy.get(k), temp: tempBy.get(k), later: laterBy.get(k) || [] }; });
  const used = perm.length + inWin.length;
  return { free: false, cap: z.slots.length, items, used, perm: perm.length, tmp: inWin.length, loose, temps };
}
// สถานะ "ยังใช้งาน" ของรายการในวันที่ดู (วันในอนาคตนับทุกรายการที่ไม่ยกเลิก)
function isLiveOn(t, date) { if (t.cancelled || !onDay(t, date)) return false; const td = today(); return date > td || (date === td && t.to > nowHM()); }
function freeSlotsFor(z, date, from, to, exceptId) {
  if (!z || z.free) return [];
  const occ = new Set(db.permanent.filter(p => p.active && p.zone === z.id).map(p => normSlot(p.slot)));
  db.temp.forEach(t => { if (t.id !== exceptId && t.zone === z.id && onDay(t, date) && t.slot && isLiveOn(t, date) && overlap(t.from, t.to, from, to)) occ.add(normSlot(t.slot)); });
  return tempSlotsOf(z).filter(s => !occ.has(normSlot(s)));
}
function permFreeSlots(z, exceptId) {
  if (!z || z.free) return [];
  const occ = new Set(db.permanent.filter(p => p.active && p.zone === z.id && p.id !== exceptId).map(p => normSlot(p.slot)));
  db.temp.forEach(t => { if (t.zone === z.id && t.slot && isLive(t)) occ.add(normSlot(t.slot)); });
  return permSlotsOf(z).filter(s => !occ.has(normSlot(s)));
}

/* ================= เรนเดอร์ ================= */
let rq = 0;
function scheduleRender() { if (rq) return; rq = requestAnimationFrame(() => { rq = 0; renderAll(); }); }
function renderAll() {
  if (!user) return;
  renderNav();
  if (S.tab === 'map') renderMap();
  if (S.tab === 'today') renderToday();
  if (S.tab === 'chk') renderCheck();
  if (S.tab === 'sum') renderSum();
  if (S.tab === 'data') renderData();
  if (S.tab === 'set') renderSet();
  if (!$('sheet').hidden) refreshSheetSlots();
}
function renderNav() {
  if (isGuard && !GUARD_TABS.includes(S.tab)) S.tab = 'chk';
  document.querySelectorAll('[data-tab]').forEach(b => { b.hidden = isGuard && !GUARD_TABS.includes(b.dataset.tab); if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  ['map', 'today', 'chk', 'sum', 'data', 'set'].forEach(t => { $('tab-' + t).hidden = t !== S.tab; });
}
function showTab(t) { S.tab = t; saveUi(); renderAll(); window.scrollTo({ top: 0 }); }

/* ---------- แผนผัง ---------- */
function setWindowNow() {
  const n = hm2m(nowHM()), from = Math.floor(n / 15) * 15;
  S.vDate = today(); S.vFrom = m2hm(from); S.vTo = from < 16 * 60 ? '17:00' : m2hm(Math.min(1439, from + 60)); S.follow = true;
}
function renderMap() {
  const z = getZone(S.zone);
  renderSite();
  $('vDate').value = S.vDate; $('vDate').min = today(); $('vFrom').value = S.vFrom; $('vTo').value = S.vTo;
  $('whenNote').textContent = S.vTo <= S.vFrom ? 'เวลาออกต้องหลังเวลาเข้า' : `แสดงสถานะ ${fmtDate(S.vDate)} เวลา ${S.vFrom}–${S.vTo} น.`;
  $('zoneChips').innerHTML = db.zones.map(x => {
    const o = occupancy(x, S.vDate, S.vFrom, S.vTo), f = o.cap - o.used;
    return `<button class="zchip" role="tab" data-zone="${esc(x.id)}" aria-selected="${x.id === S.zone}">${esc(x.name)}<small>ว่าง ${Math.max(0, f)}/${o.cap}</small></button>`;
  }).join('');
  if (!z) {
    $('stage').innerHTML = `<div class="empty" style="margin:20px">ยังไม่มีสถานที่จอดรถ${isAdmin ? `<br><button class="btn pri" data-act="seed-zones">สร้างสถานที่เริ่มต้น 4 แห่ง</button>` : '<br>ติดต่อผู้ดูแลระบบเพื่อเพิ่มสถานที่'}</div>`;
    $('zoneStat').innerHTML = ''; $('panel').innerHTML = ''; $('loose').hidden = true; return;
  }
  const o = occupancy(z, S.vDate, S.vFrom, S.vTo), free = o.cap - o.used;
  $('zoneStat').innerHTML = `<span><b>${o.cap}</b>${z.free ? 'คัน' : 'ช่อง'}</span>${z.free ? '' : `<span><b style="color:var(--sign)">${o.perm}</b>ระยะยาว</span>`}<span><b style="color:var(--mark-ink)">${o.tmp}</b>ชั่วคราว</span><span><b style="color:${free < 0 ? 'var(--stop)' : 'var(--go)'}">${free < 0 ? 'เกิน ' + -free : free}</b>ว่าง</span>${z.free ? '<span class="muted">จอดอิสระ ไม่มีเลขช่อง</span>' : ''}${z.note ? `<span class="muted">${esc(z.note)}</span>` : ''}<a class="maplink" href="${esc(safeUrl(z.mapUrl) || COMPANY_MAP)}" target="_blank" rel="noopener noreferrer">เปิดใน Google Maps</a>`;
  $('viewToggle').textContent = S.view3d ? 'มุมมอง 3 มิติ' : 'มุมมองแผนผัง'; $('viewToggle').setAttribute('aria-pressed', S.view3d);
  const sx = $('stage').scrollLeft;
  $('stage').className = 'stage ' + (S.view3d ? 'v3d' : 'v2d');
  const lh = lotHtml(z, o);
  $('stage').innerHTML = `<div class="sizer" id="sizer"><div class="lot${lh.w ? ' custom' : ''}" id="lot" ${lh.w ? `style="width:${lh.w}px;height:${lh.h}px"` : ''}>${lh.html}</div></div>`;
  layoutStage();
  const st = $('stage'), selEl = st.querySelector('.slot.sel, .slot.hl');
  if (selEl && st.scrollWidth > st.clientWidth) { const r = selEl.getBoundingClientRect(), sr = st.getBoundingClientRect(); if (r.left < sr.left + 20 || r.right > sr.right - 20) st.scrollLeft = sx + (r.left - sr.left) - sr.width / 2; else st.scrollLeft = sx; }
  else st.scrollLeft = sx || (validLayout(z) ? 0 : (st.scrollWidth - st.clientWidth) / 2);
  // รถที่ยังไม่ได้ระบุช่อง
  if (!z.free && o.loose.length) {
    $('loose').hidden = false;
    $('loose').innerHTML = `<h4>รอจัดช่อง ${o.loose.length} คัน (นับในความจุแล้ว)</h4><div class="chips">${o.loose.map(t => `<button data-act="sel-temp" data-id="${esc(t.id)}">${esc(t.plate)} ${esc(short(t.name, 16))} ${esc(t.from)}–${esc(t.to)}</button>`).join('')}</div>`;
  } else $('loose').hidden = true;
  renderPanel(z, o);
  S.pop = null;
}
/* ---------- ผังจริงตามแบบฟอร์ม (หน่วย 1 = ความกว้างช่องจอด) ---------- */
const UNIT = 56, SW = 1, SL = 1.72;   // ช่องแนวตั้ง กว้าง 1 ยาว 1.72 / ช่องแนวนอนสลับกัน
const rng = (a, b) => { const o = []; if (a <= b) for (let i = a; i <= b; i++) o.push(String(i)); else for (let i = a; i >= b; i--) o.push(String(i)); return o; };
const roofOf = (b, n) => b.o === 'v' ? { t: 'roof', x: b.x - .12, y: b.y - .12, w: n * SW + .24, h: SL + .24 } : { t: 'roof', x: b.x - .12, y: b.y - .12, w: SL + .24, h: n * SW + .24 };
const PRESETS = {
  pilot: () => {   // ผังกระชับ: คงตำแหน่งแถวตามแบบฟอร์ม แต่ลดพื้นที่ว่าง
    const blocks = [
      { x: 1.0, y: 4.2, o: 'h', f: 'r', slots: rng(1, 11) }, { x: 4.9, y: 4.2, o: 'h', f: 'r', slots: rng(12, 20) }, { x: 8.8, y: 4.2, o: 'h', f: 'r', slots: rng(21, 26) },
      { x: 4.9, y: 1.8, o: 'v', f: 'd', slots: rng(43, 45) }, { x: 11.2, y: 1.8, o: 'v', f: 'd', slots: rng(35, 39) },
      { x: 16.3, y: 5.6, o: 'h', f: 'l', slots: rng(40, 42) }, { x: 10.0, y: 12.0, o: 'v', f: 'u', slots: rng(27, 34) }];
    return { name: 'PILOT PLANT', slots: rng(1, 45), tags: { 1: 'vip', 2: 'vip', 3: 'vip', 4: 'vip', 5: 'exec', 6: 'exec' }, note: 'ลานจอดหลังอาคาร Pilot Plant',
      layout: { w: 18.4, h: 15.6, blocks, deco: [{ t: 'bldg', x: 3.8, y: 0, w: 12.8, h: 1.3, label: 'อาคาร PILOT PLANT' }, { t: 'gate', x: 0, y: 0.4, w: .6, h: 3.4, label: 'ทางเข้า-ออก' },
        ...blocks.map(b => roofOf(b, b.slots.length))] } };
  },
  waste: () => {
    const blocks = [{ x: .5, y: .4, o: 'v', f: 'd', slots: rng(17, 1) }];
    return { name: 'บ่อบำบัดน้ำเสีย', slots: rng(1, 17), tags: {}, note: 'ข้างอาคารบำบัดน้ำเสีย TUM3',
      layout: { w: 18, h: 6.4, blocks, deco: [{ t: 'bldg', x: .5, y: 4.7, w: 17, h: 1.5, label: 'อาคาร FISH OIL' }, ...blocks.map(b => roofOf(b, b.slots.length))] } };
  }
};
const presetKey = z => z.id === 'z-pilot-plant' || /pilot/i.test(z.name) ? 'pilot' : z.id === 'z-wastewater' || /บ่อบำบัด/.test(z.name) ? 'waste' : '';
const validLayout = z => !z.free && z.layout && Array.isArray(z.layout.blocks) && z.layout.blocks.length ? z.layout : null;
function customLot(z, cellOf) {   // คืน {html, w, h} หน่วยพิกเซล
  const L = z.layout, placed = new Set(), px = v => (v * UNIT).toFixed(1) + 'px';
  const box = (x, y, w, h) => `left:${px(x)};top:${px(y)};width:${px(w)};height:${px(h)}`;
  let H = L.h, slotsH = '', deco = '', roofs = '';
  const put = (sl, x, y, o, f) => { if (!hasSlot(z, sl)) return; placed.add(normSlot(sl)); slotsH += cellOf(sl, { style: box(x, y, o === 'v' ? SW : SL, o === 'v' ? SL : SW), cls: `lay o-${o} f-${f}` }); };
  L.blocks.forEach(b => b.slots.forEach((sl, i) => put(sl, b.o === 'v' ? b.x + i * SW : b.x, b.o === 'h' ? b.y + i * SW : b.y, b.o, b.f || (b.o === 'v' ? 'd' : 'r'))));
  const extra = z.slots.filter(sl => !placed.has(normSlot(sl)));
  if (extra.length) { const per = Math.max(4, Math.floor((L.w - 1) / SW)); extra.forEach((sl, i) => put(sl, .5 + (i % per) * SW, L.h + .6 + Math.floor(i / per) * (SL + .3), 'v', 'u')); H = L.h + .9 + Math.ceil(extra.length / per) * (SL + .3); deco += `<div class="deco label" style="left:${px(.5)};top:${px(L.h + .05)}">ช่องที่ยังไม่อยู่ในผัง</div>`; }
  (L.deco || []).forEach(d => {
    if (d.t === 'roof') roofs += `<div class="deco roof" style="${box(d.x, d.y, d.w, d.h)}"></div>`;
    else if (d.t === 'label') deco += `<div class="deco label" style="left:${px(d.x)};top:${px(d.y)}">${esc(d.text)}</div>`;
    else deco += `<div class="deco ${d.t === 'gate' ? 'gate' : 'bldg'}" style="${box(d.x, d.y, d.w, d.h)}"><span>${esc(d.label || '')}</span></div>`;
  });
  return { html: deco + slotsH + roofs, w: L.w * UNIT, h: H * UNIT };
}
/* ---------- ผังโรงงานภาพรวม ----------
   แผนผังแบบสถาปัตย์ วาดตามแบบแปลนโรงงาน ภาพดาวเทียม และจุดที่แผนกระบุ (ตำแหน่งโดยประมาณ ไม่ตามมาตราส่วน) */
const SITE_LOTS = {   // pts = ขอบลานจอด, a = จุดกลางลาน, p = ตำแหน่งป้าย (มีเส้นชี้ถ้าไม่ตรงลาน)
  pilot: { pts: '14,300 146,300 146,492 104,492', a: [96, 380], p: [40, 252], side: 'r' },
  waste: { pts: '664,-138 688,-138 688,14 664,14', a: [676, -62], p: [676, -128], side: 'l' },
  front: { pts: '490,612 660,612 660,668 490,668', a: [575, 640], p: [736, 582], side: 'r' },
  power: { pts: '424,716 560,716 560,848 424,848', a: [492, 782], p: [612, 782], side: 'r' }
};
const siteKey = z => { const k = presetKey(z), n = String(z.name); return k === 'pilot' ? 'pilot' : k === 'waste' ? 'waste' : /2\.2/.test(n) ? 'front' : /ไฟฟ้า/.test(n) ? 'power' : ''; };
function renderSite() {
  const det = $('site'); if (!det) return;
  if (det.dataset.init !== '1') { det.dataset.init = '1'; if (window.innerWidth > 760) det.open = true; }
  const B = (x, y, w, h, cls = '') => `<rect class="b ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`;
  const L = (x, y, t, cls = '', extra = '') => `<text class="lb ${cls}" x="${x}" y="${y}"${extra}>${t}</text>`;
  const RD = (x, y, w, h) => `<rect class="rd" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  const CL = (x1, y1, x2, y2) => `<line class="cl" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const WALL = d => `<path class="w-out" d="${d}"/><path class="w-in" d="${d}"/><path class="w-ht" d="${d}"/>`;
  const GATE = (x1, y1, x2, y2) => `<line class="g-ln" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><rect class="g-post" x="${x1 - 5}" y="${y1 - 5}" width="10" height="10"/><rect class="g-post" x="${x2 - 5}" y="${y2 - 5}" width="10" height="10"/>`;
  const PILL = (x, y, t, w) => `<g class="sp-pill"><rect x="${x - w / 2}" y="${y - 13}" width="${w}" height="26" rx="13"/><text x="${x}" y="${y + 1}">${t}</text></g>`;
  const cur = getZone(S.zone), curKey = cur ? siteKey(cur) : '';
  const lots = Object.entries(SITE_LOTS).map(([k, Lt]) => `<polygon class="pk ${k === curKey ? 'on' : ''}" points="${Lt.pts}"/>`).join('');
  const world = `
    <defs>
      <pattern id="spHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="#B4532F" stroke-width="2.2"/></pattern>
      <pattern id="spOut" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="12" stroke="#000" stroke-opacity=".045" stroke-width="5"/></pattern>
      <pattern id="spStall" width="11" height="11" patternUnits="userSpaceOnUse"><rect width="11" height="11" fill="#2B7BC4" fill-opacity=".16"/><line x1="0" y1="0" x2="0" y2="11" stroke="#fff" stroke-opacity=".85" stroke-width="1.2"/></pattern>
      <pattern id="spStallOn" width="11" height="11" patternUnits="userSpaceOnUse"><rect width="11" height="11" fill="#F7941D" fill-opacity=".34"/><line x1="0" y1="0" x2="0" y2="11" stroke="#fff" stroke-opacity=".9" stroke-width="1.2"/></pattern>
      <pattern id="spRoof" width="18" height="18" patternUnits="userSpaceOnUse"><rect width="18" height="18" fill="#fff"/><path d="M0 9 H18 M9 0 V18" stroke="#E6EBEF" stroke-width="1"/></pattern>
      <linearGradient id="spBadge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34BDB1"/><stop offset="1" stop-color="#2B7BC4"/></linearGradient>
      <linearGradient id="spBadgeOn" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBB040"/><stop offset="1" stop-color="#EF5B24"/></linearGradient>
      <filter id="spSh" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#1B2A36" flood-opacity=".14"/></filter>
      <filter id="spSh2" x="-20%" y="-30%" width="150%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#1B2A36" flood-opacity=".22"/></filter>
    </defs>
    <rect class="land" x="-10" y="-170" width="1160" height="1050"/>
    <rect class="outside" x="-10" y="702" width="1160" height="178"/><rect x="-10" y="702" width="1160" height="178" fill="url(#spOut)"/>
    <path class="water-b" d="M-10 400 C 30 500, 75 600, 122 710 S 150 820, 160 880"/><path class="water" d="M-10 400 C 30 500, 75 600, 122 710 S 150 820, 160 880"/>
    ${RD(-10, 22, 1160, 26)}${RD(-10, 678, 1160, 24)}${RD(126, 48, 20, 244)}${RD(450, 48, 36, 544)}${RD(664, 48, 28, 580)}${RD(1086, 48, 20, 630)}${RD(146, 262, 144, 22)}${RD(246, 284, 42, 394)}
    ${CL(-10, 35, 1150, 35)}${CL(-10, 690, 1150, 690)}${CL(468, 52, 468, 588)}${CL(678, 52, 678, 624)}${CL(267, 290, 267, 672)}
    <g filter="url(#spSh)">
      ${B(160, -150, 262, 160)}${B(500, -150, 158, 162)}<rect class="b pond" x="696" y="-160" width="184" height="172" rx="2"/><rect class="b bins" x="888" y="-160" width="86" height="150" rx="2"/>
      ${B(-4, 60, 124, 230)}<path class="b roof" d="M150 60 H445 V588 H292 V255 H150 Z"/>${B(148, 300, 94, 172, 'pp')}
      <rect class="b roof" x="490" y="60" width="170" height="548" rx="2"/>
      ${B(381, 601, 62, 59)}${B(294, 630, 38, 38, 'post')}${B(448, 594, 38, 74, 'acc')}${B(706, 654, 207, 18)}
      ${B(181, 712, 237, 142)}
    </g>
    <rect class="area" x="697" y="60" width="383" height="562" rx="2"/><rect class="area" x="292" y="596" width="86" height="72" rx="2"/>
    ${[[712, -82], [764, -82], [816, -82], [712, -40], [764, -40], [816, -40]].map(([x, y]) => `<rect class="tank" x="${x}" y="${y}" width="44" height="34" rx="6"/>`).join('')}
    <rect class="plot" x="160" y="708" width="420" height="150" rx="3"/>
    ${lots}
    ${WALL('M984 -170 V -3 H1082')}${WALL('M1082 58 V674 H288 V593')}${WALL('M1000 58 H1082')}${WALL('M-6 60 H124 V290 H-6 Z')}${WALL('M-6 290 L8 298 L100 500 L232 504 V593')}
    ${GATE(232, 593, 288, 593)}${GATE(1000, -3, 1000, 58)}<rect class="b post" x="988" y="18" width="24" height="34" rx="3"/>
    ${L(291, -66, 'บอยเลอร์', 'lg')}${L(579, -66, 'อาคาร FISH OIL')}${L(788, 0, 'บ่อบำบัดน้ำเสีย TUM3', 'sm')}${L(931, -112, 'พื้นที่', 'xs')}${L(931, -96, 'เก็บถังปลา', 'xs')}
    ${L(58, 180, 'หอพัก', 'lg')}${L(296, 160, 'อาคารผลิต 2.1', 'xl')}${L(575, 330, 'อาคารผลิต 2.2', 'xl')}
    ${L(195, 378, 'อาคาร', 'sm')}${L(195, 396, 'PILOT PLANT', 'sm')}${L(888, 330, 'พื้นที่ 40 ไร่', 'xl area-t')}${L(888, 358, 'พื้นที่โล่ง', 'sm area-t')}
    ${L(412, 630, 'ห้องธุรการ', 'xs')}${L(467, 631, 'ห้องช่าง', 'xs', ' transform="rotate(-90 467 631)"')}${L(810, 664, 'สโตร์', 'xs')}
    ${L(299, 785, 'โกดัง', 'lg')}${L(590, 730, 'นอกรั้วโรงงาน', 'sm out-t', ' style="text-anchor:start"')}
    ${L(40, 560, 'คลอง', 'sm water-t', ' transform="rotate(62 40 560)"')}
    ${PILL(267, 568, 'ประตู', 58)}${PILL(1041, -24, 'ประตูหลัง', 86)}${L(313, 643, 'ป้อม', 'xs')}${L(313, 656, 'รปภ.', 'xs')}${L(1048, 35, 'ป้อม รปภ.', 'xs')}
    <path class="flow" d="M678 96 V58 M668 70 L678 58 L688 70"/>${L(704, 82, 'ทางเข้า-ออก', 'flow-t')}
    <g class="north" transform="translate(1108,-128)"><circle r="20"/><path d="M0 -13 L7 7 L0 3 L-7 7 Z"/><text y="-26">N</text></g>
    <g class="sp-legend" transform="translate(872,716)">
      <rect class="lg-bg" x="0" y="0" width="268" height="132" rx="10"/>
      <g transform="translate(16,30)"><path class="w-out" d="M0 0 H30"/><path class="w-in" d="M0 0 H30"/><path class="w-ht" d="M0 0 H30"/><text x="42" y="5">กำแพง</text></g>
      <g transform="translate(140,30)"><line class="g-ln" x1="0" y1="0" x2="30" y2="0"/><rect class="g-post" x="-5" y="-5" width="10" height="10"/><rect class="g-post" x="25" y="-5" width="10" height="10"/><text x="42" y="5">ประตูรถ</text></g>
      <g transform="translate(16,66)"><rect class="pk" x="0" y="-11" width="30" height="22"/><text x="42" y="5">ลานจอดรถ</text></g>
      <g transform="translate(140,66)"><rect class="b" x="0" y="-11" width="30" height="22" rx="2"/><text x="42" y="5">อาคาร</text></g>
      <g transform="translate(16,102)"><rect class="area" x="0" y="-11" width="30" height="22" rx="2"/><text x="42" y="5">พื้นที่โล่ง</text></g>
      <g transform="translate(140,102)"><rect class="rd" x="0" y="-11" width="30" height="22"/><line class="cl" x1="2" y1="0" x2="28" y2="0"/><text x="42" y="5">ถนน</text></g>
    </g>`;
  const marks = db.zones.map((z, i) => {
    const Lt = SITE_LOTS[siteKey(z)] || { p: [1100, -120 + i * 60], side: 'l' }, [x, y] = Lt.p, o = occupancy(z, S.vDate, S.vFrom, S.vTo), f = Math.max(0, o.cap - o.used), on = z.id === S.zone;
    const w = Math.max(138, z.name.length * 15 + 34), lx = Lt.side === 'l' ? -26 - w : 26;
    const lead = Lt.a && (Lt.a[0] !== x || Lt.a[1] !== y) ? `<line class="mk-lead" x1="${Lt.a[0]}" y1="${Lt.a[1]}" x2="${x}" y2="${y}"/><circle class="mk-dot" cx="${Lt.a[0]}" cy="${Lt.a[1]}" r="5"/>` : '';
    return `${lead}<g class="mk ${on ? 'on' : ''}" data-zone="${esc(z.id)}" role="button" tabindex="0" aria-label="${esc(z.name)} ว่าง ${f} จาก ${o.cap}" transform="translate(${x},${y})">
      <g filter="url(#spSh2)"><rect class="mk-card" x="${lx - 30}" y="-23" width="${w + 30}" height="46" rx="10"/></g>
      <rect class="mk-badge" x="-19" y="-19" width="38" height="38" rx="9"/><text class="mk-p" y="1">P</text>
      <text class="mk-t" x="${lx + 4}" y="-3">${esc(z.name)}</text><text class="mk-s" x="${lx + 4}" y="15"><tspan class="${f ? 'ok' : 'full'}">ว่าง ${f}</tspan> / ${o.cap} ${z.free ? 'คัน' : 'ช่อง'}</text></g>`;
  }).join('');
  $('siteMap').innerHTML = `<svg class="sp" viewBox="-10 -170 1160 1050" role="img" aria-label="ผังโรงงานและตำแหน่งลานจอด">${world}${marks}
    <text class="note" x="1140" y="868" text-anchor="end">ตำแหน่งโดยประมาณ ไม่ตามมาตราส่วน</text></svg>`;
}
function lotHtml(z, o) {
  if (validLayout(z)) {
    const by = new Map(o.items.map(i => [normSlot(i.slot), i]));
    const r = customLot(z, (sl, pos) => slotHtml(z, by.get(normSlot(sl)) || { slot: sl, later: [] }, pos));
    return { html: r.html, w: r.w, h: r.h };
  }
  const per = z.perRow;
  let cells;
  if (z.free) {
    const n = Math.max(o.cap, o.items.length);
    cells = Array.from({ length: n }, (_, i) => ({ slot: '', temp: o.items[i], idx: i, open: true, later: [] }));
  } else cells = o.items;
  const rows = []; for (let i = 0; i < cells.length; i += per) rows.push(cells.slice(i, i + per));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let h = '';
  rows.forEach((r, ri) => {
    if (ri % 2 === 0) h += `<div class="lane"><span class="arrow" style="left:10px">›</span><span class="arrow" style="right:10px">›</span></div>`;
    h += `<div class="prow ${ri % 2 === 0 ? 'up' : 'down'}"><span class="rlabel">${letters[ri] || ri + 1}</span>${r.map(c => slotHtml(z, c)).join('')}</div>`;
  });
  if (rows.length % 2 === 0) h += `<div class="lane"></div>`;   // แถวสุดท้ายหันออกทางถนนด้านล่าง
  return { html: h };
}
function slotHtml(z, c, pos) {
  const sel = S.sel && ((S.sel.slot != null && !z.free && normSlot(S.sel.slot) === normSlot(c.slot) && S.sel.zone === z.id) || (S.sel.idx != null && z.free && S.sel.idx === c.idx && S.sel.zone === z.id && !c.temp)
    || (S.sel.temp && c.temp && c.temp.id === S.sel.temp) || (S.sel.perm && c.perm && c.perm.id === S.sel.perm));
  const hl = S.hl && ((c.temp && c.temp.id === S.hl) || (c.perm && c.perm.id === S.hl));
  const tg = c.slot ? tagOf(z, c.slot) : '';
  const cls = ['slot', pos ? pos.cls : '', tg ? 't-' + tg : '', c.open ? 'open' : '', c.perm ? 'perm' : c.temp ? 'temp' : 'free', c.later && c.later.length && !c.perm && !c.temp ? 'later' : '', sel ? 'sel' : '', hl ? 'hl' : ''].filter(Boolean).join(' ');
  const pop = (c.temp && c.temp.id === S.pop) || (c.perm && c.perm.id === S.pop) ? ' pop' : '';
  let inner = `<span class="num">${esc(c.slot || '')}</span>${tg ? `<span class="stag">${tg === 'vip' ? 'VIP' : 'ผบ.'}</span>` : ''}`, label;
  if (c.perm) { inner += `<svg class="car perm${pop}" viewBox="0 0 40 72" aria-hidden="true"><use href="#car"/></svg><span class="tag">${esc(short(firstName(c.perm.name), 10))}<small>${esc(c.perm.plate)}</small></span>`; label = `ช่อง ${c.slot} ระยะยาว ${c.perm.name} ทะเบียน ${c.perm.plate}`; }
  else if (c.temp) { inner += `<svg class="car temp${pop}" viewBox="0 0 40 72" aria-hidden="true"><use href="#car"/></svg><span class="tag temp">${esc(short(firstName(c.temp.name), 10))}<small>${esc(c.temp.from)}–${esc(c.temp.to)}</small></span>`; label = `${c.slot ? 'ช่อง ' + c.slot : 'จอดอิสระ'} ชั่วคราว ${c.temp.name} ${c.temp.from}-${c.temp.to}`; }
  else { if (sel) inner += '<i class="ghost"></i>'; label = `${c.slot ? 'ช่อง ' + c.slot : 'ที่ว่าง'} ว่าง${c.later && c.later.length ? ' มีจองช่วงเวลาอื่น' : ''}`; }
  const data = c.perm ? `data-act="sel-perm" data-id="${esc(c.perm.id)}"` : c.temp ? `data-act="sel-temp" data-id="${esc(c.temp.id)}"` : z.free ? `data-act="sel-open" data-idx="${c.idx}"` : `data-act="sel-slot" data-slot="${esc(c.slot)}"`;
  if (tg) label += ' ' + TAG_TXT[tg];
  return `<button type="button" class="${cls}" ${data} ${pos ? `style="${pos.style}"` : ''} aria-label="${esc(label)}" aria-pressed="${!!sel}">${inner}</button>`;
}
function layoutStage() {
  const st = $('stage'), sz = $('sizer'), lot = $('lot'); if (!lot) return;
  const W = lot.offsetWidth, H = lot.offsetHeight, avail = Math.max(260, st.clientWidth - 16);
  const grow = S.view3d ? 1.22 : 1, minFit = window.innerWidth <= 760 ? 0.45 : 0.3, fit = Math.max(minFit, Math.min(1.15, avail / (W * grow)));   // มือถือไม่ย่อจนกดยาก ให้เลื่อนซ้ายขวาแทน
  const s = fit * S.zoom, k = S.view3d ? Math.cos(52 * Math.PI / 180) * 1.08 : 1;
  lot.style.setProperty('--s', s.toFixed(3));
  sz.style.width = Math.max(avail, W * s * grow + 24) + 'px';
  sz.style.height = Math.ceil(H * s * k + (S.view3d ? 80 : 30)) + 'px';
  st.classList.toggle('notags', s < 0.55);
  if (S.hl) { const el = lot.querySelector('.slot.hl'); if (el) setTimeout(() => el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }), 50); }
}

/* ---------- แผงรายละเอียด ---------- */
function renderPanel(z, o) { renderPanelInner(z, o); guardTrim($('panel')); }
function renderPanelInner(z, o) {
  const p = $('panel'), sel = S.sel;
  const win = `${fmtDate(S.vDate)} ${S.vFrom}–${S.vTo} น.`;
  const histBtn = (kind, id) => `<button class="btn ghost sm" data-act="hist" data-kind="${kind}" data-id="${esc(id)}">ประวัติการแก้ไข</button>`;
  const otherList = (list, title) => list.length ? `<div class="p-list"><h4>${title}</h4><ul>${list.map(t => `<li><span>${esc(t.from)}–${esc(t.to)} ${esc(short(t.name, 22))}</span><button class="link" data-act="sel-temp" data-id="${esc(t.id)}">ดู</button></li>`).join('')}</ul></div>` : '';
  if (sel && sel.perm) {
    const r = db.permanent.find(x => x.id === sel.perm); if (!r) { S.sel = null; return renderPanelInner(z, o); }
    p.innerHTML = `<div class="p-slot">${esc(r.slot)}</div><div class="p-zone">${esc(zoneName(r.zone))}</div>
      <p style="margin-top:10px"><span class="status st-perm">ช่องประจำ ระยะยาว</span> ${tagOf(getZone(r.zone), r.slot) === 'exec' ? '<span class="status st-exec">ผู้บริหาร</span>' : ''}</p>
      <dl><dt>ชื่อ</dt><dd>${esc(r.name)}</dd><dt>ทะเบียน</dt><dd>${esc(r.plate)}</dd>${isGuard ? '' : `<dt>รหัสพนักงาน</dt><dd>${esc(r.empId)}</dd>`}
      ${isGuard ? '' : `<dt>แผนก / ฝ่าย</dt><dd>${esc([r.dept, r.division].filter(Boolean).join(' / ') || '—')}</dd>`}<dt>แก้ไขล่าสุด</dt><dd>${fmtTs(r.updatedAt)}${r.updatedBy ? '<br><span class="muted">' + esc(r.updatedBy) + '</span>' : ''}</dd></dl>
      <div class="p-actions"><button class="btn pri" data-act="edit-perm" data-id="${esc(r.id)}">แก้ไข</button><button class="btn ghost" data-act="toggle-perm" data-id="${esc(r.id)}">คืนช่อง (ลาออก/ย้าย)</button>${histBtn('perm', r.id)}</div>`;
    return;
  }
  if (sel && sel.temp) {
    const t = db.temp.find(x => x.id === sel.temp); if (!t) { S.sel = null; return renderPanelInner(z, o); }
    const st = tStatus(t), zz = getZone(t.zone);
    const others = db.temp.filter(x => x.id !== t.id && x.zone === t.zone && onDay(x, S.vDate) && t.slot && normSlot(x.slot) === normSlot(t.slot) && isLiveOn(x, S.vDate));
    p.innerHTML = `<div class="p-slot">${esc(t.slot || (zz && zz.free ? 'จอดอิสระ' : 'ยังไม่ระบุช่อง'))}</div><div class="p-zone">${esc(zoneName(t.zone))}</div>
      <p style="margin-top:10px"><span class="status st-${st}">${ST_TXT[st]}</span></p>
      <dl><dt>ชื่อ / บริษัท</dt><dd>${esc(t.name)}</dd><dt>ประเภท</dt><dd>${esc(t.kind || 'ชั่วคราว')}</dd><dt>ทะเบียน</dt><dd>${esc(t.plate)}</dd>
      <dt>เวลาที่ขอใช้</dt><dd>${fmtRange(t)}<br>${esc(t.from)}–${esc(t.to)} น.${isMulti(t) ? ' ทุกวัน' : ''}</dd>${t.note ? `<dt>หมายเหตุ</dt><dd>${esc(t.note)}</dd>` : ''}
      <dt>บันทึกโดย</dt><dd>${esc(t.createdBy || '—')}<br><span class="muted">${fmtTs(t.createdAt)}</span></dd></dl>
      <div class="p-actions"><button class="btn pri" data-act="edit-temp" data-id="${esc(t.id)}">แก้ไข / ย้ายช่อง</button>${isLive(t) ? `<button class="btn ghost" data-act="cancel-temp" data-id="${esc(t.id)}">ยกเลิกการจอง</button>` : ''}${histBtn('temp', t.id)}</div>
      ${otherList(others, 'จองช่องนี้ช่วงอื่นในวันเดียวกัน')}`;
    return;
  }
  if (sel && (sel.slot != null || sel.idx != null) && sel.zone === z.id) {
    const it = z.free ? null : o.items.find(i => normSlot(i.slot) === normSlot(sel.slot));
    const later = it ? it.later : [];
    const tg = z.free ? '' : tagOf(z, sel.slot), canTemp = z.free || tempSlotsOf(z).some(x => normSlot(x) === normSlot(sel.slot)), canPerm = isPermZone(z) && tg !== 'vip' && !later.length;
    p.innerHTML = `<div class="p-slot">${esc(z.free ? 'ที่ว่าง' : sel.slot)}</div><div class="p-zone">${esc(z.name)}</div>
      <p style="margin-top:10px"><span class="status st-free">ว่าง ${esc(win)}</span> ${tg ? `<span class="status st-${tg}">ช่อง${TAG_TXT[tg]}</span>` : ''}</p>
      <p class="muted" style="margin-top:10px;font-size:.92rem">${z.free ? 'พื้นที่นี้จอดอิสระ ไม่ระบุเลขช่อง' : tg === 'vip' ? 'ช่องนี้สำหรับลูกค้า VIP จองตามช่วงเวลาที่เลือกไว้ด้านบน' : canTemp ? 'แตะ "จองช่องนี้" เพื่อกรอกข้อมูลผู้จอด ช่วงเวลาใช้ตามที่เลือกไว้ด้านบน' : tg === 'exec' ? 'ช่องประจำสำหรับผู้บริหารระดับสูง' : `ช่องนี้เป็นช่องประจำพนักงาน รถชั่วคราวให้จองที่ ${db.zones.filter(x => x.free).map(x => x.name).join(' หรือ ')}`}</p>
      <div class="p-actions">${canTemp ? `<button class="btn pri" data-act="book-here">${tg === 'vip' ? 'จองให้ลูกค้า VIP' : 'จอง' + (z.free ? 'พื้นที่นี้' : 'ช่องนี้')}</button>` : ''}${canPerm ? `<button class="btn ${canTemp ? 'ghost' : 'pri'}" data-act="perm-here">ลงทะเบียน${tg === 'exec' ? 'ผู้บริหาร' : 'พนักงาน'}ในช่องนี้</button>` : ''}</div>
      ${otherList(later, 'มีจองช่องนี้ช่วงเวลาอื่น')}`;
    return;
  }
  // ยังไม่เลือก: รายชื่อรถที่จอดในผังนี้
  const people = z.free ? o.items.map(t => ({ k: 'temp', id: t.id, slot: '', name: t.name, plate: t.plate, sub: `${t.from}–${t.to}` }))
    : o.items.filter(i => i.perm || i.temp).map(i => i.perm ? { k: 'perm', id: i.perm.id, slot: i.slot, name: i.perm.name, plate: i.perm.plate, sub: 'ระยะยาว' } : { k: 'temp', id: i.temp.id, slot: i.slot, name: i.temp.name, plate: i.temp.plate, sub: `${i.temp.from}–${i.temp.to}` });
  p.innerHTML = `<div class="panel-empty"><h3>เลือกช่องจอด</h3>
    <ol><li>เลือกวันและเวลาที่ต้องการด้านบน</li><li>แตะช่องสีเขียวที่ว่างในผัง</li><li>กรอกชื่อและทะเบียนรถ แล้วกดบันทึก</li></ol>
    <p style="margin-top:10px">แตะรถในผังเพื่อดูว่าเป็นของใคร</p></div>
    <div class="p-list"><h4>รถในผังนี้ ${people.length} คัน</h4>${people.length ? `<ul>${people.slice(0, 60).map(x => `<li><span><b>${esc(x.slot || '—')}</b> ${esc(short(x.name, 18))} <span class="muted">${esc(x.plate)}</span></span><button class="link" data-act="sel-${x.k}" data-id="${esc(x.id)}">ดู</button></li>`).join('')}</ul>` : '<p class="muted">ยังไม่มีรถในช่วงเวลานี้</p>'}</div>`;
}

function peekPanel() {   // จอเล็ก: เลื่อนให้เห็นรายละเอียดช่องที่เพิ่งแตะ
  if (window.innerWidth > 1100) return;
  const p = $('panel'), r = p.getBoundingClientRect();
  if (r.top > window.innerHeight - 160) window.scrollBy({ top: r.top - window.innerHeight + Math.min(r.height, 300) + 90, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
/* ---------- หารถ ---------- */
function findMatches(q) {
  q = q.trim().toLowerCase(); if (q.length < 1) return [];
  const np = normPlate(q);
  const hit = (name, plate) => String(name).toLowerCase().includes(q) || (np && normPlate(plate).includes(np));
  const a = db.permanent.filter(p => p.active && hit(p.name, p.plate)).map(p => ({ k: 'perm', r: p }));
  const b = db.temp.filter(t => isLive(t) && hit(t.name, t.plate)).sort((x, y) => (x.date + x.from).localeCompare(y.date + y.from)).map(t => ({ k: 'temp', r: t }));
  return a.concat(b).slice(0, 12);
}
function renderFind() {
  const list = findMatches($('findQ').value), el = $('findList');
  if (!$('findQ').value.trim()) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = list.length ? list.map(({ k, r }) => `<button type="button" data-act="goto-${k}" data-id="${esc(r.id)}"><b>${esc(r.plate)}</b> ${esc(r.name)}<div class="fl-sub">${esc(zoneName(r.zone))} ${r.slot ? 'ช่อง ' + esc(r.slot) : ''} ${k === 'perm' ? '(ช่องประจำ)' : `${fmtRange(r)} ${esc(r.from)}–${esc(r.to)}`}</div></button>`).join('')
    : '<div class="fl-sub" style="padding:10px 12px">ไม่พบรถที่ตรงกับคำค้น</div>';
}
function gotoRec(k, id) {
  const r = k === 'perm' ? db.permanent.find(x => x.id === id) : db.temp.find(x => x.id === id); if (!r) return;
  S.zone = r.zone;
  if (k === 'temp') { S.vDate = focusDate(r); S.vFrom = r.from; S.vTo = r.to; S.follow = false; }
  S.sel = k === 'perm' ? { perm: id } : { temp: id }; S.hl = id;
  $('findList').hidden = true; S.tab = 'map'; saveUi(); renderAll();
  setTimeout(() => { if (S.hl === id) { S.hl = null; } }, 4000);
}

/* ---------- แผ่นฟอร์มจอง ---------- */
let bType = 'temp', bEdit = null;
function openSheet(o = {}) {
  bEdit = o.edit || null; bType = o.type || 'temp';
  const r = bEdit;
  $('bId').value = r ? r.id : '';
  $('bName').value = r ? r.name : ''; $('bPlate').value = r ? r.plate : '';
  $('bKind').innerHTML = KINDS.concat(VIP_KIND).map(k => `<option>${esc(k)}</option>`).join('');
  $('bKind').value = r && r.kind ? r.kind : KINDS[0];
  $('bDate').value = r && r.date ? r.date : (o.date || S.vDate); $('bDate').min = r ? '' : today();
  $('bDateTo').value = r && isMulti(r) ? dEnd(r) : ''; $('bDateTo').min = $('bDate').value;
  $('bFrom').value = r && r.from ? r.from : (o.from || S.vFrom); $('bTo').value = r && r.to ? r.to : (o.to || S.vTo);
  $('bNote').value = r ? (r.note || '') : '';
  $('bEmp').value = r ? (r.empId || '') : ''; $('bDept').value = r ? (r.dept || '') : ''; $('bDiv').value = r ? (r.division || '') : '';
  sheetZone = r ? r.zone : (o.zone || (bType === 'temp' ? ((db.zones.find(z => z.free) || {}).id || S.zone) : S.zone)); sheetSlot = r ? (r.slot || '') : (o.slot != null ? o.slot : '');
  if (isGuard) bType = 'temp';
  $('bByWrap').hidden = !isGuard; $('bBy').required = isGuard;
  if (isGuard) { const c = curShift(), rec = recentInspectors(); $('bBy').value = inspectorFor(c.date, c.sh) || ''; $('bByList').innerHTML = rec.map(n => `<option value="${esc(n)}">`).join(''); }
  const pb = document.querySelector('#bType [data-type="perm"]'); if (pb) pb.hidden = isGuard;
  setSheetType(bType, true);
  $('bErr').hidden = true; $('sheet').hidden = false; document.body.style.overflow = 'hidden';
  setTimeout(() => $('bName').focus(), 30);
}
let sheetZone = null, sheetSlot = '';
function setSheetType(t, keep) {
  bType = t; const perm = t === 'perm', editing = !!bEdit;
  document.querySelectorAll('#bType button').forEach(b => { b.setAttribute('aria-pressed', b.dataset.type === t); b.disabled = editing && b.dataset.type !== t; });
  document.querySelectorAll('.g-temp').forEach(g => { g.hidden = perm; });
  document.querySelectorAll('.g-perm').forEach(g => { g.hidden = !perm; });
  $('bNameLbl').textContent = perm ? 'ชื่อ-นามสกุล พนักงาน' : 'ชื่อ-นามสกุล / บริษัท';
  $('bTitle').textContent = editing ? (perm ? 'แก้ไขช่องประจำพนักงาน' : 'แก้ไขการจองชั่วคราว') : (perm ? 'ลงทะเบียนช่องประจำพนักงาน' : 'บันทึกการจองชั่วคราว');
  $('bSubmit').textContent = editing ? 'บันทึกการแก้ไข' : (perm ? 'ลงทะเบียน' : 'บันทึกการจอง');
  const list = perm ? db.zones.filter(isPermZone) : db.zones.filter(z => acceptsTemp(z) || (bEdit && z.id === bEdit.zone));
  if (!list.some(z => z.id === sheetZone)) sheetZone = list[0] ? list[0].id : null;
  $('bZone').innerHTML = list.map(z => `<option value="${esc(z.id)}">${esc(z.name)}${z.free ? ' (จอดอิสระ)' : !perm && isPermZone(z) ? ' (ช่อง VIP)' : ''}</option>`).join('');
  $('bZone').value = sheetZone || '';
  if (!keep) sheetSlot = '';
  refreshSheetSlots();
}
function dpickTo(b, d0) {   // วันสุดท้ายของปุ่มเลือกจำนวนวัน
  if (b.dataset.d) return addDays(d0, +b.dataset.d);
  const dt = toD(d0); dt.setUTCMonth(dt.getUTCMonth() + (+b.dataset.m)); return addDays(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(dt), -1);
}
function sheetRange() {   // ช่วงวันที่ในฟอร์ม { date, dateTo }
  const date = $('bDate').value, to = $('bDateTo').value;
  return { date, dateTo: to && to > date ? to : '' };
}
// ช่องที่ว่างทุกวันในช่วงที่เลือก
function freeSlotsRange(z, rg, from, to, exceptId) {
  const days = daysOf({ date: rg.date, dateTo: rg.dateTo }, today()); if (!days.length) days.push(rg.date);
  return days.reduce((acc, d) => { const f = new Set(freeSlotsFor(z, d, from, to, exceptId).map(normSlot)); return acc.filter(s => f.has(normSlot(s))); }, tempSlotsOf(z));
}
function maxUsedRange(z, rg, from, to, exceptId) {   // จำนวนรถสูงสุดในวันใดวันหนึ่งของช่วง (พื้นที่จอดอิสระ)
  const days = daysOf({ date: rg.date, dateTo: rg.dateTo }, today()); if (!days.length) days.push(rg.date);
  let mx = 0, at = days[0]; days.forEach(d => { const n = occupancy(z, d, from, to).items.filter(t => t.id !== exceptId).length; if (n > mx) { mx = n; at = d; } }); return { mx, at, n: days.length };
}
function refreshSheetSlots() {
  document.querySelectorAll('.tpick:not(.dpick) button').forEach(x => x.classList.toggle('on', x.dataset.f === $('bFrom').value && x.dataset.t === $('bTo').value));
  const z = getZone($('bZone').value), perm = bType === 'perm', id = $('bId').value;
  const rg = sheetRange(), date = rg.date, from = $('bFrom').value, to = $('bTo').value;
  $('bDateTo').min = date || today();
  const nd = rg.dateTo ? dayCount(rg) : 1;
  $('bDays').textContent = rg.dateTo ? `รวม ${nd} วัน ${fmtDate(date)} – ${fmtDate(rg.dateTo)} เวลา ${from || '--:--'}–${to || '--:--'} น. ทุกวัน${nd > MAX_DAYS ? ` (เกิน ${MAX_DAYS} วัน)` : ''}` : 'วันเดียว';
  document.querySelectorAll('.dpick button').forEach(x => x.classList.toggle('on', x.dataset.d === '0' ? !rg.dateTo : rg.dateTo && rg.dateTo === dpickTo(x, date)));
  const cur = sheetSlot;
  $('bSlotWrap').hidden = !!(z && z.free);
  let list = [];
  if (z && !z.free) list = perm ? permFreeSlots(z, id) : (rg.dateTo ? freeSlotsRange(z, rg, from, to, id) : freeSlotsFor(z, date, from, to, id));
  if (cur && z && hasSlot(z, cur) && !list.some(s => normSlot(s) === normSlot(cur))) list = [cur, ...list];   // ช่องที่เลือกไว้ ให้ตรวจตอนบันทึก
  $('bSlot').innerHTML = (perm || (z && isPermZone(z)) ? '<option value="">เลือกหมายเลขช่อง</option>' : '<option value="">ยังไม่ระบุช่อง</option>') + list.map(s => `<option value="${esc(s)}">ช่อง ${esc(s)}${tagOf(z, s) ? ' (' + TAG_TXT[tagOf(z, s)] + ')' : ''}</option>`).join('');
  $('bSlot').value = list.find(s => normSlot(s) === normSlot(cur)) || '';
  const slot = $('bSlot').value;
  const vipZone = !perm && z && isPermZone(z);   // PILOT PLANT: รถชั่วคราวได้เฉพาะลูกค้า VIP
  [...$('bKind').options].forEach(o => { o.hidden = vipZone ? o.value !== VIP_KIND : o.value === VIP_KIND && !(bEdit && bEdit.kind === VIP_KIND); });
  if (vipZone) $('bKind').value = VIP_KIND; else if ($('bKind').value === VIP_KIND && !(bEdit && bEdit.kind === VIP_KIND)) $('bKind').value = KINDS[0];
  $('bKind').disabled = !!vipZone;
  if (z) {
    if (z.free) { if (rg.dateTo) { const m = maxUsedRange(z, rg, from, to, id); $('bHint').textContent = `${z.name} จอดอิสระ ช่วงที่เลือก วันที่มีรถมากที่สุด ${m.mx}/${capOf(z)} คัน (${fmtDate(m.at)})`; } else { const o = occupancy(z, date, from, to); $('bHint').textContent = `${z.name} จอดอิสระ ช่วงเวลานี้มีรถ ${o.used}/${o.cap} คัน`; } }
    else $('bHint').textContent = perm ? `ช่องที่ให้เป็นช่องประจำได้ ${permFreeSlots(z, id).length} จาก ${permSlotsOf(z).length} ช่อง${tagOf(z, slot) === 'exec' ? ' (ช่องนี้สำหรับผู้บริหาร)' : ''}` : `ช่วง ${from || '--:--'}–${to || '--:--'} ${rg.dateTo ? 'ว่างทุกวัน' : 'ว่าง'} ${list.filter(x => normSlot(x) !== normSlot(cur) || freeSlotsFor(z, date, from, to, id).some(y => normSlot(y) === normSlot(x))).length} จาก ${tempSlotsOf(z).length} ช่อง${vipZone ? ' VIP' : ''}`;
  } else $('bHint').textContent = '';
  $('bPicked').innerHTML = z ? `<b>${esc(z.free ? 'P' : (slot || '?'))}</b><span>${esc(z.name)}${z.free ? ' จอดอิสระ' : slot ? '' : ' (ยังไม่เลือกช่อง)'}<br>${perm ? 'ช่องประจำ ทุกวัน' : `${rg.dateTo ? `${fmtDate(date)} – ${fmtDate(rg.dateTo)} (${nd} วัน)` : fmtDate(date)} ${esc(from)}–${esc(to)} น.`}</span>` : '';
}
function closeSheet() { $('sheet').hidden = true; document.body.style.overflow = ''; bEdit = null; }
async function submitSheet(e) {
  e.preventDefault(); $('bErr').hidden = true;
  const id = $('bId').value, btn = $('bSubmit');
  const show = m => { $('bErr').textContent = m; $('bErr').hidden = false; };
  btn.disabled = true;
  try {
    if (bType === 'perm') {
      const old = id ? db.permanent.find(p => p.id === id) : null;
      const rec = { ...(old || {}), id: id || uid(), name: $('bName').value.trim(), empId: $('bEmp').value.trim(), plate: fmtPlates($('bPlate').value), dept: $('bDept').value.trim(), division: $('bDiv').value.trim(), zone: $('bZone').value, slot: $('bSlot').value, active: old ? old.active : true };
      if (old) touch(rec, 'แก้ไขข้อมูล'); else stamp(rec, 'ลงทะเบียนช่องประจำ');
      await savePerm(rec, old);
      done(rec, 'perm', old ? 'บันทึกการแก้ไขแล้ว' : 'ลงทะเบียนช่องประจำแล้ว');
    } else {
      if (isGuard) { const c = curShift(), v = $('bBy').value.trim().replace(/\s+/g, ' '); if (!v) { show('กรุณาใส่ชื่อ รปภ. ผู้บันทึก'); $('bBy').focus(); return; } setInspector(v, c.date, c.sh); }
      const old = id ? db.temp.find(t => t.id === id) : null, z = getZone($('bZone').value);
      const rec = { ...(old || {}), id: id || uid(), name: $('bName').value.trim(), plate: fmtPlates($('bPlate').value), zone: $('bZone').value, slot: z && z.free ? '' : $('bSlot').value,
        date: $('bDate').value, from: $('bFrom').value, to: $('bTo').value, kind: $('bKind').value, note: $('bNote').value.trim(), cancelled: old ? !!old.cancelled : false };
      const dto = sheetRange().dateTo; if (dto) rec.dateTo = dto; else delete rec.dateTo;
      if (z && isPermZone(z)) rec.kind = VIP_KIND;
      if (!old && rec.date < today()) throw new UserErr('เลือกวันที่ย้อนหลังไม่ได้');
      if ($('bDateTo').value && $('bDateTo').value < rec.date) throw new UserErr('วันสุดท้ายต้องไม่ก่อนวันเริ่ม');
      if (dayCount(rec) > MAX_DAYS) throw new UserErr(`จองต่อเนื่องได้สูงสุด ${MAX_DAYS} วัน (ประมาณ 6 เดือน)`);
      const e = dEnd(rec);
      if ((!old || old.date !== rec.date || dEnd(old) !== e || old.to !== rec.to) && (e < today() || (e === today() && rec.to && rec.to <= nowHM()))) throw new UserErr('เวลาออกผ่านไปแล้ว เลือกเวลาออกที่ยังไม่ถึง หรือเลือกวันอื่น');
      if (old) touch(rec, old.zone !== rec.zone || old.slot !== rec.slot ? `แก้ไข/ย้ายไป ${zoneName(rec.zone)} ${rec.slot || ''}`.trim() : 'แก้ไขข้อมูล'); else stamp(rec, 'สร้างการจอง');
      await saveTemp(rec, old);
      done(rec, 'temp', old ? 'บันทึกการแก้ไขแล้ว' : 'บันทึกการจองแล้ว');
    }
  } catch (err) { if (err instanceof UserErr) show(err.message); else { console.error(err); show('บันทึกไม่สำเร็จ ลองอีกครั้ง'); } }
  finally { btn.disabled = false; }
}
function done(rec, k, msg) {
  closeSheet(); toast(msg);
  S.zone = rec.zone; S.sel = k === 'perm' ? { perm: rec.id } : { temp: rec.id }; S.pop = rec.id;
  if (k === 'temp') { S.vDate = focusDate(rec); if (!overlap(rec.from, rec.to, S.vFrom, S.vTo)) { S.vFrom = rec.from; S.vTo = rec.to; S.follow = false; } }
  scheduleRender();
}

/* ---------- วันนี้ ---------- */
function todayRows() {   // รายการของวันที่และสถานที่ที่เลือก
  const d = S.tDate, fz = S.tZone || '';
  return db.temp.filter(t => onDay(t, d) && (!fz || t.zone === fz));
}
function renderToday() {
  const d = S.tDate; $('tDate').value = d;
  const zs = db.zones.filter(z => acceptsTemp(z) || db.temp.some(t => t.zone === z.id));
  if (S.tZone && !zs.some(z => z.id === S.tZone)) S.tZone = '';
  $('tZone').innerHTML = '<option value="">ทุกสถานที่</option>' + zs.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join(''); $('tZone').value = S.tZone || '';
  const list = todayRows().sort((a, b) => a.from.localeCompare(b.from));
  const active = list.filter(t => !t.cancelled), nowN = list.filter(t => dayStatus(t, d) === 'now').length;
  const zLabel = S.tZone ? zoneName(S.tZone) : 'ทุกสถานที่';
  $('todayLead').textContent = `${d === today() ? 'วันนี้ ' : ''}${fDL.format(toD(d))}`;
  if (!list.length) { $('todayBody').innerHTML = `<div class="empty">ไม่มีรถเข้าจอด${S.tZone ? ' ที่' + esc(zLabel) : ''} วันที่ ${fmtDate(d)}<br><button class="btn pri" data-act="new-temp">+ บันทึกคำขอ</button></div>`; return; }
  const RANK = { now: 0, today: 1, upcoming: 1, expired: 2, cancelled: 3 };
  const zones = db.zones.filter(z => list.some(t => t.zone === z.id));
  // สรุปจำนวนรถต่อสถานที่ (สำหรับแคปหน้าจอส่ง รปภ.)
  const one = zones.length === 1;
  const tbl = zones.map(z => { const rows = active.filter(t => t.zone === z.id); return `${one ? '' : `<tr class="ds-zone"><th colspan="4">${esc(z.name)} <small>${rows.length} คัน</small></th></tr>`}${rows.map((t, i) => `<tr><td class="nw">${i + 1}.</td><td class="nw"><b>${esc(t.plate)}</b></td><td>${esc(t.name)}${t.slot ? ` <small>ช่อง ${esc(t.slot)}</small>` : ''}${isMulti(t) ? ` <small>(ถึง ${fmtDate(dEnd(t))})</small>` : ''}</td><td class="nw">${esc(t.from)}–${esc(t.to)}</td></tr>`).join('')}`; }).join('');
  const sum = `<div class="day-sum"><div class="day-sum-h"><b>รถขอเข้าจอด ${esc(zLabel)}</b><span>${fDL.format(toD(d))}</span></div>
    <div class="day-sum-g">${one ? '' : zones.map(z => { const n = active.filter(t => t.zone === z.id).length; return `<div class="ds"><b>${n}</b><span>${esc(z.name)}${z.free ? ` <small>/ จุ ${capOf(z)} คัน</small>` : ''}</span></div>`; }).join('')}
    <div class="ds tot"><b>${active.length}</b><span>${one ? `คัน ที่${esc(zLabel)}${zones[0].free ? ` <small>(จุ ${capOf(zones[0])} คัน)</small>` : ''}` : 'รวมทุกสถานที่ (คัน)'}${d === today() && nowN ? ` <small>จอดอยู่ตอนนี้ ${nowN}</small>` : ''}</span></div></div>
    ${active.length ? `<table class="ds-tbl"><thead><tr><th></th><th>ทะเบียน</th><th>ชื่อ / บริษัท</th><th>เวลา</th></tr></thead><tbody>${tbl}</tbody></table>` : ''}
    <p class="ds-foot">แคปหน้าจอส่วนนี้ส่ง รปภ. ได้เลย หรือกด "คัดลอกข้อความ" แล้ววางใน LINE</p></div>
    <h3 class="ds-detail">รายละเอียดคำขอ</h3>`;
  $('todayBody').innerHTML = sum + zones.map(z => {
    const rows = list.filter(t => t.zone === z.id).sort((a, b) => RANK[dayStatus(a, d)] - RANK[dayStatus(b, d)] || a.from.localeCompare(b.from));
    return `<div class="zone-block"><h3>${esc(z.name)} <small>${rows.filter(t => !t.cancelled).length} คัน</small></h3>${rows.map(t => {
      const st = dayStatus(t, d);
      return `<div class="req ${st}"><div class="req-time">${esc(t.from)}<br><span class="muted" style="font-size:.85em">ถึง ${esc(t.to)}</span></div>
        <div><div class="req-name">${esc(t.name)} <span class="status st-${st}">${ST_TXT[st]}</span>${isMulti(t) ? ` <span class="status st-multi">จองต่อเนื่อง ถึง ${fmtDate(dEnd(t))}</span>` : ''}</div>
        <div class="req-sub">${esc(t.kind || '')} ทะเบียน <b>${esc(t.plate)}</b> ${z.free ? 'จอดอิสระ' : t.slot ? 'ช่อง ' + esc(t.slot) : 'ยังไม่ระบุช่อง'}${t.note ? '<br>' + esc(t.note) : ''}</div>
        <div class="req-sub noprint">บันทึกโดย ${esc(t.createdBy || '—')} ${fmtTs(t.createdAt)}</div></div>
        <div class="req-act noprint"><button class="link" data-act="goto-temp" data-id="${esc(t.id)}">ดูในผัง</button><button class="link" data-act="edit-temp" data-id="${esc(t.id)}">แก้ไข</button>${isLive(t) ? `<button class="link" data-act="cancel-temp" data-id="${esc(t.id)}">ยกเลิก</button>` : ''}<button class="link danger" data-act="del-temp" data-id="${esc(t.id)}">ลบ</button></div></div>`;
    }).join('')}</div>`;
  }).join('');
  guardTrim($('todayBody'));
}
function todayText() {   // ข้อความสรุปสำหรับวางใน LINE ส่ง รปภ.
  const d = S.tDate, list = todayRows().filter(t => !t.cancelled).sort((a, b) => a.from.localeCompare(b.from));
  const out = [`รถขอเข้าจอด ${fDL.format(toD(d))}${S.tZone ? ' (' + zoneName(S.tZone) + ')' : ''} รวม ${list.length} คัน`];
  db.zones.filter(z => list.some(t => t.zone === z.id)).forEach(z => {
    const rows = list.filter(t => t.zone === z.id);
    out.push('', `■ ${z.name} ${rows.length} คัน`);
    rows.forEach((t, i) => out.push(`${i + 1}. ${t.plate}  ${t.name}  ${t.from}–${t.to}${t.slot ? '  ช่อง ' + t.slot : ''}${isMulti(t) ? '  (ถึง ' + fmtDate(dEnd(t)) + ')' : ''}`));
  });
  return out.join('\n');
}

/* ---------- ตรวจเช็คประจำวัน (แทนแบบฟอร์มกระดาษ) ----------
   เอกสาร chk_<zone>_<date> (วันละ 1 ครั้งต่อสถานที่) : { zone, date, items: { <ช่อง>: { slot, r, seen, note, exp:{name,plate}, by, at } } }
   r = ok (มีรถ ทะเบียนตรง) / wrong (ทะเบียนไม่ตรง หรือมีรถอื่นจอดช่องว่าง) / none (ไม่มีรถจอด หรือว่างตามปกติ) */
const ckKey = sl => 's_' + normSlot(sl).replace(/[^a-z0-9฀-๿]/g, '_');
// แยกตามกะ: กะกลางวัน 07:00–19:00 (id เดิม chk_<zone>_<date>) / กะกลางคืน 19:00–07:00 (chk_<zone>_<date>_n) กะกลางคืนนับเป็นวันที่เริ่มกะ
const SHIFTS = { d: { name: 'กะกลางวัน', time: '07:00–19:00' }, n: { name: 'กะกลางคืน', time: '19:00–07:00' } };
const curShift = () => { const n = nowHM(); return n < '07:00' ? { date: addDays(today(), -1), sh: 'n' } : { date: today(), sh: n < '19:00' ? 'd' : 'n' }; };
const shiftKey = (d, sh) => `${d}_${sh}`;
const isFutureShift = (d, sh) => { const c = curShift(); return shiftKey(d, sh) > shiftKey(c.date, c.sh); };
const ckId = (z, d, sh = 'd') => `chk_${z}_${d}${sh === 'n' ? '_n' : ''}`;
const ckShiftOf = c => c.shift || (/_n$/.test(c.id) ? 'n' : 'd');
const ckDocOf = (zid, d, sh) => db.checks.find(c => c.id === ckId(zid, d, sh));
/* ชื่อผู้ตรวจ: ใส่เองตอนเริ่มตรวจ เครื่องจำไว้เฉพาะกะนั้น (บัญชี guard01 ใช้ร่วมกันได้หลายคน) */
const INS_KEY = 'parking_inspector', INS_RECENT = 'parking_inspector_recent';
function inspectorFor(d, sh) { try { const o = JSON.parse(localStorage.getItem(INS_KEY) || '{}'); return o.k === shiftKey(d, sh) && o.u === (user && user.email) ? o.name : ''; } catch (e) { return ''; } }
function recentInspectors() { try { return JSON.parse(localStorage.getItem(INS_RECENT) || '[]'); } catch (e) { return []; } }
function setInspector(name, d, sh) {
  try {
    localStorage.setItem(INS_KEY, JSON.stringify({ name, k: shiftKey(d, sh), u: user && user.email }));
    localStorage.setItem(INS_RECENT, JSON.stringify([name, ...recentInspectors().filter(x => x !== name)].slice(0, 8)));
  } catch (e) {}
  S.inspector = { name, k: shiftKey(d, sh) };
}
async function askInspector(force, d = d, sh = sh, opt = {}) {
  const k = shiftKey(d, sh);
  if (!force) { const cur = (S.inspector && S.inspector.k === k && S.inspector.name) || inspectorFor(d, sh); if (cur) { S.inspector = { name: cur, k }; return cur; } }
  const rec = recentInspectors(), pre = (S.inspector && S.inspector.name) || (!isGuard && by()) || '';
  const pr = openDialog({ title: opt.title || 'ชื่อผู้ตรวจ', body: `<p>${SHIFTS[sh].name} (${SHIFTS[sh].time}) วันที่ ${fmtDate(d)}</p>
    <form id="insForm" style="margin-top:10px"><label class="f"><span>ชื่อ-นามสกุล ผู้ตรวจ</span><input id="insName" maxlength="40" required autocomplete="off" list="insList" value="${esc(pre)}" placeholder="เช่น สมศักดิ์ ใจดี"></label>
    <datalist id="insList">${rec.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    ${rec.length ? `<div class="ins-recent">${rec.map(n => `<button type="button" class="btn ghost sm" data-ins="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}</form>
    <p class="muted" style="margin-top:8px;font-size:.88em">ชื่อนี้จะอยู่ในผลตรวจทุกช่องของกะนี้ เปลี่ยนคนตรวจกลางกะได้ที่ปุ่ม "เปลี่ยนผู้ตรวจ"</p>`,
    buttons: [{ label: 'ยกเลิก', value: false }, { label: opt.ok || 'เริ่มตรวจ', value: true, cls: 'pri' }] });
  const inp = $('insName'); if (inp) { inp.focus(); inp.select(); }
  const ok = await pr;
  const v =String(($('insName') || {}).value || '').trim().replace(/\s+/g, ' ');
  if (!ok) return '';
  if (!v) { toast('กรุณาใส่ชื่อผู้ตรวจ'); return ''; }
  setInspector(v, d, sh); return v;
}
const CK_TXT = { ok: 'มีรถ ทะเบียนตรง', wrong: 'ทะเบียนไม่ตรง', none: 'ไม่มีรถจอด' };
const ckLabel = (r, owned) => !r ? 'ยังไม่ตรวจ' : owned ? CK_TXT[r] : r === 'none' ? 'ว่าง' : 'มีรถอื่นจอด';
function expectedAt(z, sl, date) {   // ใครควรจอดช่องนี้ในวันนั้น
  const p = db.permanent.find(x => x.active && x.zone === z.id && normSlot(x.slot) === normSlot(sl));
  if (p) return { name: p.name, plate: p.plate, kind: 'perm', id: p.id };
  const t = db.temp.filter(x => !x.cancelled && x.zone === z.id && onDay(x, date) && normSlot(x.slot) === normSlot(sl)).sort((a, b) => a.from.localeCompare(b.from));
  if (t.length) return { name: t.map(x => x.name).join(', '), plate: t.map(x => x.plate).join(', '), kind: 'temp', time: t.map(x => `${x.from}–${x.to}`).join(', ') };
  return null;
}
const ckDoc = () => ckDocOf(S.cZone, S.cDate, S.cShift);
const ckEditable = () => !isFutureShift(S.cDate, S.cShift) && (isAdmin || S.cDate >= addDays(today(), -1));   // ยังไม่ถึงกะแก้ไม่ได้ / แก้ย้อนหลังได้ 1 วัน ผู้ดูแลแก้ได้ทุกวัน
function sortSlots(list) { return list.slice().sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })); }
function renderCheck() {
  const zs = db.zones.filter(z => !z.free);
  if (!zs.some(z => z.id === S.cZone)) S.cZone = zs[0] ? zs[0].id : null;
  $('cZone').innerHTML = zs.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join(''); $('cZone').value = S.cZone || '';
  if (!S.cShift) { const c = curShift(); S.cDate = c.date; S.cShift = c.sh; }
  $('cDate').value = S.cDate; $('cDate').max = today(); $('cShift').value = S.cShift;
  const z = getZone(S.cZone);
  if (!z) { $('cStage').innerHTML = '<div class="empty" style="margin:20px">ยังไม่มีสถานที่ที่มีเลขช่อง</div>'; $('cPanel').innerHTML = ''; $('cTable').innerHTML = ''; $('cProg').innerHTML = ''; return; }
  const doc = ckDoc(), items = (doc && doc.items) || {}, slots = sortSlots(z.slots);
  const res = sl => (items[ckKey(sl)] || {}).r || '';
  const cnt = { ok: 0, wrong: 0, none: 0 }; slots.forEach(sl => { const r = res(sl); if (r) cnt[r]++; });
  const done = cnt.ok + cnt.wrong + cnt.none, pct = slots.length ? Math.round(done / slots.length * 100) : 0;
  const whoAll = [...new Set(Object.values(items).map(i => i.by).filter(Boolean))].join(', ');
  $('cLead').textContent = `${z.name} ${fDL.format(toD(S.cDate))} ${SHIFTS[S.cShift].name} (${SHIFTS[S.cShift].time})${whoAll ? ` ผู้ตรวจ ${whoAll}` : ''}`;
  const insNow = ckEditable() ? ((S.inspector && S.inspector.k === shiftKey(S.cDate, S.cShift) && S.inspector.name) || inspectorFor(S.cDate, S.cShift)) : '';
  const insHtml = ckEditable() ? `<span class="ck-ins">ผู้ตรวจ <b>${insNow ? esc(insNow) : '<span class="muted">ยังไม่ระบุ</span>'}</b> <button class="link" data-act="ck-who" type="button">${insNow ? 'เปลี่ยนผู้ตรวจ' : 'ใส่ชื่อ'}</button></span>` : '';
  $('cProg').innerHTML = `<div class="cbar"><i style="width:${pct}%"></i></div><div class="cnums"><span><b>${done}</b>/${slots.length} ตรวจแล้ว</span><span class="c-ok"><b>${cnt.ok}</b> ตรง</span><span class="c-none"><b>${cnt.none}</b> ไม่มีรถ/ว่าง</span><span class="c-wrong"><b>${cnt.wrong}</b> ไม่ตรง</span>${insHtml}${isFutureShift(S.cDate, S.cShift) ? '<span class="muted">ยังไม่ถึงเวลากะนี้</span>' : !ckEditable() ? '<span class="muted">ดูย้อนหลัง แก้ไขไม่ได้</span>' : done < slots.length ? `<button class="btn sm pri" data-act="ck-next">ตรวจช่องถัดไป</button>` : '<span class="c-ok"><b>ตรวจครบแล้ว</b></span>'}</div>`;
  // ผัง
  const cell = (sl, pos) => {
    const ex = expectedAt(z, sl, S.cDate), r = res(sl), sel = S.cSlot && normSlot(S.cSlot) === normSlot(sl), tg = tagOf(z, sl);
    return `<button type="button" class="slot ${pos ? pos.cls : ''} ck ck-${r || 'todo'} ${ex ? 'owned' : ''} ${sel ? 'sel' : ''} ${tg ? 't-' + tg : ''}" data-act="ck-sel" data-slot="${esc(sl)}" ${pos ? `style="${pos.style}"` : ''} aria-label="${esc(`ช่อง ${sl} ${ex ? ex.name : 'ไม่มีเจ้าของ'} ${ckLabel(r, !!ex)}`)}" aria-pressed="${sel}">
      <span class="num">${esc(sl)}</span>${tg ? `<span class="stag">${tg === 'vip' ? 'VIP' : 'ผบ.'}</span>` : ''}<span class="ckm">${r === 'ok' ? '✓' : r === 'none' ? (ex ? '✕' : '–') : r === 'wrong' ? '!' : ''}</span>${ex ? `<span class="cko">${esc(short(firstName(ex.name), 8))}</span>` : ''}</button>`;
  };
  let lot;
  if (validLayout(z)) { const r = customLot(z, cell); lot = `<div class="lot custom" id="cLot" style="width:${r.w}px;height:${r.h}px">${r.html}</div>`; }
  else { const per = z.perRow, rows = []; for (let i = 0; i < z.slots.length; i += per) rows.push(z.slots.slice(i, i + per)); lot = `<div class="lot" id="cLot">${rows.map((r, ri) => `${ri % 2 === 0 ? '<div class="lane"></div>' : ''}<div class="prow ${ri % 2 ? 'down' : 'up'}">${r.map(sl => cell(sl)).join('')}</div>`).join('')}<div class="lane"></div></div>`; }
  const st = $('cStage'), sx = st.scrollLeft;
  st.innerHTML = `<div class="sizer" id="cSizer">${lot}</div>`;
  const L = $('cLot'), avail = Math.max(260, st.clientWidth - 16), sc = Math.max(window.innerWidth <= 760 ? 0.5 : 0.3, Math.min(1.1, avail / L.offsetWidth));
  L.style.setProperty('--s', sc.toFixed(3)); L.style.setProperty('--tilt', '0deg');
  $('cSizer').style.width = Math.max(avail, L.offsetWidth * sc + 24) + 'px'; $('cSizer').style.height = Math.ceil(L.offsetHeight * sc + 30) + 'px';
  st.scrollLeft = sx;
  renderCheckPanel(z, items);
  // ตารางตรวจทีละช่อง
  const ed = ckEditable();
  $('cPrintHead').innerHTML = `<h2>แบบฟอร์มตรวจเช็ครถประจำวัน</h2><p>${esc(z.name)}${z.note ? ' (' + esc(z.note) + ')' : ''} วันที่ ${fmtDate(S.cDate)} ${SHIFTS[S.cShift].name}</p>`;
  $('cTable').innerHTML = `<thead><tr><th>ช่อง</th><th>ผู้มีสิทธิ์จอด / ทะเบียน</th><th>ผลตรวจ</th><th>ทะเบียนที่พบ / หมายเหตุ</th><th class="noprint">ผู้ตรวจ</th></tr></thead><tbody>${slots.map(sl => {
    const ex = expectedAt(z, sl, S.cDate), it = items[ckKey(sl)] || {}, r = it.r || '', tg = tagOf(z, sl);
    const btn = (v, t) => `<button type="button" class="ckb ckb-${v} ${r === v ? 'on' : ''}" data-act="ck-set" data-slot="${esc(sl)}" data-r="${v}" ${ed ? '' : 'disabled'} aria-pressed="${r === v}">${t}</button>`;
    return `<tr class="${S.cSlot && normSlot(S.cSlot) === normSlot(sl) ? 'cur' : ''}"><td class="nw"><b>${esc(sl)}</b>${tg ? `<div class="sub">${TAG_TXT[tg]}</div>` : ''}</td>
      <td>${ex ? `${esc(ex.name)}<div class="sub">${esc(ex.plate)}${ex.time ? ' ' + esc(ex.time) : ''}</div>` : '<span class="muted">ไม่มีเจ้าของ</span>'}</td>
      <td class="nw"><div class="ckbs">${ex ? btn('ok', '✓ ตรง') + btn('wrong', '! ไม่ตรง') + btn('none', '✕ ไม่มีรถ') : btn('none', '– ว่าง') + btn('wrong', '! มีรถจอด')}</div><span class="print-only">${esc(ckLabel(r, !!ex))}</span></td>
      <td>${esc(it.seen || '')}${it.note ? `<div class="sub">${esc(it.note)}</div>` : ''}${ed && (r === 'wrong' || it.note) ? ` <button class="link noprint" data-act="ck-sel" data-slot="${esc(sl)}">${it.seen || it.note ? 'แก้' : 'ใส่ทะเบียน'}</button>` : ''}</td>
      <td class="sub nw noprint">${esc(it.by || '')}${it.at ? '<br>' + fmtTs(it.at) : ''}</td></tr>`;
  }).join('')}</tbody>`;
  renderCheckPrint(z);
}
/* แบบฟอร์มสำหรับพิมพ์: A4 แผ่นเดียว แบ่ง 2 คอลัมน์ ผลของกะกลางวันและกะกลางคืนอยู่ข้างกันในแถวเดียวกัน */
function renderCheckPrint(z) {
  const slots = sortSlots(z.slots), half = Math.ceil(slots.length / 2);
  const sh = { d: ckDocOf(z.id, S.cDate, 'd'), n: ckDocOf(z.id, S.cDate, 'n') }, its = k => (sh[k] && sh[k].items) || {};
  const cellOf = (it, owned) => {
    if (!it || !it.r) return '';
    const t = it.r === 'ok' ? '<b>✓</b> ตรง' : it.r === 'none' ? (owned ? '<b>✕</b> ไม่มีรถ' : '<b>–</b> ว่าง') : `<b>!</b> ${it.seen ? esc(it.seen) : owned ? 'ไม่ตรง' : 'มีรถจอด'}`;
    return `<span class="pr pr-${it.r}">${t}</span>${it.note ? `<small>${esc(short(it.note, 26))}</small>` : ''}`;
  };
  const row = sl => {
    const ex = expectedAt(z, sl, S.cDate), tg = tagOf(z, sl), k = ckKey(sl);
    return `<tr><td class="c-no">${esc(sl)}${tg ? `<small>${tg === 'vip' ? 'VIP' : 'ผบ.'}</small>` : ''}</td>
      <td class="c-who">${ex ? `<b>${esc(ex.plate)}</b><span>${esc(short(ex.name, 22))}</span>` : '<span class="c-empty">ว่าง</span>'}</td>
      <td class="c-sh">${cellOf(its('d')[k], !!ex)}</td><td class="c-sh">${cellOf(its('n')[k], !!ex)}</td></tr>`;
  };
  const table = list => `<table class="ptbl"><thead><tr><th>ช่อง</th><th>ทะเบียน / ผู้มีสิทธิ์จอด</th><th>กะกลางวัน</th><th>กะกลางคืน</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>`;
  const sum = k => {
    const v = Object.values(its(k)).filter(i => i && i.r), c = { ok: 0, wrong: 0, none: 0 }; v.forEach(i => c[i.r]++);
    const who = [...new Set(v.map(i => i.by).filter(Boolean))].join(', '), ts = v.map(i => i.at).filter(Boolean).sort((a, b) => a - b);
    const hm = t => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    return `<div class="pf-sh"><div><b>${SHIFTS[k].name}</b> ${SHIFTS[k].time}</div>
      <div>ตรวจ ${v.length}/${slots.length} · ตรง ${c.ok} · ไม่ตรง ${c.wrong} · ไม่มีรถ/ว่าง ${c.none}</div>
      <div>ผู้ตรวจ ${who ? `<b>${esc(who)}</b>` : '..............................'} เวลา ${ts.length ? `${hm(ts[0])}–${hm(ts[ts.length - 1])} น.` : '.............. น.'}</div>
      <div class="pf-sign">ลงชื่อ ..........................................</div></div>`;
  };
  $('cPrintForm').innerHTML = `<div class="pf-head"><div><h2>แบบฟอร์มตรวจเช็ครถประจำวัน</h2><p>${esc(z.name)}${z.note ? ' (' + esc(z.note) + ')' : ''}</p></div>
      <div class="pf-meta"><div>วันที่ <b>${fmtDate(S.cDate)}</b></div><div>รวม ${slots.length} ช่อง · ✓ ตรง · ! ไม่ตรง (ทะเบียนที่พบ) · ✕ ไม่มีรถ · – ว่าง</div></div></div>
    <div class="pf-cols">${table(slots.slice(0, half))}${table(slots.slice(half))}</div>
    <div class="pf-foot">${sum('d')}${sum('n')}</div>`;
}
function renderCheckPanel(z, items) {
  const p = $('cPanel'), sl = S.cSlot;
  if (!sl || !hasSlot(z, sl)) {
    p.innerHTML = `<div class="panel-empty"><h3>ตรวจทีละช่อง</h3><ol><li>เลือกสถานที่และวันที่</li><li>แตะช่องในผัง หรือกด "ตรวจช่องถัดไป"</li><li>เลือกผล ระบบจะไปช่องถัดไปให้เอง</li></ol><p style="margin-top:10px">หรือกดปุ่มผลในตารางด้านล่างได้เลย ผลจะบันทึกทันทีพร้อมชื่อผู้ตรวจและเวลา</p></div>`;
    return;
  }
  const ex = expectedAt(z, sl, S.cDate), it = items[ckKey(sl)] || {}, ed = ckEditable(), tg = tagOf(z, sl);
  const big = (v, t, cls) => `<button type="button" class="btn ${cls} ckbig ${it.r === v ? 'on' : ''}" data-act="ck-set" data-slot="${esc(sl)}" data-r="${v}" data-adv="1" ${ed ? '' : 'disabled'}>${t}</button>`;
  p.innerHTML = `<div class="p-slot">${esc(sl)}</div><div class="p-zone">${esc(z.name)} ${fmtDate(S.cDate)}</div>
    <p style="margin-top:10px"><span class="status st-${it.r === 'ok' ? 'free' : it.r === 'wrong' ? 'cancelled' : it.r === 'none' ? 'expired' : 'today'}">${ckLabel(it.r, !!ex)}</span> ${tg ? `<span class="status st-${tg}">${TAG_TXT[tg]}</span>` : ''}</p>
    <dl>${ex ? `<dt>ผู้มีสิทธิ์</dt><dd>${esc(ex.name)}</dd><dt>ทะเบียน</dt><dd><b style="font-size:1.15rem">${esc(ex.plate)}</b></dd>${ex.time ? `<dt>เวลาจอง</dt><dd>${esc(ex.time)}</dd>` : ''}` : '<dt>ผู้มีสิทธิ์</dt><dd>ไม่มี (ช่องว่าง)</dd>'}
    ${it.by ? `<dt>ตรวจโดย</dt><dd>${esc(it.by)}${it.acct && !isGuard ? ` <span class="muted">(${esc(it.acct)})</span>` : ''}<br><span class="muted">${fmtTs(it.at)}</span></dd>` : ''}</dl>
    <div class="ckgrid">${ex ? big('ok', '✓ มีรถ ทะเบียนตรง', 'ck-okb') + big('wrong', '! มีรถ ทะเบียนไม่ตรง', 'ck-wrongb') + big('none', '✕ ไม่มีรถจอด', 'ck-noneb') : big('none', '– ว่าง ไม่มีรถ', 'ck-noneb') + big('wrong', '! มีรถอื่นจอด', 'ck-wrongb')}</div>
    <form id="ckForm" class="grid2" style="margin-top:12px"><label class="f"><span>ทะเบียนที่พบ</span><input name="seen" maxlength="20" value="${esc(it.seen || '')}" ${ed ? '' : 'disabled'} placeholder="ถ้าไม่ตรง"></label>
    <label class="f"><span>หมายเหตุ</span><input name="note" maxlength="80" value="${esc(it.note || '')}" ${ed ? '' : 'disabled'}></label>
    ${ed ? `<div class="span2 row-gap"><button class="btn sm" type="submit">บันทึกทะเบียน/หมายเหตุ</button>${it.r ? `<button class="btn ghost sm" type="button" data-act="ck-clear" data-slot="${esc(sl)}">ล้างผลช่องนี้</button>` : ''}</div>` : ''}</form>`;
}
async function saveCheck(sl, patch) {
  const z = getZone(S.cZone); if (!z || !ckEditable()) return false;
  const who = await askInspector(); if (!who) return false;
  const id = ckId(z.id, S.cDate, S.cShift), cur = db.checks.find(c => c.id === id), k = ckKey(sl), ex = expectedAt(z, sl, S.cDate), n = Date.now(), acct = shortId(user && user.email);
  const prev = (cur && cur.items && cur.items[k]) || {};
  const item = patch === null ? null : { ...prev, ...patch, slot: sl, exp: ex ? { name: ex.name, plate: ex.plate, ...(ex.id ? { id: ex.id } : {}) } : null, by: who, acct, at: n };
  const base = { id, zone: z.id, date: S.cDate, shift: S.cShift, updatedAt: n, updatedBy: who, updatedAcct: acct };
  const merged = { ...(cur || { createdAt: n, by: who }), ...base, items: { ...((cur && cur.items) || {}) } };
  if (item) merged.items[k] = item; else delete merged.items[k];
  docs.set(id, toDoc('check', merged)); rebuild();
  if (!fs) { demoSave(); return true; }
  const F = firebase.firestore.FieldValue;
  try { await col.doc(id).set({ ...base, docKind: 'check', ...(cur ? {} : { createdAt: n, by: who }), items: { [k]: item ? JSON.parse(JSON.stringify(item)) : F.delete() } }, { merge: true }); }
  catch (e) { writeErr(e); }
  return true;
}
function nextUnchecked(z, from) {
  const items = (ckDoc() || {}).items || {}, list = sortSlots(z.slots), i0 = from ? list.findIndex(x => normSlot(x) === normSlot(from)) : -1;
  for (let k = 1; k <= list.length; k++) { const sl = list[(i0 + k) % list.length]; if (!(items[ckKey(sl)] || {}).r) return sl; }
  return null;
}
function exportCheck() {
  const z = getZone(S.cZone); if (!z) return;
  const items = (ckDoc() || {}).items || {};
  const rows = [['สถานที่', 'วันที่', 'กะ', 'ช่อง', 'ผู้มีสิทธิ์จอด', 'ทะเบียนที่ลงไว้', 'ผลตรวจ', 'ทะเบียนที่พบ', 'หมายเหตุ', 'ผู้ตรวจ', 'บัญชีที่ใช้', 'เวลา']];
  sortSlots(z.slots).forEach(sl => { const it = items[ckKey(sl)] || {}, ex = it.exp || expectedAt(z, sl, S.cDate); rows.push([z.name, dmy(S.cDate), SHIFTS[S.cShift].name, sl, ex ? ex.name : '', ex ? ex.plate : '', ckLabel(it.r, !!ex), it.seen || '', it.note || '', it.by || '', it.acct || '', it.at ? fmtTs(it.at) : '']); });
  download(`ตรวจเช็ค-${z.name}-${S.cDate}-${SHIFTS[S.cShift].name}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
}
function checkStats(days) {   // สำหรับหน้าสรุป
  const d0 = addDays(today(), -(days - 1)), list = db.checks.filter(c => c.date >= d0 && c.date <= today());
  const st = { rounds: list.length, ok: 0, none: 0, wrong: 0, owned: 0, noneBy: new Map(), wrongBy: new Map() };
  list.forEach(c => Object.values(c.items || {}).forEach(it => {
    if (!it || !it.r) return; const owned = !!it.exp;
    if (owned) { st.owned++; st[it.r]++; } else if (it.r === 'wrong') st.wrong++;
    const key = `${zoneName(c.zone)} ช่อง ${it.slot}${owned ? ' ' + it.exp.name : ''}`;
    if (owned && it.r === 'none') st.noneBy.set(key, (st.noneBy.get(key) || 0) + 1);
    if (it.r === 'wrong') st.wrongBy.set(key, (st.wrongBy.get(key) || 0) + 1);
  }));
  return st;
}

/* ---------- สรุป ---------- */
function rangeTemps(days) { const from = addDays(today(), -(days - 1)), to = today(); return db.temp.filter(t => !t.cancelled && t.date <= to && dEnd(t) >= from); }
function renderSum() {
  const st = S.stab || 'period';
  document.querySelectorAll('[data-act="stab"]').forEach(b => b.setAttribute('aria-selected', b.dataset.s === st));
  $('perBody').hidden = st !== 'period'; $('rateBody').hidden = st !== 'rate'; $('sumBody').hidden = st !== 'over'; $('sumOverCtl').hidden = st !== 'over';
  $('sumLead').textContent = st === 'period' ? 'ใครมาจอดเท่าไหร่ ทั้งรถชั่วคราวและช่องประจำ' : st === 'rate' ? '% การมาจอดช่องประจำ เทียบหลายเดือน' : '';
  if (st === 'period') return renderPeriod();
  if (st === 'rate') return renderRate();
  const R = +$('sRange').value || 30, d0 = addDays(today(), -(R - 1)), tl = rangeTemps(R), n = nowHM();
  $('sumLead').textContent = `${fmtDate(d0)} ถึง ${fmtDate(today())}`;
  let cap = 0, usedNow = 0;
  const occRows = db.zones.map(z => { const o = occupancy(z, today(), n, m2hm(hm2m(n) + 1)); cap += o.cap; usedNow += o.used; return { z, o }; });
  const todayReq = db.temp.filter(t => onDay(t, today()) && !t.cancelled).length;
  const kpi = `<div class="kpis"><div class="kpi"><b>${cap}</b><span>ความจุรวมทุกสถานที่</span></div><div class="kpi"><b>${usedNow}</b><span>จอดอยู่ตอนนี้ (${cap ? Math.round(usedNow / cap * 100) : 0}%)</span></div>
    <div class="kpi"><b>${todayReq}</b><span>คำขอวันนี้</span></div><div class="kpi"><b>${tl.length}</b><span>คำขอใน ${R} วัน</span></div></div>`;
  const occ = `<div class="card wide"><h3>ตอนนี้ (${n} น.)</h3>${occRows.map(({ z, o }) => {
    const base = Math.max(o.cap, o.used, 1);
    return `<div class="occ"><span>${esc(z.name)}</span><div class="occ-bar" title="ระยะยาว ${o.perm} ชั่วคราว ${o.tmp}"><i class="p" style="width:${o.perm / base * 100}%"></i><i class="t" style="width:${o.tmp / base * 100}%"></i></div><span class="occ-num">${o.used}/${o.cap}</span></div>`;
  }).join('')}<div class="legend"><span><i class="lg perm"></i>ระยะยาว</span><span><i class="lg temp"></i>ชั่วคราว</span></div></div>`;
  // กราฟรายวัน
  const days = []; for (let i = 0; i < R; i++) days.push(addDays(d0, i));
  const cnt = days.map(d => tl.filter(t => onDay(t, d)).length), mx = Math.max(1, ...cnt);
  const chart = chartCard('จำนวนรถชั่วคราวที่ขอเข้าจอด ต่อวัน', `แต่ละแท่ง = จำนวนคำขอจอดชั่วคราวในวันนั้น (คัน) ย้อนหลัง ${R} วัน`,
    barChart(days.map((d, i) => ({ label: dLab(d), v: cnt[i], cls: d === today() ? 'now' : '', tip: `${fmtDate(d)}: ${cnt[i]} คัน` })), { unit: 'คัน', label: 'คำขอรายวัน' }),
    '<span><i class="lg lg-a"></i>วันที่ผ่านมา</span><span><i class="lg lg-now"></i>วันนี้</span>');
  const hb = (title, pairs, cls = '') => { const m = Math.max(1, ...pairs.map(p => p[1])); return `<div class="card ${cls}"><h3>${title}</h3>${pairs.length ? pairs.map(([k, v]) => `<div class="hbar"><span class="lbl" title="${esc(k)}">${esc(k)}</span><div><div class="bar" style="width:${v / m * 100}%"></div></div><span class="n">${v}</span></div>`).join('') : '<p class="muted">ยังไม่มีข้อมูล</p>'}</div>`; };
  const group = (arr, f) => { const m = new Map(); arr.forEach(x => { const k = f(x) || '(ไม่ระบุ)'; m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const permA = db.permanent.filter(p => p.active);
  $('sumBody').innerHTML = kpi + `<div class="sum-grid">${occ}${chart}
    ${hb('ตามประเภทผู้จอด', group(tl, t => t.kind), 'third')}${hb('ตามสถานที่', group(tl, t => zoneName(t.zone)), 'third')}${hb('ผู้ขอใช้บ่อยที่สุด', group(tl, t => t.name.trim()).slice(0, 8), 'third')}
    ${hb(`ช่องประจำตามแผนก (${permA.length} คน)`, group(permA, p => p.dept).slice(0, 12))}${hb('ช่องประจำตามสถานที่', group(permA, p => zoneName(p.zone)))}
    ${(() => { const c = checkStats(R); if (!c.rounds) return '<div class="card wide"><h3>ผลตรวจเช็ค</h3><p class="muted">ยังไม่มีการตรวจเช็คในช่วงนี้</p></div>';
      const pc = v => c.owned ? Math.round(v / c.owned * 100) + '%' : '—';
      return `<div class="card wide"><h3>ผลตรวจเช็ค ${c.rounds} ครั้ง (วัน × กะ × สถานที่)</h3><div class="kpis" style="margin:0 0 14px"><div class="kpi"><b>${pc(c.ok)}</b><span>มีรถ ทะเบียนตรง</span></div><div class="kpi"><b>${pc(c.none)}</b><span>ช่องประจำที่ไม่มีรถจอด</span></div><div class="kpi"><b>${c.wrong}</b><span>ทะเบียนไม่ตรง / รถอื่นจอด</span></div><div class="kpi"><b>${c.owned}</b><span>ช่องประจำที่ตรวจ (ครั้ง)</span></div></div></div>`
        + hb('ช่องประจำที่ไม่มีรถจอดบ่อย', [...c.noneBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) + hb('ทะเบียนไม่ตรงบ่อย', [...c.wrongBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)); })()}</div>`;
}

/* ---------- กราฟแท่งแบบอ่านง่าย: มีเส้นแกน ตัวเลขบนแท่ง หน่วย และคำอธิบาย ---------- */
const niceMax = v => { if (v <= 5) return 5; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
/* items: [{ label, v (ตัวเลข หรือ null = ไม่มีข้อมูล), cls: '' | 'now' | 'future' | 'pct', tip }] */
function barChart(items, o = {}) {
  const W = 1200, H = o.h || 200, L = 52, R = 10, T = 22, n = Math.max(1, items.length);
  const max = o.pct ? 100 : niceMax(Math.max(1, ...items.map(x => x.v || 0)));
  const slot = (W - L - R) / n, bw = Math.min(64, slot * 0.78), y = v => T + (H - T) * (1 - v / max);
  const step = n <= 16 ? 1 : n <= 31 ? 2 : Math.ceil(n / 16), showVal = n <= 40;
  const grid = [0, 0.5, 1].map(f => { const v = max * f; return `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}" class="gl${f ? '' : ' g0'}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="ax">${o.pct ? Math.round(v) + '%' : (Number.isInteger(v) ? v : v.toFixed(1))}</text>`; }).join('');
  const bars = items.map((x, i) => {
    const cx = L + slot * i + slot / 2, X = (cx - bw / 2).toFixed(1);
    const near = j => step > 1 && items[j] && items[j].cls === 'now', lab = (i % step === 0 && !near(i + 1) && !near(i - 1)) || x.cls === 'now' ? `<text x="${cx.toFixed(1)}" y="${H + 18}" text-anchor="middle" class="xl${x.cls === 'now' ? ' xnow' : ''}">${esc(x.label)}</text>` : '';
    if (x.v == null) return lab + `<text x="${cx.toFixed(1)}" y="${H - 4}" text-anchor="middle" class="nd">–</text>`;
    const h = Math.max(x.v ? 2 : 0, (H - y(x.v) + T - T)), top = y(x.v);
    return `<g class="b ${x.cls || ''}"><rect x="${X}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - top).toFixed(1)}" rx="3"><title>${esc(x.tip || '')}</title></rect>${showVal && (x.v || o.pct) ? `<text x="${cx.toFixed(1)}" y="${(top - 6).toFixed(1)}" text-anchor="middle" class="bv">${o.pct ? Math.round(x.v) + '%' : x.v}</text>` : ''}</g>${lab}`;
  }).join('');
  return `<svg class="bchart" viewBox="0 0 ${W} ${H + 28}" role="img" aria-label="${esc(o.label || '')}">${grid}${bars}<text x="4" y="12" class="ax unit">${esc(o.unit || '')}</text></svg>`;
}
const chartCard = (title, sub, svg, legend = '', cls = 'wide') => `<div class="card ${cls} chart-card"><h3>${title}</h3>${sub ? `<p class="chart-sub">${sub}</p>` : ''}${legend ? `<div class="legend chart-lg">${legend}</div>` : ''}<div class="chart">${svg}</div></div>`;
const dLab = d => `${+d.slice(8)} ${TH_MON[+d.slice(5, 7) - 1]}`;   // 16 พ.ย.
const dmy = d => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${+d.slice(0, 4) + 543}` : '';   // 16/11/2569

/* ---------- ช่องเลือกวันที่: แสดงเป็น วัน/เดือน/ปี (พ.ศ.) ทุกเครื่อง ไม่ขึ้นกับภาษาของเบราว์เซอร์ ---------- */
const VALD = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
const fmtInput = (v, type) => { if (!v) return type === 'month' ? 'เลือกเดือน' : 'วว/ดด/ปปปป'; const [y, m, d] = v.split('-'); return type === 'month' ? `${TH_MONL[+m - 1]} ${+y + 543}` : `${d}/${m}/${+y + 543}`; };
function thaiDate(inp) {
  if (!inp || inp.dataset.td) return; inp.dataset.td = '1';
  const w = document.createElement('span'); w.className = 'dpw'; inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
  const lab = document.createElement('span'); lab.className = 'dpv'; lab.setAttribute('aria-hidden', 'true'); w.appendChild(lab);
  const upd = () => { lab.textContent = fmtInput(VALD.get.call(inp), inp.type); };
  Object.defineProperty(inp, 'value', { get() { return VALD.get.call(this); }, set(v) { VALD.set.call(this, v); upd(); }, configurable: true });
  inp.addEventListener('input', upd); inp.addEventListener('change', upd);
  inp.addEventListener('click', () => { try { inp.showPicker(); } catch (e) {} });
  upd();
}
const thaiDates = root => (root || document).querySelectorAll('input[type="date"], input[type="month"]').forEach(thaiDate);

/* ================= สรุปตามช่วงเวลา: รายวัน / รายสัปดาห์ / รายเดือน / ทั้งปี =================
   รถชั่วคราว: นับจากคำขอที่ไม่ถูกยกเลิก 1 คัน 1 วัน = 1 ครั้ง (จองหลายวันนับทุกวันที่อยู่ในช่วง)
   ช่องประจำ: นับจากผลตรวจเช็ค วันที่ทะเบียนตรงกะใดกะหนึ่ง = มาจอด / วันที่ช่องนั้นถูกตรวจ = วันทั้งหมด */
const P_MODES = { day: 'รายวัน', week: 'รายสัปดาห์', month: 'รายเดือน', year: 'ทั้งปี' };
const dowOf = d => new Date(d + 'T00:00:00Z').getUTCDay();
function perRange(mode, a) {
  if (mode === 'day') return [a, a];
  if (mode === 'week') { const s = addDays(a, -((dowOf(a) + 6) % 7)); return [s, addDays(s, 6)]; }
  if (mode === 'month') { const ym = a.slice(0, 7); return [ym + '-01', `${ym}-${String(monDays(ym)).padStart(2, '0')}`]; }
  return [a.slice(0, 4) + '-01-01', a.slice(0, 4) + '-12-31'];
}
function perLabel(mode, a) {
  const [s, e] = perRange(mode, a), y = n => +n + 543;
  if (mode === 'day') return fDL.format(toD(s));
  if (mode === 'week') return `${fDS.format(toD(s))} – ${fD.format(toD(e))}`;
  if (mode === 'month') return monLabel(s.slice(0, 7), true);
  return `ปี ${y(s.slice(0, 4))}`;
}
function perShift(mode, a, n) {
  if (mode === 'day') return addDays(a, n);
  if (mode === 'week') return addDays(a, 7 * n);
  if (mode === 'month') { let [y, m] = a.slice(0, 7).split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}-01`; }
  return `${+a.slice(0, 4) + n}-01-01`;
}
const perState = () => S.per || (S.per = { mode: 'month', a: today(), zone: '', view: 'temp' });
const dayList = (s, e) => { const out = []; for (let d = s; d <= e && out.length < 370; d = addDays(d, 1)) out.push(d); return out; };
function periodData(s, e, zid) {
  const days = dayList(s, e);
  // รถชั่วคราว
  const temps = db.temp.filter(t => !t.cancelled && (!zid || t.zone === zid) && t.date <= e && dEnd(t) >= s);
  const tv = [];   // [{t, d}]
  temps.forEach(t => days.forEach(d => { if (onDay(t, d)) tv.push({ t, d }); }));
  const who = new Map();
  tv.forEach(({ t, d }) => {
    const k = normName(t.name).toLowerCase() + '|' + String(t.plate || '').replace(/\s+/g, '');
    if (!who.has(k)) who.set(k, { name: t.name, plate: t.plate, kinds: new Set(), zones: new Set(), days: new Set(), last: d });
    const o = who.get(k); o.kinds.add(t.kind || 'ชั่วคราว'); o.zones.add(zoneName(t.zone)); o.days.add(d); if (d > o.last) o.last = d;
  });
  const tRows = [...who.values()].map(o => ({ ...o, n: o.days.size })).sort((a, b) => b.n - a.n || b.last.localeCompare(a.last));
  // ช่องประจำ
  const per = new Map(), ckDays = new Set(); let wrong = 0;
  db.checks.filter(c => c.date >= s && c.date <= e && (!zid || c.zone === zid)).forEach(c => Object.values(c.items || {}).forEach(it => {
    if (!it || !it.r) return; ckDays.add(c.date);
    if (it.r === 'wrong') wrong++;
    if (!it.exp) return;
    const p = personOf(it.exp), k = c.zone + '|' + normSlot(it.slot) + '|' + p.key;
    if (!per.has(k)) per.set(k, { zone: c.zone, slot: it.slot, person: p, d: {} });
    const o = per.get(k); o.d[c.date] = Math.max(o.d[c.date] ?? 0, it.r === 'ok' ? 1 : 0);
  }));
  const pRows = [...per.values()].map(o => { const v = Object.values(o.d); return { ...o, park: v.filter(x => x === 1).length, tot: v.length }; })
    .map(o => ({ ...o, pct: o.tot ? o.park / o.tot : null }))
    .sort((a, b) => zoneName(a.zone).localeCompare(zoneName(b.zone)) || String(a.slot).localeCompare(String(b.slot), undefined, { numeric: true }));
  const park = pRows.reduce((x, r) => x + r.park, 0), tot = pRows.reduce((x, r) => x + r.tot, 0);
  // แนวโน้ม: รายวัน (ปี = รายเดือน)
  const byMonth = days.length > 62, buckets = byMonth ? [...new Set(days.map(d => d.slice(0, 7)))] : days;
  const key = d => byMonth ? d.slice(0, 7) : d;
  const trend = buckets.map(b => ({ b, temp: tv.filter(x => key(x.d) === b).length, park: 0, tot: 0 }));
  const tIdx = new Map(trend.map((x, i) => [x.b, i]));
  pRows.forEach(r => Object.entries(r.d).forEach(([d, v]) => { const x = trend[tIdx.get(key(d))]; if (x) { x.tot++; x.park += v; } }));
  const group = (arr, f) => { const m = new Map(); arr.forEach(x => { const k = f(x) || '(ไม่ระบุ)'; m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  return { s, e, days, tv, tRows, plates: new Set(tv.map(x => String(x.t.plate || '').replace(/\s+/g, ''))).size, pRows, park, tot, pct: tot ? park / tot : null, ckDays: ckDays.size, wrong, trend, byMonth,
    byZone: group(tv, x => zoneName(x.t.zone)), byKind: group(tv, x => x.t.kind || 'ชั่วคราว') };
}
function renderPeriod() {
  const P = perState(), box = $('perBody'); if (!box) return;
  const [s, e] = perRange(P.mode, P.a), D = periodData(s, e, P.zone), zs = db.zones;
  const ring = v => { const p = v == null ? 0 : Math.round(v * 100), C = 2 * Math.PI * 26; return `<svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="none" stroke="var(--line)" stroke-width="7"/><circle cx="32" cy="32" r="26" fill="none" stroke="var(--sign)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(C * p / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle">${v == null ? '—' : p + '%'}</text></svg>`; };
  const kpis = `<div class="pk-grid">
    <div class="pk pk-a"><b>${D.tv.length}</b><span>รถชั่วคราวเข้าจอด (ครั้ง)</span><small>ทะเบียนไม่ซ้ำ ${D.plates} คัน</small></div>
    <div class="pk pk-b"><b>${D.park}</b><span>ช่องประจำมาจอด (คน-วัน)</span><small>จากที่ตรวจ ${D.tot} ครั้ง</small></div>
    <div class="pk pk-c">${ring(D.pct)}<div><b>${D.pct == null ? '—' : pctTxt(D.pct)}</b><span>อัตราการมาจอดช่องประจำ</span><small>${D.pRows.length} คน</small></div></div>
    <div class="pk pk-d"><b>${D.ckDays}</b><span>วันที่มีการตรวจเช็ค</span><small>ทะเบียนไม่ตรง ${D.wrong} ครั้ง</small></div></div>`;
  // กราฟแนวโน้ม
  const hourly = P.mode === 'day', td = today();
  let chartA, chartB = '';
  if (hourly) {
    const HRS = []; for (let h = 6; h <= 21; h++) { const a = String(h).padStart(2, '0') + ':00', z = String(h + 1).padStart(2, '0') + ':00', v = D.tv.filter(x => x.t.from < z && x.t.to > a).length; HRS.push({ label: h + ' น.', v, tip: `${a}–${z} น.: มีรถชั่วคราวในลาน ${v} คัน` }); }
    chartA = chartCard('รถชั่วคราวในลาน แต่ละชั่วโมง', 'แต่ละแท่ง = จำนวนรถชั่วคราวที่อยู่ในลานช่วงชั่วโมงนั้น (ตามเวลาที่ขอเข้า–ออก)', barChart(HRS, { unit: 'คัน', label: 'รถชั่วคราวรายชั่วโมง' }));
  } else {
    const A = D.trend.map(x => { const lbl = D.byMonth ? TH_MON[+x.b.slice(5) - 1] : dLab(x.b), when = D.byMonth ? monLabel(x.b, true) : fmtDate(x.b); const fut = D.byMonth ? x.b > td.slice(0, 7) : x.b > td, now = D.byMonth ? x.b === td.slice(0, 7) : x.b === td;
      return { label: lbl, v: x.temp, cls: now ? 'now' : fut ? 'future' : '', tip: `${when}: รถชั่วคราว ${x.temp} ${D.byMonth ? 'ครั้ง' : 'คัน'}${fut ? ' (จองล่วงหน้า)' : ''}` }; });
    const hasFut = A.some(x => x.cls === 'future'), hasNow = A.some(x => x.cls === 'now');
    chartA = chartCard(`รถชั่วคราวเข้าจอด ${D.byMonth ? 'รายเดือน' : 'รายวัน'}`, D.byMonth ? 'แต่ละแท่ง = จำนวนครั้งที่รถชั่วคราวเข้าจอดในเดือนนั้น (1 คัน 1 วัน = 1 ครั้ง)' : 'แต่ละแท่ง = จำนวนรถชั่วคราวที่ขอเข้าจอดในวันนั้น (คัน)',
      barChart(A, { unit: D.byMonth ? 'ครั้ง' : 'คัน', label: 'รถชั่วคราวเข้าจอด' }),
      `<span><i class="lg lg-a"></i>วันที่ผ่านมา</span>${hasNow ? `<span><i class="lg lg-now"></i>${D.byMonth ? 'เดือนนี้' : 'วันนี้'}</span>` : ''}${hasFut ? '<span><i class="lg lg-fut"></i>จองล่วงหน้า (ยังไม่ถึงวัน)</span>' : ''}`);
    const B = D.trend.filter(x => D.byMonth ? x.b <= td.slice(0, 7) : x.b <= td).map(x => ({ label: D.byMonth ? TH_MON[+x.b.slice(5) - 1] : dLab(x.b), v: x.tot ? x.park / x.tot * 100 : null, cls: 'pct', tip: x.tot ? `${D.byMonth ? monLabel(x.b, true) : fmtDate(x.b)}: มาจอด ${x.park} จาก ${x.tot} ช่องที่ตรวจ (${pctTxt(x.park / x.tot)})` : 'ไม่ได้ตรวจ' }));
    chartB = B.some(x => x.v != null) ? chartCard(`ช่องประจำ: % ที่มาจอดจริง ${D.byMonth ? 'รายเดือน' : 'รายวัน'}`, 'แต่ละแท่ง = จากช่องประจำที่ รปภ. ตรวจ มีกี่ % ที่เจอรถทะเบียนของเจ้าของช่อง (ยิ่งสูงยิ่งใช้ช่องคุ้ม) · ขีด – = วันที่ไม่ได้ตรวจ',
      barChart(B, { pct: true, unit: '% มาจอด', label: 'อัตราการมาจอดช่องประจำ' })) : '';
  }
  const hb = (title, pairs) => { const m = Math.max(1, ...pairs.map(p => p[1])); return `<div class="card third"><h3>${title}</h3>${pairs.length ? pairs.slice(0, 8).map(([k, v]) => `<div class="hbar"><span class="lbl" title="${esc(k)}">${esc(k)}</span><div><div class="bar" style="width:${v / m * 100}%"></div></div><span class="n">${v}</span></div>`).join('') : '<p class="muted">ไม่มีข้อมูลในช่วงนี้</p>'}</div>`; };
  const lowP = D.pRows.filter(r => r.pct != null).sort((a, b) => a.pct - b.pct).slice(0, 8).map(r => [`${r.slot} ${r.person.name}`, Math.round(r.pct * 100)]);
  const hbPct = `<div class="card third"><h3>ช่องประจำ มาจอดน้อยสุด</h3>${lowP.length ? lowP.map(([k, v]) => `<div class="hbar"><span class="lbl" title="${esc(k)}">${esc(k)}</span><div><div class="bar bar-p" style="width:${v}%"></div></div><span class="n">${v}%</span></div>`).join('') : '<p class="muted">ยังไม่มีผลตรวจในช่วงนี้</p>'}</div>`;
  // ตาราง ใครมาจอดเท่าไหร่
  const tTbl = D.tRows.length ? `<table class="tbl"><thead><tr><th>#</th><th>ชื่อ / บริษัท</th><th>ทะเบียน</th><th>ประเภท</th><th>สถานที่</th><th class="num">จำนวนวัน</th><th>มาล่าสุด</th></tr></thead><tbody>${D.tRows.map((r, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(r.name)}</td><td class="nw"><b>${esc(r.plate)}</b></td><td>${esc([...r.kinds].join(', '))}</td><td>${esc([...r.zones].join(', '))}</td><td class="num"><b>${r.n}</b></td><td class="nw">${fmtDate(r.last)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="padding:16px 0">ไม่มีรถชั่วคราวในช่วงนี้</p>';
  const pTbl = D.pRows.length ? `<table class="tbl rate-tbl"><thead><tr><th>สถานที่</th><th>ช่อง</th><th>ชื่อ-นามสกุล</th><th>ทะเบียน</th><th class="num">มาจอด</th><th class="num">วันที่ตรวจ</th><th class="num">%</th></tr></thead><tbody>${D.pRows.map(r => `<tr><td>${esc(zoneName(r.zone))}</td><td class="nw"><b>${esc(r.slot)}</b></td><td>${esc(r.person.name)}${r.person.dept ? `<div class="sub">${esc(r.person.dept)}</div>` : ''}</td><td class="nw">${esc(r.person.plate)}</td><td class="num">${r.park}</td><td class="num">${r.tot}</td><td class="num rate-tot"><b>${pctTxt(r.pct)}</b><i class="rate-bar"><i style="width:${Math.round((r.pct || 0) * 100)}%"></i></i></td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="padding:16px 0">ยังไม่มีผลตรวจเช็คช่องประจำในช่วงนี้</p>';
  box.innerHTML = `<div class="per-bar">
      <div class="seg" role="tablist">${Object.entries(P_MODES).map(([k, v]) => `<button type="button" data-act="per-mode" data-m="${k}" aria-selected="${P.mode === k}">${v}</button>`).join('')}</div>
      <div class="per-nav"><button class="btn ghost sm" data-act="per-nav" data-n="-1" type="button" aria-label="ก่อนหน้า">◀</button><b>${esc(perLabel(P.mode, P.a))}</b><button class="btn ghost sm" data-act="per-nav" data-n="1" type="button" aria-label="ถัดไป">▶</button>${perRange(P.mode, P.a)[0] <= today() && today() <= perRange(P.mode, P.a)[1] ? '' : '<button class="link" data-act="per-now" type="button">กลับมาปัจจุบัน</button>'}</div>
      <div class="per-r"><select id="pZone" aria-label="สถานที่"><option value="">ทุกสถานที่</option>${zs.map(z => `<option value="${esc(z.id)}"${z.id === P.zone ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select>
      <button class="btn pri" data-act="per-xlsx" type="button">ดาวน์โหลด Excel</button></div></div>
    ${kpis}
    <div class="sum-grid">
      ${chartA}${chartB}
      ${hb('รถชั่วคราว ตามสถานที่', D.byZone)}${hb('รถชั่วคราว ตามประเภทผู้จอด', D.byKind)}${hbPct}
      <div class="card wide"><div class="per-th"><h3>ใครมาจอดเท่าไหร่</h3><div class="seg">${[['temp', `รถชั่วคราว (${D.tRows.length})`], ['perm', `ช่องประจำ (${D.pRows.length})`]].map(([k, v]) => `<button type="button" data-act="per-view" data-v="${k}" aria-selected="${P.view === k}">${v}</button>`).join('')}</div></div>
      <div class="table-wrap per-tbl">${P.view === 'perm' ? pTbl : tTbl}</div></div>
    </div>`;
}
function exportPeriodXlsx() {
  const P = perState(), [s, e] = perRange(P.mode, P.a), D = periodData(s, e, P.zone), title = `${P_MODES[P.mode]} ${perLabel(P.mode, P.a)}${P.zone ? ' · ' + zoneName(P.zone) : ''}`;
  const H = a => a.map(v => ({ v, s: 2 }));
  const sum = [[{ v: `สรุปการใช้ที่จอด ${title}`, s: 1 }], [{ v: `ช่วงวันที่ ${dmy(s)} ถึง ${dmy(e)} · สร้างจากแอปที่จอดรถ ${fmtTs(Date.now())}`, s: 9 }], [],
    H(['รายการ', 'จำนวน']), [{ v: 'รถชั่วคราวเข้าจอด (ครั้ง)', s: 3 }, { v: D.tv.length, s: 4 }], [{ v: 'ทะเบียนรถชั่วคราวไม่ซ้ำ (คัน)', s: 3 }, { v: D.plates, s: 4 }],
    [{ v: 'ช่องประจำมาจอด (คน-วัน)', s: 3 }, { v: D.park, s: 4 }], [{ v: 'ช่องประจำที่ตรวจ (ครั้ง)', s: 3 }, { v: D.tot, s: 4 }], [{ v: 'อัตราการมาจอดช่องประจำ', s: 3 }, D.pct == null ? { v: '', s: 4 } : { v: D.pct, s: 6 }],
    [{ v: 'วันที่มีการตรวจเช็ค', s: 3 }, { v: D.ckDays, s: 4 }], [{ v: 'ทะเบียนไม่ตรง (ครั้ง)', s: 3 }, { v: D.wrong, s: 4 }], [],
    H([D.byMonth ? 'เดือน' : 'วันที่', 'รถชั่วคราว (ครั้ง)', 'ช่องประจำมาจอด', 'ช่องประจำที่ตรวจ', '% มาจอด']),
    ...D.trend.map(x => [{ v: D.byMonth ? monLabel(x.b, true) : dmy(x.b), s: 3 }, { v: x.temp, s: 4 }, { v: x.park, s: 4 }, { v: x.tot, s: 4 }, x.tot ? { v: x.park / x.tot, s: 6 } : { v: '', s: 4 }])];
  const tS = [[{ v: `รถชั่วคราว ${title}`, s: 1 }], H(['ลำดับ', 'ชื่อ / บริษัท', 'ทะเบียน', 'ประเภท', 'สถานที่', 'จำนวนวัน', 'มาล่าสุด']),
    ...D.tRows.map((r, i) => [{ v: i + 1, s: 4 }, { v: r.name, s: 3 }, { v: r.plate, s: 3 }, { v: [...r.kinds].join(', '), s: 3 }, { v: [...r.zones].join(', '), s: 3 }, { v: r.n, s: 4 }, { v: dmy(r.last), s: 4 }])];
  const pS = [[{ v: `ช่องประจำ ${title}`, s: 1 }], H(['ลำดับ', 'สถานที่', 'ช่อง', 'ชื่อ-นามสกุล', 'รหัส', 'แผนก', 'ทะเบียน', 'วันที่จอด', 'วันทั้งหมด', '%']),
    ...D.pRows.map((r, i) => { const ri = i + 3; return [{ v: i + 1, s: 4 }, { v: zoneName(r.zone), s: 3 }, { v: r.slot, s: 4 }, { v: r.person.name, s: 3 }, { v: r.person.empId || '', s: 3 }, { v: r.person.dept || '', s: 3 }, { v: r.person.plate || '', s: 3 }, { v: r.park, s: 4 }, { v: r.tot, s: 4 }, { f: `IF(I${ri}>0,H${ri}/I${ri},"")`, v: r.pct == null ? '' : r.pct, s: 6 }]; })];
  const lS = [[{ v: `รายการรถชั่วคราวรายวัน ${title}`, s: 1 }], H(['วันที่', 'เวลา', 'ชื่อ / บริษัท', 'ทะเบียน', 'ประเภท', 'สถานที่', 'ช่อง', 'หมายเหตุ', 'บันทึกโดย']),
    ...D.tv.slice().sort((a, b) => a.d.localeCompare(b.d) || a.t.from.localeCompare(b.t.from)).map(({ t, d }) => [{ v: dmy(d), s: 3 }, { v: `${t.from}–${t.to}`, s: 4 }, { v: t.name, s: 3 }, { v: t.plate, s: 3 }, { v: t.kind || '', s: 3 }, { v: zoneName(t.zone), s: 3 }, { v: t.slot || '', s: 4 }, { v: t.note || '', s: 3 }, { v: t.createdBy || '', s: 3 }])];
  const blob = xBook([{ name: 'สรุป', xml: xSheet(sum, { widths: [30, 18, 16, 16, 12], merges: ['A1:E1', 'A2:E2'] }) },
    { name: 'รถชั่วคราว', xml: xSheet(tS, { widths: [7, 32, 14, 22, 26, 11, 14], merges: ['A1:G1'], freeze: [0, 2] }) },
    { name: 'ช่องประจำ', xml: xSheet(pS, { widths: [7, 20, 7, 26, 12, 20, 14, 10, 11, 9], merges: ['A1:J1'], freeze: [0, 2] }) },
    { name: 'รายการรายวัน', xml: xSheet(lS, { widths: [14, 13, 30, 14, 20, 22, 7, 26, 18], merges: ['A1:I1'], freeze: [0, 2] }) }]);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `สรุปที่จอด-${P_MODES[P.mode]}-${s}${s === e ? '' : '-ถึง-' + e}.xlsx`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  toast('ดาวน์โหลด Excel แล้ว');
}

/* ================= อัตราการมาจอดช่องประจำ (รายเดือน) =================
   นับจากผลตรวจเช็ค: วันที่ช่องนั้นถูกตรวจ = วันทั้งหมด / วันที่ทะเบียนตรงกะใดกะหนึ่ง = วันที่จอด
   ผูกกับคนที่มีสิทธิ์จอดในวันที่ตรวจ (เก็บไว้ในผลตรวจ) เปลี่ยนเจ้าของกลางเดือนก็แยกแถวให้เอง */
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MONL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const monLabel = (ym, long) => { const [y, m] = ym.split('-').map(Number); return long ? `${TH_MONL[m - 1]} ${y + 543}` : `${TH_MON[m - 1]} ${String(y + 543).slice(2)}`; };
const monList = (a, b) => { const out = []; let [y, m] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); while ((y < y2 || (y === y2 && m <= m2)) && out.length < 24) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } } return out; };
const monDays = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const normName = s => String(s || '').replace(/^(คุณ|นาย|นางสาว|นาง|น\.ส\.)\s*/, '').replace(/\s+/g, ' ').trim();
function personOf(exp) {   // หาข้อมูลพนักงานจากผลตรวจ (id ช่องประจำ หรือชื่อ)
  const p = (exp.id && db.permanent.find(x => x.id === exp.id)) || db.permanent.find(x => normName(x.name) === normName(exp.name));
  return { key: p ? p.id : 'n:' + normName(exp.name), name: exp.name, plate: (p && p.plate) || exp.plate, empId: p ? p.empId : '', dept: p ? p.dept : '', division: p ? p.division : '' };
}
/* คืน { zones: [{ z, days:Set(วันที่ที่ลานนี้มีการตรวจ), rows:[{ slot, person, d:{date:1|0} }] }] } ของเดือน ym */
function monthRate(ym, zid) {
  const out = [];
  db.zones.filter(z => !z.free && (!zid || z.id === zid)).forEach(z => {
    const docs = db.checks.filter(c => c.zone === z.id && c.date.slice(0, 7) === ym), days = new Set(), rows = new Map();
    docs.forEach(c => Object.values(c.items || {}).forEach(it => {
      if (!it || !it.r) return; days.add(c.date);
      if (!it.exp) return;
      const per = personOf(it.exp), k = normSlot(it.slot) + '|' + per.key;
      if (!rows.has(k)) rows.set(k, { slot: it.slot, person: per, d: {} });
      const r = rows.get(k), v = it.r === 'ok' ? 1 : 0;
      r.d[c.date] = Math.max(r.d[c.date] ?? 0, v);   // ทะเบียนตรงกะใดกะหนึ่ง = 1
    }));
    const list = [...rows.values()].map(r => { const v = Object.values(r.d); r.park = v.filter(x => x === 1).length; r.tot = v.length; r.pct = r.tot ? r.park / r.tot : null; return r; })
      .sort((a, b) => String(a.slot).localeCompare(String(b.slot), undefined, { numeric: true }) || Object.keys(a.d).sort()[0].localeCompare(Object.keys(b.d).sort()[0]));
    out.push({ z, days, rows: list });
  });
  return out;
}
/* รวมหลายเดือน: แถวละคน (ต่อสถานที่ + ช่อง) พร้อม % รายเดือนและรวม */
function rateMatrix(months, zid) {
  const per = new Map();
  months.forEach(ym => monthRate(ym, zid).forEach(({ z, rows }) => rows.forEach(r => {
    const k = z.id + '|' + normSlot(r.slot) + '|' + r.person.key;
    if (!per.has(k)) per.set(k, { z, slot: r.slot, person: r.person, m: {}, park: 0, tot: 0 });
    const o = per.get(k); o.m[ym] = { park: r.park, tot: r.tot }; o.park += r.park; o.tot += r.tot;
  })));
  return [...per.values()].map(o => ({ ...o, pct: o.tot ? o.park / o.tot : null }))
    .sort((a, b) => zoneName(a.z.id).localeCompare(zoneName(b.z.id)) || String(a.slot).localeCompare(String(b.slot), undefined, { numeric: true }));
}
const pctTxt = v => v == null ? '—' : (Math.round(v * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%';
function rateState() {
  const cur = today().slice(0, 7);
  if (!S.rate) { const prev = monList(addDays(today().slice(0, 8) + '01', -1).slice(0, 7), cur)[0]; S.rate = { from: prev, to: cur, zone: '', th: '', sort: 'slot' }; }
  return S.rate;
}
function renderRate() {
  const R = rateState(), box = $('rateBody'); if (!box) return;
  const zs = db.zones.filter(z => !z.free), months = monList(R.from <= R.to ? R.from : R.to, R.from <= R.to ? R.to : R.from), th = R.th === '' ? null : Math.max(0, Math.min(100, +R.th)) / 100;
  let rows = rateMatrix(months, R.zone);
  if (R.sort === 'pct') rows = rows.slice().sort((a, b) => (a.pct ?? 2) - (b.pct ?? 2));
  const low = th == null ? 0 : rows.filter(r => r.pct != null && r.pct < th).length;
  const cell = (o) => o && o.tot ? `<b>${pctTxt(o.park / o.tot)}</b><small>${o.park}/${o.tot}</small>` : '<span class="muted">—</span>';
  box.innerHTML = `<div class="card wide rate-card">
    <div class="rate-head"><div><h3>อัตราการมาจอดช่องประจำ</h3><p class="muted">วันที่จอด = วันที่ทะเบียนตรงกะใดกะหนึ่ง · วันทั้งหมด = วันที่ช่องนั้นถูกตรวจเช็ค</p></div>
      <div class="rate-ctl">
        <label>สถานที่<select id="rZone"><option value="">ทุกสถานที่</option>${zs.map(z => `<option value="${esc(z.id)}"${z.id === R.zone ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select></label>
        <label>ตั้งแต่เดือน<input id="rFrom" type="month" value="${R.from}" max="${today().slice(0, 7)}"></label>
        <label>ถึงเดือน<input id="rTo" type="month" value="${R.to}" max="${today().slice(0, 7)}"></label>
        <label>ไฮไลต์ต่ำกว่า<span class="rate-th"><input id="rTh" type="number" min="0" max="100" step="5" value="${esc(R.th)}" placeholder="—">%</span></label>
        <label>เรียง<select id="rSort"><option value="slot"${R.sort === 'slot' ? ' selected' : ''}>ตามช่อง</option><option value="pct"${R.sort === 'pct' ? ' selected' : ''}>% น้อยไปมาก</option></select></label>
        <button class="btn pri" data-act="rate-xlsx" type="button">ดาวน์โหลด Excel</button>
      </div></div>
    ${rows.length ? `<p class="rate-note">${rows.length} คน · ${months.length} เดือน${th != null ? ` · <b class="${low ? 'rate-low-t' : ''}">ต่ำกว่า ${Math.round(th * 100)}% : ${low} คน</b>` : ''}</p>
    <div class="table-wrap"><table class="tbl rate-tbl"><thead><tr><th>สถานที่</th><th>ช่อง</th><th>ชื่อ-นามสกุล</th><th>ทะเบียน</th>${months.map(m => `<th class="num">${monLabel(m)}</th>`).join('')}<th class="num">รวม</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="${th != null && r.pct != null && r.pct < th ? 'rate-low' : ''}"><td>${esc(r.z.name)}</td><td class="nw"><b>${esc(r.slot)}</b></td><td>${esc(r.person.name)}${r.person.dept ? `<div class="sub">${esc(r.person.dept)}</div>` : ''}</td><td class="nw">${esc(r.person.plate)}</td>
      ${months.map(m => `<td class="num">${cell(r.m[m])}</td>`).join('')}<td class="num rate-tot">${cell(r)}<i class="rate-bar"><i style="width:${r.pct == null ? 0 : Math.round(r.pct * 100)}%"></i></i></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted" style="padding:18px 0">ยังไม่มีผลตรวจเช็คในช่วงเดือนนี้</p>'}</div>`;
  thaiDates(box);
}
function rateBind() {
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'pZone') { perState().zone = t.value; setTimeout(renderPeriod, 0); return; }
    const R = S.rate; if (!R || !t.id || !/^r(Zone|From|To|Th|Sort)$/.test(t.id)) return;
    const v = t.value;
    if (t.id === 'rZone') R.zone = v; if (t.id === 'rSort') R.sort = v; if (t.id === 'rTh') R.th = v === '' ? '' : String(Math.max(0, Math.min(100, +v || 0)));
    if (t.id === 'rFrom' && /^\d{4}-\d{2}$/.test(v)) R.from = v; if (t.id === 'rTo' && /^\d{4}-\d{2}$/.test(v)) R.to = v;
    setTimeout(renderRate, 0);
  });
}

/* ---------- เขียนไฟล์ .xlsx เอง (มีสี เส้นตาราง สูตร) ไม่ต้องโหลดไลบรารีจากเน็ต ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {   // ZIP แบบไม่บีบอัด (Excel เปิดได้ปกติ)
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  files.forEach(([name, text]) => {
    const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const head = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)];
    parts.push(new Uint8Array(head), nb, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb);
    off += head.length + nb.length + data.length;
  });
  const cSize = central.reduce((s, p) => s + p.length, 0);
  return new Blob([...parts, ...central, new Uint8Array([...u32(0x06054b50), 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cSize), ...u32(off), 0, 0])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colL = n => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };
/* style ids: 0 ปกติ 1 หัวเรื่อง 2 หัวตาราง 3 ข้อความ 4 ตัวเลขกลาง 5 วันที่ไม่ได้ตรวจ(เทา) 6 % 7 % ต่ำกว่าเกณฑ์ 8 ข้อความต่ำกว่าเกณฑ์ 9 คำอธิบาย 10 หัววันเสาร์อาทิตย์ */
const XSTYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5"><font><sz val="10"/><name val="Tahoma"/></font><font><b/><sz val="14"/><name val="Tahoma"/></font><font><b/><sz val="10"/><name val="Tahoma"/></font><font><b/><sz val="10"/><color rgb="FFC00000"/><name val="Tahoma"/></font><font><i/><sz val="9"/><color rgb="FF595959"/><name val="Tahoma"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE4E4"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right><top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="thin"><color rgb="FFA6A6A6"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="11">
<xf/>
<xf fontId="1" applyFont="1"/>
<xf fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf borderId="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="10" fontId="2" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="10" fontId="3" fillId="4" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf fillId="4" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf fontId="4" applyFont="1"/>
<xf fontId="2" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs></styleSheet>`;
function xSheet(rows, opt = {}) {   // rows: [[cell...]] cell = {v, s, f} หรือค่า
  const cols = (opt.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((r, ri) => `<row r="${ri + 1}"${opt.heights && opt.heights[ri] ? ` ht="${opt.heights[ri]}" customHeight="1"` : ''}>${r.map((c, ci) => {
    if (c == null) return ''; const o = typeof c === 'object' ? c : { v: c }, ref = colL(ci) + (ri + 1), s = o.s ? ` s="${o.s}"` : '';
    if (o.f) return `<c r="${ref}"${s}${typeof o.v === 'string' ? ' t="str"' : ''}><f>${xEsc(o.f)}</f>${o.v != null && o.v !== '' ? `<v>${xEsc(o.v)}</v>` : ''}</c>`;
    if (o.v == null || o.v === '') return s ? `<c r="${ref}"${s}/>` : '';
    return typeof o.v === 'number' ? `<c r="${ref}"${s}><v>${o.v}</v></c>` : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xEsc(o.v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const merges = (opt.merges || []).length ? `<mergeCells count="${opt.merges.length}">${opt.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const pane = opt.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${opt.freeze[0]}" ySplit="${opt.freeze[1]}" topLeftCell="${colL(opt.freeze[0])}${opt.freeze[1] + 1}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${pane}<sheetFormatPr defaultRowHeight="18"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${body}</sheetData>${merges}<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}
function xBook(sheets) {   // sheets: [{name, xml}]
  const safe = n => n.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xEsc(safe(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', XSTYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml])
  ];
  return zipStore(files);
}
/* แผ่นรายเดือนต่อสถานที่ หน้าตาเหมือนไฟล์เดิม: ลำดับ รหัส ชื่อ นามสกุล แผนก ฝ่าย ทะเบียน ช่อง หมายเหตุ | 1..31 | วันที่จอด วันทั้งหมด % */
function monthSheet(ym, z, rows, days, th) {
  const nd = monDays(ym), D0 = 9, cP = D0 + 31, cT = cP + 1, cR = cT + 1, last = colL(cR);
  const head = ['ลำดับที่', 'รหัส', 'ชื่อ', 'นามสกุล', 'แผนก', 'ฝ่าย', 'ทะเบียนรถ', 'หมายเลขช่องจอด', 'หมายเหตุ'];
  const dow = d => new Date(`${ym}-${String(d).padStart(2, '0')}T00:00:00Z`).getUTCDay();
  const out = [[{ v: `ข้อมูลที่จอดรถยนต์ ${z.name} ประจำเดือน ${monLabel(ym, true)}`, s: 1 }], [{ v: 'สร้างจากผลตรวจเช็คในแอปที่จอดรถ · 1 = ทะเบียนตรงกะใดกะหนึ่ง · 0 = ตรวจแล้วไม่พบรถ/ทะเบียนไม่ตรง · ช่องว่าง = วันนั้นไม่ได้ตรวจช่องนี้ · คอลัมน์สีเทา = วันที่ไม่มีการตรวจลานนี้ · สีเหลือง = เสาร์-อาทิตย์', s: 9 }]];
  const hr = head.map(v => ({ v, s: 2 }));
  for (let d = 1; d <= 31; d++) { const date = `${ym}-${String(d).padStart(2, '0')}`; hr.push(d > nd ? { v: '', s: 5 } : { v: d, s: days.has(date) ? ([0, 6].includes(dow(d)) ? 10 : 2) : 5 }); }
  hr.push({ v: 'วันที่จอด', s: 2 }, { v: 'วันทั้งหมด', s: 2 }, { v: '%', s: 2 }); out.push(hr);
  rows.forEach((r, i) => {
    const ri = out.length + 1, nm = normName(r.person.name).split(' '), low = th != null && r.pct != null && r.pct < th, ts = low ? 8 : 3;
    const row = [{ v: i + 1, s: 4 }, { v: r.person.empId || '', s: ts }, { v: nm[0] || '', s: ts }, { v: nm.slice(1).join(' '), s: ts }, { v: r.person.dept || '', s: ts }, { v: r.person.division || '', s: ts }, { v: r.person.plate || '', s: ts }, { v: `ช่อง ${r.slot}`, s: ts }, { v: '', s: ts }];
    for (let d = 1; d <= 31; d++) { const date = `${ym}-${String(d).padStart(2, '0')}`, v = r.d[date]; row.push(d > nd || !days.has(date) ? { v: v ?? '', s: 5 } : { v: v ?? '', s: 4 }); }
    row.push({ f: `SUM(${colL(D0)}${ri}:${colL(D0 + 30)}${ri})`, v: r.park, s: 4 }, { f: `COUNT(${colL(D0)}${ri}:${colL(D0 + 30)}${ri})`, v: r.tot, s: 4 }, { f: `IF(${colL(cT)}${ri}>0,${colL(cP)}${ri}/${colL(cT)}${ri},"")`, v: r.pct == null ? '' : r.pct, s: low ? 7 : 6 });
    out.push(row);
  });
  if (!rows.length) out.push([{ v: 'ยังไม่มีผลตรวจเช็คของเดือนนี้', s: 9 }]);
  out.push([], [{ v: `วันที่มีการตรวจลานนี้ ${days.size} วัน${th != null ? ` · เกณฑ์ ${Math.round(th * 100)}% (แถวสีชมพู = ต่ำกว่าเกณฑ์)` : ''}`, s: 9 }]);
  return xSheet(out, { widths: [7, 13, 13, 15, 22, 16, 18, 13, 10, ...Array(31).fill(3.6), 9, 10, 9], merges: [`A1:${last}1`, `A2:${last}2`], freeze: [9, 3], heights: { 2: 30 } });
}
function exportRateXlsx() {
  const R = rateState(), months = monList(R.from <= R.to ? R.from : R.to, R.from <= R.to ? R.to : R.from), th = R.th === '' ? null : +R.th / 100;
  const sheets = [], mat = rateMatrix(months, R.zone);
  // แผ่นสรุปหลายเดือน
  const sh = [[{ v: `สรุปอัตราการมาจอดช่องประจำ ${monLabel(months[0], true)}${months.length > 1 ? ' ถึง ' + monLabel(months[months.length - 1], true) : ''}`, s: 1 }],
    [{ v: 'แต่ละเดือนแสดง % (วันที่จอด/วันทั้งหมด) · รวม = รวมทุกเดือนที่เลือก', s: 9 }],
    ['ลำดับ', 'สถานที่', 'ช่อง', 'ชื่อ-นามสกุล', 'รหัส', 'แผนก', 'ทะเบียน', ...months.map(m => monLabel(m)), 'วันที่จอด', 'วันทั้งหมด', '% รวม'].map(v => ({ v, s: 2 }))];
  mat.forEach((r, i) => {
    const low = th != null && r.pct != null && r.pct < th, ts = low ? 8 : 3, ri = sh.length + 1, c0 = 7 + months.length;
    sh.push([{ v: i + 1, s: 4 }, { v: r.z.name, s: ts }, { v: r.slot, s: 4 }, { v: r.person.name, s: ts }, { v: r.person.empId || '', s: ts }, { v: r.person.dept || '', s: ts }, { v: r.person.plate || '', s: ts },
      ...months.map(m => { const o = r.m[m]; return o && o.tot ? { v: o.park / o.tot, s: th != null && o.park / o.tot < th ? 7 : 6 } : { v: '', s: 5 }; }),
      { v: r.park, s: 4 }, { v: r.tot, s: 4 }, { f: `IF(${colL(c0 + 1)}${ri}>0,${colL(c0)}${ri}/${colL(c0 + 1)}${ri},"")`, v: r.pct == null ? '' : r.pct, s: low ? 7 : 6 }]);
  });
  if (!mat.length) sh.push([{ v: 'ยังไม่มีผลตรวจเช็คในช่วงนี้', s: 9 }]);
  if (th != null) sh.push([], [{ v: `เกณฑ์ ${Math.round(th * 100)}% · ต่ำกว่าเกณฑ์ ${mat.filter(r => r.pct != null && r.pct < th).length} คน (แถวสีชมพู)`, s: 9 }]);
  const lastS = colL(9 + months.length);
  sheets.push({ name: 'สรุปหลายเดือน', xml: xSheet(sh, { widths: [6, 18, 7, 26, 13, 22, 16, ...months.map(() => 10), 10, 10, 10], merges: [`A1:${lastS}1`, `A2:${lastS}2`], freeze: [4, 3] }) });
  months.forEach(ym => monthRate(ym, R.zone).forEach(({ z, rows, days }) => sheets.push({ name: `${z.name.replace(/\s*\(.*\)/, '').slice(0, 20)} ${monLabel(ym)}`, xml: monthSheet(ym, z, rows, days, th) })));
  const fn = `อัตราการจอด-${months[0]}${months.length > 1 ? '-ถึง-' + months[months.length - 1] : ''}.xlsx`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(xBook(sheets)); a.download = fn; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  toast('ดาวน์โหลด Excel แล้ว');
}

/* ---------- ข้อมูล ---------- */
function renderData() {
  document.querySelectorAll('[data-dtab]').forEach(b => b.setAttribute('aria-selected', b.dataset.dtab === S.dtab));
  const perm = S.dtab === 'perm', chk = S.dtab === 'chk';
  const zlist = perm ? db.zones.filter(isPermZone) : chk ? db.zones.filter(z => !z.free) : db.zones, zv = $('dZone').value;
  $('dZone').innerHTML = '<option value="">ทุกสถานที่</option>' + zlist.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join(''); $('dZone').value = zlist.some(z => z.id === zv) ? zv : '';
  const sv = $('dStatus').value, sopts = chk ? [['', 'ทุกวัน'], ['issue', 'มีรายการผิดปกติ']] : perm ? [['', 'ทุกสถานะ'], ['on', 'ใช้งานอยู่'], ['off', 'คืนช่องแล้ว']] : [['', 'ทุกสถานะ'], ['live', 'ยังใช้งาน'], ['now', 'กำลังจอด'], ['upcoming', 'จองล่วงหน้า'], ['expired', 'สิ้นสุดแล้ว'], ['cancelled', 'ยกเลิก']];
  $('dStatus').innerHTML = sopts.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); $('dStatus').value = sopts.some(o => o[0] === sv) ? sv : '';
  $('dNew').textContent = chk ? '+ เริ่มตรวจวันนี้' : perm ? '+ ลงทะเบียนช่องประจำ' : '+ บันทึกการจอง'; $('dImport').hidden = !perm;
  const q = $('dQ').value.trim().toLowerCase(), fz = $('dZone').value, fs_ = $('dStatus').value;
  if (chk) {
    const rows = dataRowsChk(q, fz, fs_);
    $('dCount').textContent = `${rows.length} วันที่ตรวจ`;
    $('dTable').innerHTML = `<thead><tr><th>วันที่</th><th>สถานที่</th><th>ตรวจแล้ว</th><th>ไม่มีรถ</th><th>ทะเบียนไม่ตรง / รถอื่น</th><th>ผู้ตรวจ</th><th></th></tr></thead><tbody>` +
      (rows.map(({ c, n, tot, none, wrong, who }) => `<tr><td class="nw">${fmtDate(c.date)}<div class="sub">${SHIFTS[ckShiftOf(c)].name}</div></td><td>${esc(zoneName(c.zone))}</td><td class="nw">${n}/${tot}</td><td>${none ? `<b>${none}</b>` : 0}</td><td>${wrong ? `<b style="color:var(--stop)">${wrong}</b>` : 0}</td><td class="sub">${esc(who)}<br>${fmtTs(c.updatedAt)}</td>
        <td class="keep nw"><button class="link" data-act="ck-open" data-id="${esc(c.id)}">เปิด</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:28px">ยังไม่มีการตรวจเช็ค</td></tr>') + '</tbody>';
    return;
  }
  if (perm) {
    const rows = dataRowsPerm(q, fz, fs_);
    $('dCount').textContent = `${rows.length} รายการ`;
    $('dTable').innerHTML = `<thead><tr><th>ชื่อ-นามสกุล</th><th>รหัส</th><th>ทะเบียน</th><th>แผนก / ฝ่าย</th><th>สถานที่</th><th>ช่อง</th><th>สถานะ</th><th>แก้ไขล่าสุด</th><th></th></tr></thead><tbody>` +
      (rows.map(p => `<tr class="${p.active ? '' : 'off'}"><td><b>${esc(p.name)}</b></td><td class="nw">${esc(p.empId)}</td><td class="nw">${esc(p.plate)}</td><td>${esc(p.dept)}<div class="sub">${esc(p.division)}</div></td><td>${esc(zoneName(p.zone))}</td><td class="nw"><b>${esc(p.slot)}</b></td>
        <td class="keep"><span class="status ${p.active ? 'st-perm' : 'st-expired'}">${p.active ? 'ใช้งานอยู่' : 'คืนช่องแล้ว'}</span></td><td class="keep nw sub">${fmtTs(p.updatedAt)}<br>${esc(p.updatedBy || '')}</td>
        <td class="keep nw"><button class="link" data-act="goto-perm" data-id="${esc(p.id)}">ดูในผัง</button><button class="link" data-act="edit-perm" data-id="${esc(p.id)}">แก้ไข</button><button class="link" data-act="toggle-perm" data-id="${esc(p.id)}">${p.active ? 'คืนช่อง' : 'ใช้งานอีกครั้ง'}</button><button class="link" data-act="hist" data-kind="perm" data-id="${esc(p.id)}">ประวัติ</button><button class="link danger" data-act="del-perm" data-id="${esc(p.id)}">ลบ</button></td></tr>`).join('')
        || '<tr><td colspan="9" class="muted" style="text-align:center;padding:28px">ยังไม่มีข้อมูล ลงทะเบียนหรือนำเข้าไฟล์ Excel</td></tr>') + '</tbody>';
  } else {
    const rows = dataRowsTemp(q, fz, fs_);
    $('dCount').textContent = `${rows.length} รายการ`;
    $('dTable').innerHTML = `<thead><tr><th>วันที่</th><th>เวลา</th><th>ชื่อ / บริษัท</th><th>ทะเบียน</th><th>สถานที่</th><th>ช่อง</th><th>สถานะ</th><th>บันทึกโดย</th><th></th></tr></thead><tbody>` +
      (rows.slice(0, 500).map(t => { const st = tStatus(t); return `<tr class="${st === 'expired' ? 'off' : ''}"><td class="nw">${fmtDate(t.date)}${isMulti(t) ? `<div class="sub">ถึง ${fmtDate(dEnd(t))} (${dayCount(t)} วัน)</div>` : ''}</td><td class="nw">${esc(t.from)}–${esc(t.to)}</td><td><b>${esc(t.name)}</b><div class="sub">${esc(t.kind || '')}${t.note ? ' / ' + esc(t.note) : ''}</div></td><td class="nw">${esc(t.plate)}</td><td>${esc(zoneName(t.zone))}</td><td class="nw">${esc(t.slot || '—')}</td>
        <td class="keep"><span class="status st-${st}">${ST_TXT[st]}</span></td><td class="keep sub">${esc(t.createdBy || '—')}<br>${fmtTs(t.createdAt)}</td>
        <td class="keep nw"><button class="link" data-act="goto-temp" data-id="${esc(t.id)}">ดูในผัง</button><button class="link" data-act="edit-temp" data-id="${esc(t.id)}">แก้ไข</button>${isLive(t) ? `<button class="link" data-act="cancel-temp" data-id="${esc(t.id)}">ยกเลิก</button>` : ''}<button class="link" data-act="hist" data-kind="temp" data-id="${esc(t.id)}">ประวัติ</button><button class="link danger" data-act="del-temp" data-id="${esc(t.id)}">ลบ</button></td></tr>`; }).join('')
        || '<tr><td colspan="9" class="muted" style="text-align:center;padding:28px">ไม่มีรายการตามตัวกรองนี้</td></tr>') + (rows.length > 500 ? `<tr><td colspan="9" class="muted">แสดง 500 จาก ${rows.length} รายการ ใช้ตัวกรองหรือส่งออก CSV เพื่อดูทั้งหมด</td></tr>` : '') + '</tbody>';
  }
}
function dataRowsChk(q, fz, f) {
  return db.checks.filter(c => (!fz || c.zone === fz) && (!f || f === 'issue')).map(c => {
    const its = Object.values(c.items || {}).filter(i => i && i.r), z = getZone(c.zone);
    const none = its.filter(i => i.r === 'none' && i.exp).length, wrong = its.filter(i => i.r === 'wrong').length;
    const who = [...new Set(its.map(i => i.by).filter(Boolean))].join(', ');
    return { c, n: its.length, tot: z ? z.slots.length : its.length, none, wrong, who, text: (who + ' ' + its.map(i => [i.slot, i.seen, i.note, i.exp && i.exp.name, i.exp && i.exp.plate].join(' ')).join(' ')).toLowerCase() };
  }).filter(r => (f !== 'issue' || r.none + r.wrong > 0) && (!q || r.text.includes(q))).sort((a, b) => b.c.date.localeCompare(a.c.date) || ckShiftOf(b.c).localeCompare(ckShiftOf(a.c)) || zoneName(a.c.zone).localeCompare(zoneName(b.c.zone)));
}
function dataRowsPerm(q, fz, f) {
  return db.permanent.filter(p => (!fz || p.zone === fz) && (!f || (f === 'on') === !!p.active) && (!q || [p.name, p.empId, p.plate, p.slot, p.dept, p.division].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => zoneName(a.zone).localeCompare(zoneName(b.zone)) || String(a.slot).localeCompare(String(b.slot), undefined, { numeric: true }));
}
function dataRowsTemp(q, fz, f) {
  return db.temp.filter(t => { const st = tStatus(t); return (!fz || t.zone === fz) && (!f || (f === 'live' ? isLive(t) : f === 'upcoming' ? st === 'upcoming' || st === 'today' : st === f)) && (!q || [t.name, t.plate, t.note, t.kind, t.createdBy].join(' ').toLowerCase().includes(q)); })
    .sort((a, b) => (b.date + b.from).localeCompare(a.date + a.from));
}

/* ---------- CSV / Excel ---------- */
const csvCell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };   // กันสูตร Excel แฝง
const toCSV = lines => '﻿' + lines.map(r => r.map(csvCell).join(',')).join('\r\n');
function download(name, content, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function exportData() {
  const q = $('dQ').value.trim().toLowerCase(), fz = $('dZone').value, f = $('dStatus').value;
  if (S.dtab === 'chk') {
    const rows = [['วันที่', 'กะ', 'สถานที่', 'ช่อง', 'ผู้มีสิทธิ์จอด', 'ทะเบียนที่ลงไว้', 'ผลตรวจ', 'ทะเบียนที่พบ', 'หมายเหตุ', 'ผู้ตรวจ', 'บัญชีที่ใช้', 'เวลา']];
    dataRowsChk(q, fz, f).forEach(({ c }) => sortSlots(Object.values(c.items || {}).filter(i => i && i.r).map(i => i.slot)).forEach(sl => { const it = c.items[ckKey(sl)]; rows.push([dmy(c.date), SHIFTS[ckShiftOf(c)].name, zoneName(c.zone), sl, it.exp ? it.exp.name : '', it.exp ? it.exp.plate : '', ckLabel(it.r, !!it.exp), it.seen || '', it.note || '', it.by || '', it.acct || '', fmtTs(it.at)]); }));
    return download(`ประวัติตรวจเช็ค-${today()}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
  }
  if (S.dtab === 'perm') download(`ช่องประจำ-${today()}.csv`, toCSV([['ชื่อ-นามสกุล', 'รหัสพนักงาน', 'ทะเบียนรถ', 'แผนก', 'ฝ่าย', 'สถานที่', 'หมายเลขช่อง', 'สถานะ', 'แก้ไขล่าสุด', 'แก้ไขโดย']]
    .concat(dataRowsPerm(q, fz, f).map(p => [p.name, p.empId, p.plate, p.dept, p.division, zoneName(p.zone), p.slot, p.active ? 'ใช้งานอยู่' : 'คืนช่องแล้ว', fmtTs(p.updatedAt), p.updatedBy || '']))), 'text/csv;charset=utf-8');
  else download(`จองชั่วคราว-${today()}.csv`, toCSV([['วันที่เริ่ม', 'ถึงวันที่', 'เวลาเข้า', 'เวลาออก', 'ชื่อ/บริษัท', 'ทะเบียนรถ', 'สถานที่', 'ช่อง', 'ประเภท', 'หมายเหตุ', 'สถานะ', 'บันทึกโดย', 'บันทึกเมื่อ']]
    .concat(dataRowsTemp(q, fz, f).map(t => [dmy(t.date), dmy(dEnd(t)), t.from, t.to, t.name, t.plate, zoneName(t.zone), t.slot, t.kind, t.note, ST_TXT[tStatus(t)], t.createdBy || '', fmtTs(t.createdAt)]))), 'text/csv;charset=utf-8');
}
function exportSum() {
  const R = +$('sRange').value || 30, d0 = addDays(today(), -(R - 1)), tl = rangeTemps(R), rows = [['วันที่', 'สถานที่', 'ประเภทผู้จอด', 'จำนวนคำขอ']], m = new Map();
  tl.forEach(t => daysOf(t, d0).filter(d => d <= today()).forEach(d => { const k = [d, zoneName(t.zone), t.kind || ''].join('\u0001'); m.set(k, (m.get(k) || 0) + 1); }));
  [...m.entries()].sort().forEach(([k, v]) => { const a = k.split('\u0001'); a[0] = dmy(a[0]); rows.push([...a, v]); });
  download(`สรุปที่จอด-${d0}-ถึง-${today()}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
}
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false; text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim())) rows.push(row); return rows;
}
let xlsxP = null;
function loadXLSX() {   // โหลดเมื่อจำเป็นเท่านั้น และใช้รุ่นที่แก้ช่องโหว่แล้ว (0.20.3)
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return xlsxP = xlsxP || new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'; s.onload = () => res(window.XLSX); s.onerror = () => { xlsxP = null; rej(new Error('load')); }; document.head.appendChild(s); });
}
const FIELD_RE = [['plate', /ทะเบียน|plate/i], ['emp', /รหัส|emp/i], ['dept', /แผนก|dept/i], ['div', /ฝ่าย|div/i], ['zone', /สถานที่|โซน|zone|location/i], ['slot', /ช่อง|slot|หมายเลข/i], ['name', /ชื่อ|name/i]];
function mapHeader(row) { const map = {}; row.forEach((h, i) => { const t = String(h ?? '').trim(); if (!t) return; for (const [f, re] of FIELD_RE) if (map[f] == null && re.test(t)) { map[f] = i; break; } }); return map; }
function importRows(sheets) {
  const st = { ops: [], added: 0, updated: 0, newSlots: 0, skipped: [], sheets: [] };
  const perms = db.permanent.map(p => ({ ...p })), zones = new Map(db.zones.map(z => [z.id, { ...z, slots: [...z.slots] }])), changedZ = new Set();
  const wZone = txt => { const t = String(txt || '').trim().toLowerCase(); if (!t) return null; const zs = [...zones.values()]; return zs.find(z => z.name.toLowerCase() === t) || zs.find(z => t.includes(z.name.toLowerCase()) || z.name.toLowerCase().includes(t)) || null; };
  sheets.forEach(sh => {
    let hi = -1, map = null;
    for (let i = 0; i < Math.min(sh.rows.length, 15); i++) { const m = mapHeader(sh.rows[i] || []); if (m.name != null && m.plate != null && Object.keys(m).length >= 3) { hi = i; map = m; break; } }
    if (hi < 0) { st.sheets.push(`${sh.name}: ไม่พบแถวหัวตาราง (ต้องมีอย่างน้อย ชื่อ และ ทะเบียน)`); return; }
    let cnt = 0;
    for (let i = hi + 1; i < sh.rows.length; i++) {
      const r = sh.rows[i] || [], g = f => map[f] != null ? String(r[map[f]] ?? '').trim() : '';
      const name = g('name'), plate = g('plate'), emp = g('emp'), slot = g('slot'); if (!name && !plate && !slot) continue;
      const where = `${sh.name} แถว ${i + 1}`, z = (map.zone != null ? wZone(g('zone')) : null) || wZone(sh.name);
      if (!name || !plate) { st.skipped.push(`${where}: ไม่มีชื่อหรือทะเบียน`); continue; }
      if (!z) { st.skipped.push(`${where}: ไม่พบสถานที่ (${g('zone') || sh.name})`); continue; }
      if (!isPermZone(z)) { st.skipped.push(`${where}: ${z.name} ไม่รับช่องประจำ`); continue; }
      if (!slot) { st.skipped.push(`${where}: ไม่มีหมายเลขช่อง`); continue; }
      const ex = perms.find(p => emp ? normSlot(p.empId) === normSlot(emp) : normPlate(p.plate) === normPlate(plate));
      const clash = perms.find(p => p !== ex && p.active && p.zone === z.id && normSlot(p.slot) === normSlot(slot));
      if (clash) { st.skipped.push(`${where}: ช่อง ${slot} เป็นของ ${clash.name}`); continue; }
      if (!z.slots.some(x => normSlot(x) === normSlot(slot))) { z.slots.push(slot); st.newSlots++; changedZ.add(z.id); }
      const rec = { ...(ex || {}), id: ex ? ex.id : uid(), name, empId: emp, plate: fmtPlates(plate), dept: g('dept'), division: g('div'), zone: z.id, slot, active: ex ? ex.active : true };
      if (ex) { touch(rec, 'อัปเดตจากไฟล์นำเข้า'); perms[perms.indexOf(ex)] = rec; st.updated++; } else { stamp(rec, 'นำเข้าจากไฟล์'); perms.push(rec); st.added++; }
      st.ops.push({ kind: 'perm', rec }); cnt++;
    }
    st.sheets.push(`${sh.name}: อ่านได้ ${cnt} รายการ`);
  });
  changedZ.forEach(id => { const z = zones.get(id); z.capacity = z.slots.length; touch(z, 'เพิ่มหมายเลขช่องจากไฟล์นำเข้า'); st.ops.push({ kind: 'zone', rec: z }); });
  const seen = new Map(); st.ops.forEach(o => seen.set(o.rec.id, o)); st.ops = [...seen.values()];
  return st;
}
async function importFile(f) {
  try {
    let sheets; const ext = f.name.toLowerCase().split('.').pop();
    if (ext === 'csv') sheets = [{ name: f.name.replace(/\.csv$/i, ''), rows: parseCSV(await f.text()) }];
    else {
      let X; try { X = await loadXLSX(); } catch (e) { return info('อ่านไฟล์ Excel ไม่ได้', 'โหลดตัวอ่าน Excel ไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองใหม่ หรือบันทึกเป็น CSV UTF-8 แล้วนำเข้าแทน'); }
      const wb = X.read(await f.arrayBuffer(), { type: 'array' });
      sheets = wb.SheetNames.map(n => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) }));
    }
    const st = importRows(sheets);
    const skip = st.skipped.length ? `<p style="margin-top:10px"><b>ข้าม ${st.skipped.length} แถว</b></p><ul class="muted" style="max-height:160px;overflow:auto">${st.skipped.slice(0, 40).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    const body = `<ul class="muted">${st.sheets.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p style="margin-top:10px">เพิ่มใหม่ <b>${st.added}</b> อัปเดต <b>${st.updated}</b>${st.newSlots ? ` เพิ่มหมายเลขช่องใหม่ <b>${st.newSlots}</b>` : ''}</p>${skip}`;
    if (!st.added && !st.updated) return openDialog({ title: 'ไม่มีข้อมูลที่นำเข้าได้', body, buttons: [{ label: 'ปิด', value: true, cls: 'pri' }] });
    if (!await openDialog({ title: 'ตรวจสอบก่อนนำเข้า', body, buttons: [{ label: 'ยกเลิก', value: false }, { label: 'นำเข้าข้อมูล', value: true, cls: 'pri' }] })) return;
    await writeOps(st.ops); await rebuildLocks().catch(console.error);
    toast(`นำเข้าแล้ว เพิ่ม ${st.added} อัปเดต ${st.updated}`);
  } catch (err) { console.error(err); toast('อ่านไฟล์ไม่สำเร็จ ตรวจว่าเป็นไฟล์ .xlsx หรือ .csv'); }
}

/* ---------- ตั้งค่า ---------- */
function renderSet() {
  if (document.activeElement && $('setBody').contains(document.activeElement) && document.activeElement.matches('input')) return;   // ไม่ทับช่องที่กำลังพิมพ์
  const role = roleOf(user.email) || (isAdmin ? 'admin' : 'member');
  const me = `<div class="card"><h3>บัญชีของฉัน</h3><div class="me"><span class="mark sm">P</span><div><b>${esc(by())}</b><div class="muted">ชื่อผู้ใช้ ${esc(shortId(user.email))} <span class="pill">${ROLE_TXT[role]}</span></div></div></div>
    <form id="pwForm" class="grid2" style="margin-top:14px" autocomplete="off"><label class="f span2"><span>รหัสผ่านปัจจุบัน</span><input name="cur" type="password" autocomplete="current-password" required></label>
    <label class="f"><span>รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)</span><input name="nw" type="password" minlength="8" autocomplete="new-password" required></label><label class="f"><span>ยืนยันรหัสผ่านใหม่</span><input name="nw2" type="password" minlength="8" autocomplete="new-password" required></label>
    <div class="span2 row-gap"><button class="btn sm" type="submit">เปลี่ยนรหัสผ่าน</button></div></form>
    <div class="row-gap" style="margin-top:14px">${fs ? '<button class="btn ghost" data-act="signout">ออกจากระบบ</button>' : '<button class="btn ghost" data-act="demo-reset">ล้างข้อมูลสาธิต</button>'}</div></div>`;
  if (isGuard) { $('setBody').innerHTML = `<div class="page-head"><h2>ตั้งค่า</h2></div><div class="set-grid">${me}</div>`; return; }
  const dis = isAdmin ? '' : 'disabled', tagTxt = (z, t) => slotsText(z.slots.filter(x => tagOf(z, x) === t));
  const zones = `<div class="card wide"><h3>สถานที่และผังช่องจอด</h3><p class="muted">หมายเลขช่องเขียนได้ เช่น 1-45 หรือ 1-10, 15, A1-A8 ช่อง VIP รับเฉพาะรถลูกค้า VIP แบบจองตามเวลา ช่องผู้บริหารเป็นช่องประจำ สถานที่ที่จอดอิสระรับรถชั่วคราวทั่วไป${isAdmin ? '' : ' (แก้ไขได้เฉพาะผู้ดูแลระบบ)'}</p>
    ${db.zones.map((z, i) => `<div class="zedit" data-zone="${esc(z.id)}"><div class="zf">
      <label>ชื่อสถานที่<input data-f="name" value="${esc(z.name)}" maxlength="60" ${isAdmin ? '' : 'disabled'}></label>
      ${z.free ? `<label>ความจุ (คัน) จอดอิสระ ไม่มีเลขช่อง<input data-f="cap" type="number" min="0" max="9999" value="${z.capacity}" ${isAdmin ? '' : 'disabled'}></label>` : `<label>หมายเลขช่อง<input data-f="slots" value="${esc(slotsText(z.slots))}" ${isAdmin ? '' : 'disabled'}></label>`}
      ${validLayout(z) ? `<label>ผัง<input value="ตามแบบฟอร์มตรวจเช็ค" disabled></label>` : `<label>ช่องต่อแถว<input data-f="per" type="number" min="2" max="40" value="${z.perRow}" ${dis}></label>`}</div>
      <div class="zf" style="margin-top:8px">${z.free ? '' : `<label>ช่องลูกค้า VIP<input data-f="vip" value="${esc(tagTxt(z, 'vip'))}" placeholder="เช่น 1-4" ${dis}></label><label>ช่องผู้บริหาร<input data-f="exec" value="${esc(tagTxt(z, 'exec'))}" placeholder="เช่น 5-6" ${dis}></label>`}
      <label>คำอธิบายตำแหน่ง<input data-f="note" value="${esc(z.note || '')}" maxlength="80" placeholder="เช่น หลังอาคาร Pilot Plant" ${dis}></label>
      <label>ลิงก์ Google Maps<input data-f="map" value="${esc(z.mapUrl || '')}" placeholder="https://maps.app.goo.gl/..." ${dis}></label></div>
      <div class="zfoot"><span>${capOf(z)} ${z.free ? 'คัน จอดอิสระ รับรถชั่วคราว' : 'ช่อง'}${isPermZone(z) ? ' รับช่องประจำ' : ''} แก้ไขล่าสุด ${fmtTs(z.updatedAt)}</span>
      ${isAdmin && presetKey(z) ? `<button class="btn sm ${validLayout(z) ? 'ghost' : 'pri'}" data-act="apply-preset" data-id="${esc(z.id)}">${validLayout(z) ? 'ตั้งผังตามแบบฟอร์มใหม่' : 'ใช้ผังจริงตามแบบฟอร์มตรวจเช็ค'}</button>` : ''}
      ${isAdmin ? `<span class="row-gap"><button class="btn ghost sm" data-act="zone-up" data-id="${esc(z.id)}" ${i ? '' : 'disabled'} aria-label="เลื่อนขึ้น">▲</button><button class="btn ghost sm" data-act="hist" data-kind="zone" data-id="${esc(z.id)}">ประวัติ</button><button class="btn sm" data-act="save-zone" data-id="${esc(z.id)}">บันทึก</button><button class="btn ghost sm" data-act="del-zone" data-id="${esc(z.id)}" style="color:var(--stop)">ลบ</button></span>` : ''}</div></div>`).join('')}
    ${isAdmin ? `<form id="zoneAdd" class="zedit"><div class="zf"><label>ชื่อสถานที่ใหม่<input name="name" maxlength="60" required></label><label>หมายเลขช่อง (เว้นว่าง = จอดอิสระ)<input name="slots" placeholder="1-10"></label><label>ความจุถ้าจอดอิสระ<input name="cap" type="number" min="1" value="10"></label></div><div class="zfoot"><span></span><button class="btn pri sm">เพิ่มสถานที่</button></div></form>` : ''}</div>`;
  const allIds = [...new Set([...access.admins, ...access.members, ...access.guards])].sort((x, y) => (['admin', 'member', 'guard'].indexOf(roleOf(x)) - ['admin', 'member', 'guard'].indexOf(roleOf(y))) || x.localeCompare(y));
  const members = `<div class="card members"><h3>ผู้ใช้ที่เข้าระบบได้ (${allIds.length})</h3><p class="muted">ล็อกอินด้วยชื่อผู้ใช้และรหัสผ่าน ผู้ตรวจ (รปภ.) ดูผังและบันทึกตรวจเช็คได้อย่างเดียว ไม่เห็นรหัสพนักงาน${isAdmin ? ' เพิ่มชื่อที่นี่แล้วสร้างบัญชีใน Firebase ด้วยชื่อเดียวกัน' : ''}</p>
    <ul>${allIds.map(em => { const r = roleOf(em), nm = access.names[em]; return `<li><span><b>${esc(shortId(em))}</b>${nm ? ` <span class="muted">${esc(nm)}</span>` : ''} <span class="pill">${ROLE_TXT[r]}</span></span>${isAdmin && em !== user.email ? `<button class="link danger" data-act="rm-member" data-email="${esc(em)}">นำออก</button>` : ''}</li>`; }).join('') || '<li class="muted">ยังไม่มีผู้ใช้</li>'}</ul>
    ${isAdmin ? `<form id="memberAdd" class="grid2"><label class="f"><span>ชื่อผู้ใช้</span><input name="uid" required maxlength="40" pattern="[A-Za-z0-9._@\\-]+" placeholder="เช่น guard01 หรือ somchai" autocapitalize="none"></label>
      <label class="f"><span>ชื่อที่แสดง</span><input name="nm" maxlength="40" placeholder="เช่น รปภ. สมศักดิ์ กะกลางวัน"></label>
      <label class="f"><span>บทบาท</span><select name="role"><option value="guards">ผู้ตรวจ (รปภ.)</option><option value="members">สมาชิก (คนในแผนก)</option><option value="admins">ผู้ดูแลระบบ</option></select></label>
      <div class="f" style="justify-content:flex-end"><button class="btn pri">เพิ่มผู้ใช้</button></div></form>` : ''}</div>`;
  const backup = `<div class="card"><h3>สำรองข้อมูล</h3><p class="muted">ดาวน์โหลดไฟล์สำรองเก็บไว้เป็นระยะ ไฟล์มีข้อมูลส่วนบุคคลของพนักงาน เก็บในที่ปลอดภัย</p>
    <div class="row-gap"><button class="btn" data-act="backup">ดาวน์โหลดไฟล์สำรอง</button>${isAdmin ? '<button class="btn ghost" data-act="restore">กู้คืนจากไฟล์สำรอง</button><button class="btn ghost" data-act="relock">ตรวจดัชนีกันจองชน</button>' : ''}</div></div>`;
  const trash = db.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt);
  const TT = { perm: 'ช่องประจำ', temp: 'จองชั่วคราว', zone: 'สถานที่' };
  const tr = `<div class="card wide"><h3>ถังขยะ (${trash.length})</h3><p class="muted">รายการที่ลบเก็บไว้ 30 วัน กู้คืนได้ตลอด ครบกำหนดแล้วระบบลบถาวรเอง</p>
    ${trash.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>ประเภท</th><th>รายการ</th><th>ลบเมื่อ</th><th>ลบถาวรใน</th><th></th></tr></thead><tbody>${trash.map(x => {
      const it = x.item || {}, left = Math.max(0, Math.ceil((x.deletedAt + TRASH_MS - Date.now()) / 864e5));
      return `<tr><td>${TT[x.type] || x.type}</td><td><b>${esc(it.name)}</b><div class="sub">${esc(it.plate || '')} ${esc(x.zoneName || '')} ${it.slot ? 'ช่อง ' + esc(it.slot) : ''} ${it.date ? fmtRange(it) : ''}</div></td><td class="nw sub">${fmtTs(x.deletedAt)}<br>${esc(x.deletedBy || '')}</td><td class="nw">${left} วัน</td>
        <td class="nw"><button class="link" data-act="restore-trash" data-id="${esc(x.id)}">กู้คืน</button>${isAdmin ? `<button class="link danger" data-act="purge" data-id="${esc(x.id)}">ลบถาวร</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="muted">ถังขยะว่าง</p>'}</div>`;
  $('setBody').innerHTML = `<div class="page-head"><h2>ตั้งค่า</h2></div><div class="set-grid">${me}${members}${zones}${backup}${tr}</div>`;
}

/* ================= การกระทำ ================= */
const GUARD_DENY = new Set(['rate-xlsx', 'per-xlsx', 'perm-here', 'new-perm-or-temp', 'edit-perm', 'del-temp', 'del-perm', 'toggle-perm', 'import', 'restore', 'restore-trash', 'purge', 'save-zone', 'del-zone', 'zone-up', 'apply-preset', 'seed-zones', 'relock', 'rm-member', 'backup', 'export-data', 'export-sum', 'hist']);
async function act(b) {
  const a = b.dataset.act, id = b.dataset.id;
  if (isGuard && GUARD_DENY.has(a)) return toast('บัญชีผู้ตรวจทำรายการนี้ไม่ได้');
  if ((a === 'edit-temp' || a === 'cancel-temp') && !canEditTemp(db.temp.find(x => x.id === id))) return toast('แก้หรือยกเลิกได้เฉพาะรายการที่คุณเพิ่มเอง');
  const z = getZone(S.zone);
  switch (a) {
    case 'sel-slot': S.sel = { zone: S.zone, slot: b.dataset.slot }; renderMap(); return peekPanel();
    case 'sel-open': S.sel = { zone: S.zone, idx: +b.dataset.idx }; renderMap(); return peekPanel();
    case 'sel-perm': S.sel = { perm: id }; renderMap(); return peekPanel();
    case 'sel-temp': { const t = db.temp.find(x => x.id === id); if (t && (t.zone !== S.zone || !onDay(t, S.vDate) || !overlap(t.from, t.to, S.vFrom, S.vTo))) { S.zone = t.zone; S.vDate = focusDate(t); S.vFrom = t.from; S.vTo = t.to; S.follow = false; } S.sel = { temp: id }; if (S.tab !== 'map') return showTab('map'); renderMap(); return peekPanel(); }
    case 'goto-perm': return gotoRec('perm', id);
    case 'goto-temp': return gotoRec('temp', id);
    case 'book-here': if (S.vTo <= S.vFrom) return toast('ตั้งเวลาออกให้หลังเวลาเข้าก่อน'); return openSheet({ type: 'temp', zone: S.zone, slot: z && !z.free ? S.sel.slot : '', date: S.vDate, from: S.vFrom, to: S.vTo });
    case 'apply-preset': return applyPreset(id);
    case 'ck-sel': S.cSlot = b.dataset.slot; renderCheck(); if (window.innerWidth <= 1100) $('cPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return;
    case 'ck-next': { const z2 = getZone(S.cZone); S.cSlot = z2 && nextUnchecked(z2, S.cSlot); renderCheck(); if (S.cSlot && window.innerWidth <= 1100) $('cPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    case 'ck-set': {
      const sl = b.dataset.slot, r = b.dataset.r, z2 = getZone(S.cZone);
      if (!await saveCheck(sl, { r })) return renderCheck();
      if (r === 'wrong') { S.cSlot = sl; renderCheck(); const f = document.querySelector('#ckForm [name=seen]'); if (f) f.focus(); return; }
      if (b.dataset.adv) { S.cSlot = nextUnchecked(z2, sl); if (!S.cSlot) toast('ตรวจครบทุกช่องแล้ว'); }
      return renderCheck();
    }
    case 'ck-clear': await saveCheck(b.dataset.slot, null); return renderCheck();
    case 'ck-export': return exportCheck();
    case 'ck-who': { await askInspector(true); return renderCheck(); }
    case 'ck-print': return window.print();
    case 'ck-open': { const c = db.checks.find(x => x.id === id); if (c) { S.cZone = c.zone; S.cDate = c.date; S.cShift = ckShiftOf(c); S.cSlot = null; showTab('chk'); } return; }
    case 'perm-here': return openSheet({ type: 'perm', zone: S.zone, slot: S.sel.slot });
    case 'new-temp': return openSheet({ type: 'temp', zone: S.tab === 'today' && S.tZone ? S.tZone : undefined, date: S.tab === 'today' ? S.tDate : S.vDate, from: S.tab === 'today' ? '08:00' : S.vFrom, to: S.tab === 'today' ? '17:00' : S.vTo });
    case 'new-perm-or-temp': if (S.dtab === 'chk') { S.cDate = today(); S.cSlot = null; return showTab('chk'); } return S.dtab === 'perm' ? openSheet({ type: 'perm' }) : openSheet({ type: 'temp', date: today(), from: '08:00', to: '17:00' });
    case 'close-sheet': return closeSheet();
    case 'dpick': { const d0 = $('bDate').value || today(); $('bDateTo').value = b.dataset.d === '0' ? '' : dpickTo(b, d0); return refreshSheetSlots(); }
    case 'copy-today': { const txt = todayText(); try { await navigator.clipboard.writeText(txt); toast('คัดลอกแล้ว วางใน LINE ส่ง รปภ. ได้เลย'); } catch (e) { openDialog({ title: 'คัดลอกข้อความ', body: `<textarea readonly style="width:100%;min-height:240px;font:inherit">${esc(txt)}</textarea>`, buttons: [{ label: 'ปิด', value: true, cls: 'pri' }] }); } return; }
    case 'tpick': {   // เลือกช่วงเวลาที่ขอใช้แบบเร็ว
      let f = b.dataset.f, t = b.dataset.t;
      if (f === 'now') { const n = Math.ceil(hm2m(nowHM()) / 15) * 15; f = m2hm(n); t = m2hm(Math.min(1439, n + 120)); if ($('bDate').value !== today()) $('bDate').value = today(); }
      $('bFrom').value = f; $('bTo').value = t; refreshSheetSlots(); return;
    }
    case 'edit-perm': { const r = db.permanent.find(x => x.id === id); if (r) openSheet({ type: 'perm', edit: r }); return; }
    case 'edit-temp': { const r = db.temp.find(x => x.id === id); if (r) openSheet({ type: 'temp', edit: r }); return; }
    case 'cancel-temp': {
      const t = db.temp.find(x => x.id === id); if (!t) return;
      if (!await askConfirm(`ยกเลิกการจองของ <b>${esc(t.name)}</b> ทะเบียน ${esc(t.plate)} วันที่ ${fmtRange(t)}?`, 'ยกเลิกการจอง', true)) return;
      const r = { ...db.temp.find(x => x.id === id), cancelled: true }; touch(r, 'ยกเลิกการจอง');
      await put('temp', r).catch(() => {}); dropLock(lockOf(r), r.id); if (S.sel && S.sel.temp === id) S.sel = null; return toast('ยกเลิกการจองแล้ว');
    }
    case 'del-temp': case 'del-perm': {
      const perm = a === 'del-perm', r = (perm ? db.permanent : db.temp).find(x => x.id === id); if (!r) return;
      if (!await askConfirm(`ย้าย <b>${esc(r.name)}</b> (${esc(r.plate)}) ไปถังขยะ? กู้คืนได้ภายใน 30 วัน`, 'ย้ายไปถังขยะ', true, 'ลบรายการ')) return;
      const tr = { id: uid(), type: perm ? 'perm' : 'temp', item: JSON.parse(JSON.stringify(r)), deletedAt: Date.now(), deletedBy: by(), zoneName: zoneName(r.zone) };
      await writeOps([{ kind: 'trash', rec: tr }, { del: r.id }]).catch(() => {});
      dropLock(perm ? lockP(r.zone) : lockOf(r), r.id); S.sel = null; return toast('ย้ายไปถังขยะแล้ว');
    }
    case 'toggle-perm': {
      const p = db.permanent.find(x => x.id === id); if (!p) return;
      if (p.active && !await askConfirm(`คืนช่อง ${esc(p.slot)} ของ <b>${esc(p.name)}</b> (ลาออก ย้าย หรือเกษียณ)? ข้อมูลยังเก็บไว้ ใช้งานอีกครั้งได้ภายหลัง`, 'คืนช่อง', false)) return;
      const r = { ...p, active: !p.active }; touch(r, r.active ? 'กลับมาใช้ช่องประจำ' : 'คืนช่องประจำ');
      try { await savePerm(r, p); toast(r.active ? 'ใช้งานช่องประจำอีกครั้งแล้ว' : 'คืนช่องแล้ว'); } catch (e) { toast(e.message || 'บันทึกไม่สำเร็จ'); }
      return;
    }
    case 'hist': {
      const list = b.dataset.kind === 'perm' ? db.permanent : b.dataset.kind === 'temp' ? db.temp : db.zones, r = list.find(x => x.id === id); if (!r) return;
      const rows = (r.log || []).slice().reverse().map(l => `<li style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(l.a)}${l.by ? `<br><span class="muted" style="font-size:.85em">${esc(l.by)}</span>` : ''}</span><span class="muted" style="white-space:nowrap">${fmtTs(l.at)}</span></li>`).join('') || '<li class="muted">ยังไม่มีประวัติ</li>';
      return openDialog({ title: 'ประวัติ: ' + r.name, body: `<ul style="list-style:none;padding:0;margin:0">${rows}</ul>`, buttons: [{ label: 'ปิด', value: true, cls: 'pri' }] });
    }
    case 'seed-zones': return seedZones();
    case 'export-data': return exportData();
    case 'export-sum': return exportSum();
    case 'rate-xlsx': return exportRateXlsx();
    case 'stab': S.stab = b.dataset.s; return renderSum();
    case 'per-mode': perState().mode = b.dataset.m; return renderPeriod();
    case 'per-nav': { const P = perState(); P.a = perShift(P.mode, perRange(P.mode, P.a)[0], +b.dataset.n); return renderPeriod(); }
    case 'per-now': perState().a = today(); return renderPeriod();
    case 'per-view': perState().view = b.dataset.v; return renderPeriod();
    case 'per-xlsx': return exportPeriodXlsx();
    case 'import': return $('importFile').click();
    case 'backup': return download(`ที่จอดรถ-สำรอง-${today()}.json`, JSON.stringify({ app: 'parking', at: Date.now(), zones: db.zones, permanent: db.permanent, temp: db.temp, trash: db.trash }, null, 2), 'application/json');
    case 'restore': return $('restoreFile').click();
    case 'relock': try { await rebuildLocks(); toast('ตรวจและสร้างดัชนีใหม่แล้ว'); } catch (e) { writeErr(e); } return;
    case 'restore-trash': return restoreTrash(id);
    case 'purge': { if (await askConfirm('ลบรายการนี้ถาวร? กู้คืนไม่ได้อีก', 'ลบถาวร', true)) writeOps([{ del: id }]).catch(() => {}); return; }
    case 'save-zone': return saveZone(b);
    case 'del-zone': return delZone(id);
    case 'zone-up': { const i = db.zones.findIndex(x => x.id === id); if (i < 1) return; const zs = db.zones.slice(); [zs[i - 1], zs[i]] = [zs[i], zs[i - 1]]; return writeOps(zs.map((x, k) => ({ kind: 'zone', rec: { ...x, ord: k } }))).catch(() => {}); }
    case 'rm-member': return setMember(b.dataset.email, null);
    case 'signout': return auth.signOut();
    case 'demo-reset': if (await askConfirm('ล้างข้อมูลสาธิตและเริ่มใหม่?', 'ล้างข้อมูล', true)) { localStorage.removeItem(DEMO_KEY); location.reload(); } return;
    case 'signin': return;
    case 'reload': return location.reload();
  }
}
function defaultZones() {
  const Z = (id, key, ord) => { const P = PRESETS[key](); return stamp({ id, name: P.name, slots: P.slots, capacity: P.slots.length, tags: P.tags, layout: P.layout, note: P.note, allowPerm: true, perRow: 12, ord }, 'สร้างสถานที่'); };
  const F = (id, name, cap, ord, note) => stamp({ id, name, slots: [], free: true, capacity: cap, perRow: 8, ord, note }, 'สร้างสถานที่');
  return [Z('z-pilot-plant', 'pilot', 0), Z('z-wastewater', 'waste', 1), F('z-front-2-2', 'หน้าตึก 2.2', 15, 2, 'หน้าอาคารผลิต 2.2'), F('z-power-plant', 'โรงไฟฟ้า', 20, 3, 'นอกรั้วโรงงาน ฝั่งตรงข้ามถนนสาธารณประโยชน์')];
}
async function seedZones() {
  await writeOps(defaultZones().map(rec => ({ kind: 'zone', rec }))).catch(() => {});
  toast('สร้างสถานที่เริ่มต้นแล้ว แก้ความจุและรายละเอียดได้ที่ตั้งค่า');
}
/* ใช้ผังจริงตามแบบฟอร์มตรวจเช็ค (PILOT PLANT 45 ช่อง / บ่อบำบัด 17 ช่อง) เลขช่องตรงกับฟอร์มเดิม */
async function applyPreset(zid) {
  const z = getZone(zid), key = z && presetKey(z); if (!key) return;
  const P = PRESETS[key](), num = s => /^\d+$/.test(String(s)) ? +s : NaN;
  const recs = db.permanent.filter(p => p.zone === zid).concat(db.temp.filter(t => t.zone === zid && t.slot && isLive(t)));
  const canShift = false;   // เลขช่องตรงกับฟอร์มเดิม ไม่ต้องเลื่อน
  const shifted = (r, sh) => sh && num(r.slot) >= 27 ? String(num(r.slot) + 1) : String(r.slot || '');
  const problems = sh => {
    const keep = new Set(P.slots.map(normSlot)), out = [];
    db.permanent.filter(p => p.zone === zid && p.active).forEach(p => { const n = normSlot(shifted(p, sh)); if (!keep.has(n)) out.push(`${p.name}: ช่อง ${shifted(p, sh)} ไม่มีในผังใหม่`); else if (P.tags[n] === 'vip') out.push(`${p.name}: ช่อง ${shifted(p, sh)} จะเป็นช่องลูกค้า VIP`); });
    return out;
  };
  const tagLine = Object.keys(P.tags).length ? `<li>ช่อง ${slotsText(P.slots.filter(x => P.tags[x] === 'vip'))} เป็นช่องลูกค้า VIP (จองตามเวลา) ช่อง ${slotsText(P.slots.filter(x => P.tags[x] === 'exec'))} เป็นช่องผู้บริหาร</li>` : '';
  const body = `<p>ตั้งผัง <b>${esc(z.name)}</b> ตามแบบฟอร์มตรวจเช็ครถประจำวัน</p><ul><li>${P.slots.length} ช่อง (${slotsText(P.slots)}) วางตำแหน่งตามแบบฟอร์ม</li>${tagLine}</ul>
    ${canShift ? `<p style="margin-top:8px">แบบฟอร์มเดิมพิมพ์เลข 26 ซ้ำ เลขช่องจริงตั้งแต่ 27 จึงเลื่อนขึ้น 1 (เดิม 45 ช่อง เป็น 46 ช่อง) ต้องการเลื่อนเลขช่องของรายการเดิมที่ใช้ช่อง 27–45 ไปด้วยไหม</p>` : ''}`;
  const buttons = canShift ? [{ label: 'ยกเลิก', value: false }, { label: 'ใช้ผัง ไม่เลื่อนเลขเดิม', value: 'keep' }, { label: 'ใช้ผังและเลื่อนเลข 27–45 เป็น 28–46', value: 'shift', cls: 'pri' }]
    : [{ label: 'ยกเลิก', value: false }, { label: 'ใช้ผังนี้', value: 'keep', cls: 'pri' }];
  const ans = await openDialog({ title: 'ใช้ผังจริง', body, buttons }); if (!ans) return;
  const sh = ans === 'shift', bad = problems(sh);
  if (bad.length) return openDialog({ title: 'ยังใช้ผังนี้ไม่ได้', body: `<p>ย้ายหรือคืนช่องของรายการเหล่านี้ก่อน</p><ul>${bad.slice(0, 20).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`, buttons: [{ label: 'ปิด', value: true, cls: 'pri' }] });
  const zr = { ...z, slots: P.slots, capacity: P.slots.length, tags: P.tags, layout: P.layout, note: z.note || P.note, allowPerm: true, ord: db.zones.indexOf(z) };
  touch(zr, 'ใช้ผังจริงตามแบบฟอร์มตรวจเช็ค');
  const ops = [{ kind: 'zone', rec: zr }];
  if (sh) {
    db.permanent.filter(p => p.zone === zid && num(p.slot) >= 27).forEach(p => { const r = { ...p, slot: shifted(p, true) }; touch(r, `เลื่อนเลขช่อง ${p.slot} เป็น ${r.slot} ตามผังใหม่`); ops.push({ kind: 'perm', rec: r }); });
    db.temp.filter(t => t.zone === zid && num(t.slot) >= 27).forEach(t => { const r = { ...t, slot: shifted(t, true) }; touch(r, `เลื่อนเลขช่อง ${t.slot} เป็น ${r.slot} ตามผังใหม่`); ops.push({ kind: 'temp', rec: r }); });
  }
  await writeOps(ops).catch(() => {}); await rebuildLocks().catch(console.error);
  toast(`ใช้ผังจริงของ ${z.name} แล้ว${sh ? ` เลื่อนเลขช่อง ${ops.length - 1} รายการ` : ''}`);
}
async function saveZone(b) {
  const row = b.closest('[data-zone]'), z = getZone(b.dataset.id); if (!z) return;
  const name = row.querySelector('[data-f=name]').value.trim(), per = Math.max(2, Math.min(40, parseInt((row.querySelector('[data-f=per]') || {}).value, 10) || z.perRow));
  if (!name) return toast('ชื่อสถานที่ต้องไม่ว่าง');
  if (db.zones.some(o => o.id !== z.id && o.name.toLowerCase() === name.toLowerCase())) return toast('มีสถานที่ชื่อนี้อยู่แล้ว');
  const r = { ...z, name, perRow: per, allowPerm: isPermZone(z) };
  const mapV = row.querySelector('[data-f=map]').value.trim(); if (mapV && !safeUrl(mapV)) return toast('ลิงก์ต้องเป็นลิงก์ Google Maps (https://maps.app.goo.gl/... หรือ https://www.google.com/maps/...)');
  r.mapUrl = mapV; r.note = row.querySelector('[data-f=note]').value.trim();
  if (z.free) { const n = parseInt(row.querySelector('[data-f=cap]').value, 10); if (!(n >= 0 && n <= 9999)) return toast('ความจุต้องเป็นตัวเลข 0-9999'); r.capacity = n; }
  else {
    const slots = parseSlots(row.querySelector('[data-f=slots]').value); if (!slots.length) return toast('ใส่หมายเลขช่องอย่างน้อย 1 ช่อง');
    const keep = new Set(slots.map(normSlot));
    const hp = db.permanent.find(p => p.active && p.zone === z.id && !keep.has(normSlot(p.slot))); if (hp) return toast(`เอาช่อง ${hp.slot} ออกไม่ได้ เป็นช่องประจำของ ${hp.name}`);
    const ht = db.temp.find(t => t.zone === z.id && t.slot && isLive(t) && !keep.has(normSlot(t.slot))); if (ht) return toast(`เอาช่อง ${ht.slot} ออกไม่ได้ มีจองของ ${ht.name}`);
    const tags = {}, has = new Set(slots.map(normSlot));
    parseSlots(row.querySelector('[data-f=vip]').value).forEach(x => { if (has.has(normSlot(x))) tags[normSlot(x)] = 'vip'; });
    parseSlots(row.querySelector('[data-f=exec]').value).forEach(x => { if (has.has(normSlot(x)) && !tags[normSlot(x)]) tags[normSlot(x)] = 'exec'; });
    const pv = db.permanent.find(p => p.active && p.zone === z.id && tags[normSlot(p.slot)] === 'vip'); if (pv) return toast(`ตั้งช่อง ${pv.slot} เป็น VIP ไม่ได้ เป็นช่องประจำของ ${pv.name} ย้ายก่อน`);
    r.slots = slots; r.capacity = slots.length; r.tags = tags;
  }
  r.ord = db.zones.indexOf(z); touch(r, 'แก้ไขสถานที่/ผัง');
  await put('zone', r).catch(() => {}); toast('บันทึกสถานที่แล้ว');
}
async function delZone(id) {
  const z = getZone(id); if (!z) return;
  if (db.permanent.some(p => p.zone === id && p.active) || db.temp.some(t => t.zone === id && isLive(t))) return toast('ลบไม่ได้ ยังมีช่องประจำหรือการจองที่ใช้งานอยู่ในสถานที่นี้');
  if (!await askConfirm(`ย้ายสถานที่ <b>${esc(z.name)}</b> ไปถังขยะ? ประวัติการจองเดิมยังเก็บไว้`, 'ย้ายไปถังขยะ', true)) return;
  await writeOps([{ kind: 'trash', rec: { id: uid(), type: 'zone', item: JSON.parse(JSON.stringify(z)), deletedAt: Date.now(), deletedBy: by(), zoneName: z.name } }, { del: id }]).catch(() => {});
  toast('ย้ายไปถังขยะแล้ว');
}
async function restoreTrash(id) {
  const x = db.trash.find(t => t.id === id); if (!x) return;
  const it = JSON.parse(JSON.stringify(x.item));
  try {
    if (x.type === 'zone') {
      if (db.zones.some(z => z.name.toLowerCase() === it.name.toLowerCase())) return toast('มีสถานที่ชื่อนี้อยู่แล้ว เปลี่ยนชื่อสถานที่เดิมก่อน');
      touch(it, 'กู้คืนจากถังขยะ'); it.ord = db.zones.length; await writeOps([{ kind: 'zone', rec: it }, { del: id }]);
    } else {
      const z = getZone(it.zone); if (!z) return toast('ไม่พบสถานที่เดิมของรายการนี้ กู้คืนสถานที่ก่อน');
      touch(it, 'กู้คืนจากถังขยะ');
      if (x.type === 'perm') { if (!hasSlot(z, it.slot)) it.active = false; await savePerm(it); }
      else { if (it.slot && !freeSlotsFor(z, it.date, it.from, it.to, it.id).some(s => normSlot(s) === normSlot(it.slot))) it.slot = ''; try { await saveTemp(it); } catch (e) { it.cancelled = true; touch(it, 'กู้คืนเป็นสถานะยกเลิก (ช่วงเวลานั้นเต็ม)'); await put('temp', it); } }
      await writeOps([{ del: id }]);
    }
    toast('กู้คืนแล้ว');
  } catch (e) { toast(e.message || 'กู้คืนไม่สำเร็จ'); }
}
async function restoreBackup(f) {
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.zones) || !Array.isArray(d.permanent) || !Array.isArray(d.temp)) throw 0;
    if (!await askConfirm(`กู้คืนจากไฟล์ ${esc(f.name)}? ข้อมูลปัจจุบันทั้งหมดจะถูกแทนที่ และทุกคนจะเห็นทันที (สถานที่ ${d.zones.length} ช่องประจำ ${d.permanent.length} จองชั่วคราว ${d.temp.length})`, 'กู้คืน', true, 'กู้คืนข้อมูลทั้งหมด')) return;
    const clean = (r, i) => { r = { ...r }; r.id = String(r.id || uid()).replace(/[\/.#$\[\]]/g, '_').slice(0, 120); if (i != null) r.ord = i; return r; };
    const ops = [...docs.keys()].map(id => ({ del: id }));
    d.zones.forEach((z, i) => ops.push({ kind: 'zone', rec: clean(z, i) })); d.permanent.forEach(p => ops.push({ kind: 'perm', rec: clean(p) }));
    d.temp.forEach(t => ops.push({ kind: 'temp', rec: clean(t) })); (d.trash || []).forEach(t => ops.push({ kind: 'trash', rec: clean(t) }));
    const last = new Map(); ops.forEach(o => last.set(o.del || o.rec.id, o));   // ลบก่อนแล้วเขียนทับด้วยรายการในไฟล์
    await writeOps([...last.values()]); await rebuildLocks().catch(console.error);
    toast('กู้คืนข้อมูลแล้ว');
  } catch (e) { toast(e === 0 ? 'ไฟล์สำรองไม่ถูกต้อง' : 'กู้คืนไม่สำเร็จ'); }
}
async function setMember(raw, role, name) {
  const em = toLogin(raw); if (!raw || !/^[a-z0-9._%+\-]+@[a-z0-9.\-]+$/.test(em)) return toast('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ -');
  if (!role && !await askConfirm(`นำ <b>${esc(shortId(em))}</b> ออก? จะเข้าระบบไม่ได้อีก (ลบหรือปิดบัญชีใน Firebase ด้วย)`, 'นำออก', true)) return;
  const LISTS = ['admins', 'members', 'guards'];
  if (!fs) {
    LISTS.forEach(k => { access[k] = access[k].filter(e => e !== em); }); if (role) { access[role].push(em); if (name) access.names[em] = name; } else delete access.names[em];
    renderSet(); return toast(role ? 'เพิ่มผู้ใช้แล้ว (โหมดสาธิต)' : 'นำออกแล้ว');
  }
  const F = firebase.firestore.FieldValue, FP = firebase.firestore.FieldPath, ref = fs.doc('config/access');
  try {
    const args = [];
    LISTS.forEach(k => args.push(k, k === role ? F.arrayUnion(em) : F.arrayRemove(em)));
    args.push(new FP('names', em), role ? (name || shortId(em)) : F.delete());
    await ref.update(...args);
    if (!role) return toast('นำออกแล้ว');
    openDialog({ title: 'ขั้นต่อไป: สร้างบัญชีใน Firebase', body: `<p>เพิ่ม <b>${esc(shortId(em))}</b> ในรายชื่อแล้ว ต้องสร้างบัญชีให้ด้วย ถึงจะล็อกอินได้</p>
      <ol style="padding-left:20px;margin-top:8px"><li>เปิด Firebase Console > Authentication > Users</li><li>กด <b>Add user</b></li><li>Email ใส่ <b style="user-select:all">${esc(em)}</b></li><li>Password ตั้งรหัสผ่านอย่างน้อย 8 ตัว แล้วกด Add user</li><li>แจ้งผู้ใช้: ชื่อผู้ใช้ <b>${esc(shortId(em))}</b> และรหัสผ่านที่ตั้ง</li></ol>`,
      buttons: [{ label: 'ปิด', value: false }, { label: 'เปิด Firebase Console', value: true, cls: 'pri' }] }).then(v => { if (v) window.open(`https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/users`, '_blank', 'noopener'); });
  } catch (e) { writeErr(e); }
}
async function changePassword(f) {
  const cur = f.get('cur'), nw = f.get('nw'), nw2 = f.get('nw2');
  if (nw.length < 8) return toast('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัว');
  if (nw !== nw2) return toast('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
  if (!fs) return toast('โหมดสาธิต: เปลี่ยนรหัสผ่านจริงไม่ได้');
  try {
    const u = auth.currentUser;
    await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, cur));
    await u.updatePassword(nw);
    toast('เปลี่ยนรหัสผ่านแล้ว'); $('pwForm') && $('pwForm').reset();
  } catch (e) { toast(['auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(e.code) ? 'รหัสผ่านปัจจุบันไม่ถูกต้อง' : e.code === 'auth/too-many-requests' ? 'ลองผิดหลายครั้ง รอสักครู่แล้วลองใหม่' : 'เปลี่ยนรหัสผ่านไม่สำเร็จ (' + (e.code || '') + ')'); }
}

/* แตะลานจอดในผังโรงงานแล้วเลื่อนลงไปที่ผังลานนั้นให้เอง */
function scrollToLot() {
  const w = document.querySelector('#tab-map .when') || document.querySelector('#tab-map .map-wrap'); if (!w) return;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => w.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }));
}

/* ================= กล่องยืนยัน / แจ้งเตือน ================= */
let dlgRes = null, dlgBtns = [];
function openDialog({ title, body, buttons }) {
  return new Promise(res => {
    if (dlgRes) dlgRes(false); dlgRes = res; dlgBtns = buttons;
    $('dlgTitle').textContent = title; $('dlgBody').innerHTML = body;
    $('dlgBtns').innerHTML = buttons.map((b, i) => `<button type="button" class="btn ${b.cls || 'ghost'}" data-dlg="${i}">${esc(b.label)}</button>`).join('');
    $('dlg').hidden = false; const l = $('dlgBtns').lastElementChild; if (l) l.focus();
  });
}
function closeDlg(v) { $('dlg').hidden = true; const r = dlgRes; dlgRes = null; if (r) r(v); }
const askConfirm = (msg, ok = 'ยืนยัน', danger = false, title = 'โปรดยืนยัน') => openDialog({ title, body: `<p>${msg}</p>`, buttons: [{ label: 'ไม่ใช่', value: false }, { label: ok, value: true, cls: danger ? 'warn' : 'pri' }] });
const info = (title, msg) => openDialog({ title, body: `<p>${esc(msg)}</p>`, buttons: [{ label: 'ปิด', value: true, cls: 'pri' }] });
let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4200); }
function setNet(st) {
  netState = st; const M = { live: ['ซิงก์สด', ''], wait: ['กำลังเชื่อมต่อ', 'wait'], offline: ['ออฟไลน์ รอซิงก์', 'wait'], error: ['เชื่อมต่อไม่ได้', 'off'], demo: ['โหมดสาธิต', 'wait'] };
  const [t, c] = M[st] || M.wait; $('netTxt').textContent = t; $('net').className = 'net ' + c;
}

/* ================= อีเวนต์ ================= */
function bindEvents() {
  document.addEventListener('click', e => {
    const d = e.target.closest('[data-dlg]'); if (d) return closeDlg(dlgBtns[+d.dataset.dlg].value);
    const ins = e.target.closest('[data-ins]'); if (ins) { $('insName').value = ins.dataset.ins; return closeDlg(true); }
    if (e.target.closest('[data-dlg-close]')) return closeDlg(false);
    const t = e.target.closest('[data-tab]'); if (t) return showTab(t.dataset.tab);
    const zc = e.target.closest('[data-zone].zchip, .mk[data-zone]'); if (zc) { S.zone = zc.dataset.zone; S.sel = null; saveUi(); renderMap(); if (zc.classList.contains('mk')) scrollToLot(); return; }
    const dt = e.target.closest('[data-dtab]'); if (dt) { S.dtab = dt.dataset.dtab; saveUi(); return renderData(); }
    const ty = e.target.closest('#bType button'); if (ty && !ty.disabled) return setSheetType(ty.dataset.type);
    const b = e.target.closest('[data-act]'); if (b) { e.preventDefault(); act(b); }
    if (!e.target.closest('#findForm')) $('findList').hidden = true;
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('dlg').hidden) return closeDlg(false);
    if (!$('sheet').hidden) return closeSheet();
    if (!$('findList').hidden) { $('findList').hidden = true; return; }
    if (S.sel) { S.sel = null; renderMap(); }
  });
  document.addEventListener('keydown', e => { const g = e.target.closest && e.target.closest('.mk[data-zone]'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); S.zone = g.dataset.zone; S.sel = null; saveUi(); renderMap(); scrollToLot(); } });
  const win = () => { S.vDate = $('vDate').value || today(); if (S.vDate < today()) S.vDate = today(); S.vFrom = $('vFrom').value || '00:00'; S.vTo = $('vTo').value || '23:59'; S.follow = false; S.sel = S.sel && (S.sel.perm || S.sel.temp) ? S.sel : null; renderMap(); };
  ['vDate', 'vFrom', 'vTo'].forEach(i => $(i).addEventListener('change', win));
  $('vNow').addEventListener('click', () => { setWindowNow(); renderMap(); });
  $('viewToggle').addEventListener('click', () => { S.view3d = !S.view3d; saveUi(); renderMap(); });
  $('zoomIn').addEventListener('click', () => { S.zoom = Math.min(2.5, S.zoom * 1.25); layoutStage(); });
  $('zoomOut').addEventListener('click', () => { S.zoom = Math.max(0.5, S.zoom / 1.25); layoutStage(); });
  $('findQ').addEventListener('input', renderFind);
  $('findQ').addEventListener('focus', renderFind);
  $('findForm').addEventListener('submit', e => { e.preventDefault(); const m = findMatches($('findQ').value); if (m[0]) gotoRec(m[0].k, m[0].r.id); });
  $('cZone').addEventListener('change', () => { S.cZone = $('cZone').value; S.cSlot = null; saveUi(); renderCheck(); });
  $('cDate').addEventListener('change', () => { const v = $('cDate').value; S.cDate = v && v <= today() ? v : today(); S.cSlot = null; renderCheck(); });
  $('cShift').addEventListener('change', () => { S.cShift = $('cShift').value === 'n' ? 'n' : 'd'; S.cSlot = null; renderCheck(); });
  $('tDate').addEventListener('change', () => { S.tDate = $('tDate').value || today(); renderToday(); });
  $('tZone').addEventListener('change', () => { S.tZone = $('tZone').value; saveUi(); renderToday(); });
  $('bDateTo').addEventListener('change', refreshSheetSlots);
  $('sRange').addEventListener('change', renderSum);
  rateBind(); thaiDates();
  ['dQ', 'dZone', 'dStatus'].forEach(i => $(i).addEventListener('input', renderData));
  $('bForm').addEventListener('submit', submitSheet);
  $('bZone').addEventListener('change', () => { sheetZone = $('bZone').value; sheetSlot = ''; refreshSheetSlots(); });
  $('bSlot').addEventListener('change', () => { sheetSlot = $('bSlot').value; refreshSheetSlots(); });
  ['bDate', 'bFrom', 'bTo'].forEach(i => $(i).addEventListener('change', refreshSheetSlots));
  $('importFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
  $('restoreFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); });
  document.addEventListener('submit', e => {
    if (e.target.id === 'zoneAdd') {
      e.preventDefault(); const f = new FormData(e.target), name = String(f.get('name')).trim(), slots = parseSlots(f.get('slots'));
      if (!name) return; if (db.zones.some(z => z.name.toLowerCase() === name.toLowerCase())) return toast('มีสถานที่ชื่อนี้อยู่แล้ว');
      const rec = slots.length ? { id: uid(), name, slots, capacity: slots.length, perRow: slots.length > 30 ? 12 : 10, ord: db.zones.length } : { id: uid(), name, slots: [], free: true, capacity: Math.max(1, +f.get('cap') || 10), perRow: 10, ord: db.zones.length };
      stamp(rec, 'สร้างสถานที่'); put('zone', rec).then(() => toast('เพิ่มสถานที่แล้ว')).catch(() => {}); e.target.reset();
    }
    if (e.target.id === 'ckForm') { e.preventDefault(); const f = new FormData(e.target); if (S.cSlot) saveCheck(S.cSlot, { seen: String(f.get('seen') || '').trim(), note: String(f.get('note') || '').trim() }).then(ok => { if (ok) toast('บันทึกแล้ว'); renderCheck(); }); return; }
    if (e.target.id === 'insForm') { e.preventDefault(); closeDlg(true); return; }
    if (e.target.id === 'memberAdd') { e.preventDefault(); const f = new FormData(e.target); setMember(f.get('uid'), f.get('role'), String(f.get('nm') || '').trim()); e.target.reset(); }
    if (e.target.id === 'pwForm') { e.preventDefault(); changePassword(new FormData(e.target)); }
    if (e.target.id === 'loginForm') { e.preventDefault(); signIn(new FormData(e.target)); }
  });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.tab === 'map') layoutStage(); }, 120); });
  window.addEventListener('online', () => setNet(fs ? 'wait' : 'demo')); window.addEventListener('offline', () => setNet(fs ? 'offline' : 'demo'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
}
let lastMin = '';
function tick(force) {
  const n = new Date();
  $('clock').textContent = fDL.format(n).replace(/^วัน/, '') + ' ' + nowHM() + ' น.';
  const m = today() + nowHM();
  if (m === lastMin && !force) return; lastMin = m;
  if (S.follow) { const sel = S.sel; setWindowNow(); S.sel = sel; }
  if (S.vDate < today()) S.vDate = today();
  if ($('sheet').hidden && $('dlg').hidden) scheduleRender();
}

/* ================= ล็อกอินและเชื่อมต่อ ================= */
function gate(kind, extra) {
  $('app').hidden = true; $('gate').hidden = false;
  const B = $('gateBody');
  if (kind === 'loading') B.innerHTML = '<p class="muted">กำลังตรวจสอบบัญชี…</p>';
  else if (kind === 'signin') {
    B.innerHTML = `<form id="loginForm" class="login" autocomplete="on">
      <label class="f"><span>ชื่อผู้ใช้</span><input name="u" id="lgUser" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="80"></label>
      <label class="f"><span>รหัสผ่าน</span><input name="p" type="password" required autocomplete="current-password" maxlength="128"></label>
      <button class="btn pri" id="lgBtn">เข้าสู่ระบบ</button></form>
      <p class="gate-msg">ใช้ชื่อผู้ใช้และรหัสผ่านที่ผู้ดูแลระบบของแผนกออกให้ ลืมรหัสผ่าน ติดต่อผู้ดูแลระบบ</p>${extra ? `<p class="err" role="alert">${esc(extra)}</p>` : ''}`;
    setTimeout(() => { const i = $('lgUser'); if (i) i.focus(); }, 30);
  }
  else if (kind === 'denied') B.innerHTML = `<p class="gate-msg">บัญชี <b>${esc(shortId(extra))}</b> ยังไม่มีสิทธิ์เข้าใช้ระบบนี้ แจ้งผู้ดูแลระบบให้เพิ่มชื่อผู้ใช้นี้ในหน้าตั้งค่า แล้วลองเข้าใหม่</p><button class="btn ghost" style="margin-top:14px" data-act="signout">ใช้บัญชีอื่น</button>`;
  else if (kind === 'error') B.innerHTML = `<p class="gate-msg">เชื่อมต่อระบบไม่ได้ ${esc(extra || '')}<br>ตรวจอินเทอร์เน็ตแล้วโหลดหน้าใหม่</p><button class="btn pri" style="margin-top:14px" data-act="reload">โหลดใหม่</button>`;
}
async function signIn(f) {
  const u = String(f.get('u') || '').trim(), pw = String(f.get('p') || '');
  if (!u || !pw) return;
  const btn = $('lgBtn'); if (btn) { btn.disabled = true; btn.textContent = 'กำลังเข้าสู่ระบบ…'; }
  try { await auth.signInWithEmailAndPassword(toLogin(u), pw); }
  catch (e) {
    const M = { 'auth/invalid-credential': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'auth/invalid-login-credentials': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'auth/wrong-password': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'auth/user-not-found': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
      'auth/invalid-email': 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ -', 'auth/user-disabled': 'บัญชีนี้ถูกปิดการใช้งาน ติดต่อผู้ดูแลระบบ', 'auth/too-many-requests': 'ลองผิดหลายครั้ง ระบบพักการเข้าสู่ระบบชั่วคราว รอสักครู่แล้วลองใหม่',
      'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้', 'auth/operation-not-allowed': 'ระบบยังไม่เปิดการล็อกอินด้วยรหัสผ่าน (ผู้ดูแล: เปิด Email/Password ใน Firebase Authentication)' };
    gate('signin', M[e.code] || 'เข้าสู่ระบบไม่สำเร็จ (' + (e.code || e.message) + ')');
    const i = $('lgUser'); if (i) i.value = u;
  }
}
function enterApp() {
  $('gate').hidden = true; $('app').hidden = false;
  if (S.follow) setWindowNow();
  renderAll();
}
let retry = 0;
function listen() {
  unsub.forEach(f => f()); unsub = [];
  unsub.push(col.onSnapshot({ includeMetadataChanges: true }, snap => {
    retry = 0; setNet(snap.metadata.fromCache ? (navigator.onLine ? 'wait' : 'offline') : 'live');
    if (!snap.docChanges().length && docs.size) return;
    const m = new Map(); snap.forEach(d => m.set(d.id, d.data())); docs = m; rebuild();
  }, err => {
    console.error(err); setNet('error');
    if (err.code === 'permission-denied') return gate('denied', user && user.email);
    const wait = Math.min(60, 5 * 2 ** retry++); toast(`ขาดการเชื่อมต่อระบบกลาง จะลองใหม่ใน ${wait} วินาที`);
    setTimeout(listen, wait * 1000);   // เชื่อมต่อใหม่อัตโนมัติ
  }));
  unsub.push(fs.doc('config/access').onSnapshot(s => {
    access = readAccess(s.exists ? s.data() : null);
    if (!applyRole()) return gate('denied', user.email);
    renderAll();
  }, () => {}));
}
function startCloud() {
  if (!window.firebase) return gate('error', '(โหลดระบบ Firebase ไม่ได้)');
  firebase.initializeApp(firebaseConfig);
  fs = firebase.firestore();
  try { fs.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}   // เก็บคิวการเขียนไว้ในเครื่องเมื่อออฟไลน์
  col = fs.collection(COLL); locks = fs.collection(LOCKS);
  auth = firebase.auth();
  gate('loading');
  auth.onAuthStateChanged(async u => {
    unsub.forEach(f => f()); unsub = []; docs = new Map();
    if (!u) { user = null; return gate('signin'); }
    user = { email: (u.email || '').toLowerCase(), name: u.displayName || '', photo: '' };
    gate('loading');
    try {
      const s = await fs.doc('config/access').get();
      access = readAccess(s.exists ? s.data() : null);
    } catch (e) { if (e.code === 'permission-denied') return gate('denied', user.email); if (!offlineErr(e)) return gate('error', '(' + (e.code || e.message) + ')'); }
    if (!applyRole()) return gate('denied', user.email);
    setNet('wait'); enterApp(); listen();
  });
}
function startDemo() {
  $('demoBar').hidden = false; setNet('demo');
  const asGuard = new URLSearchParams(location.search).get('role') === 'guard';
  user = asGuard ? { email: 'guard01@' + USER_DOMAIN, name: '', photo: '' } : { email: 'admin@' + USER_DOMAIN, name: '', photo: '' };
  access = readAccess({ admins: ['admin@' + USER_DOMAIN], members: ['somchai@' + USER_DOMAIN], guards: ['guard01@' + USER_DOMAIN, 'guard02@' + USER_DOMAIN],
    names: { ['admin@' + USER_DOMAIN]: 'ผู้ดูแล (สาธิต)', ['somchai@' + USER_DOMAIN]: 'สมชาย ฝ่ายธุรการ', ['guard01@' + USER_DOMAIN]: 'รปภ. สมศักดิ์ กะกลางวัน', ['guard02@' + USER_DOMAIN]: 'รปภ. ประยุทธ กะกลางคืน' } });
  applyRole();
  try { const raw = localStorage.getItem(DEMO_KEY); if (raw) docs = new Map(JSON.parse(raw)); } catch (e) {}
  if (!docs.size) demoSeed();
  rebuild(); enterApp();
}
function demoSeed() {   // ข้อมูลตัวอย่างสำหรับโหมดสาธิตเท่านั้น (ชื่อและทะเบียนสมมติ)
  const ops = defaultZones().map(rec => ({ kind: 'zone', rec }));
  const names = ['สมชาย ใจดี', 'วิภาวรรณ แก้วมณี', 'ธนากร ศรีสุข', 'ปิยะนุช ทองคำ', 'อนุชา บุญมา', 'กมลชนก รัตนา', 'ประเสริฐ วงศ์ไทย', 'ศิริพร มีสุข', 'ณัฐวุฒิ พรหมมา', 'จันทร์เพ็ญ ดวงดี', 'วีระพงษ์ สายทอง', 'สุดารัตน์ ชัยมงคล', 'กิตติพัฒน์ อินทร์แก้ว', 'นภัสสร เพชรรัตน์', 'อภิชาติ นาคสุข', 'ชลธิชา ศรีวงศ์', 'พงศกร มั่นคง', 'รัตนาภรณ์ ใจงาม', 'ธีรวัฒน์ แสงทอง', 'อรอุมา บุญเกิด', 'สมศักดิ์ เจริญผล', 'มาลัย วงศ์ใหญ่', 'ปกรณ์ สุขสวัสดิ์', 'วรรณา ทองมา'];
  const depts = ['วิศวกรรม', 'ผลิต', 'ความปลอดภัย', 'คุณภาพ', 'ซ่อมบำรุง', 'วิจัยและพัฒนา'];
  const prov = ['กข', 'ฒต', 'ฆฬ', '1กท', '2ขม', '3กพ', '5กษ', '7กด', '8ขจ'];
  const pl = i => `${prov[i % prov.length]} ${1000 + (i * 797) % 9000}`;
  const pslots = [7, 8, 9, 10, 12, 13, 14, 16, 18, 21, 22, 24, 27, 28, 30, 31, 33, 36, 37, 39, 41, 44];
  pslots.forEach((sl, i) => ops.push({ kind: 'perm', rec: stamp({ id: 'p' + i, name: names[i], empId: 'EMP' + (1040 + i * 7), plate: pl(i), dept: depts[i % depts.length], division: 'ฝ่ายปฏิบัติการ', zone: 'z-pilot-plant', slot: String(sl), active: true }, 'ลงทะเบียนช่องประจำ') }));
  [['ดร.วิชัย ศักดิ์สกุล', '5'], ['คุณประภาพร เลิศวิไล', '6']].forEach(([n, sl], i) => ops.push({ kind: 'perm', rec: stamp({ id: 'px' + i, name: n, empId: 'EX' + (10 + i), plate: pl(60 + i), dept: 'ผู้บริหาร', division: 'สำนักกรรมการ', zone: 'z-pilot-plant', slot: sl, active: true }, 'ลงทะเบียนช่องประจำ') }));
  [1, 2, 3, 5, 6, 8, 9, 11, 13, 14, 16].forEach((sl, i) => ops.push({ kind: 'perm', rec: stamp({ id: 'pw' + i, name: names[23 - i], empId: 'EMP' + (2010 + i), plate: pl(30 + i), dept: 'สิ่งแวดล้อม', division: 'ฝ่ายสาธารณูปโภค', zone: 'z-wastewater', slot: String(sl), active: true }, 'ลงทะเบียนช่องประจำ') }));
  const comps = ['บจ. ไทยเคมีภัณฑ์', 'บจ. สยามวาล์ว', 'คุณมานพ (ผู้สมัครงาน)', 'บจ. อีสเทิร์นเทค', 'บมจ. พลังงานไทย', 'คุณอรุณี', 'บจ. แล็บอินสทรูเมนท์', 'บจ. เซฟตี้พลัส'];
  const kinds = ['Supplier', 'Supplier', 'ผู้สมัครงาน', 'Supplier', 'ผู้ติดต่อภายนอก', 'ลูกค้า', 'Supplier', 'ผู้ติดต่อภายนอก'];
  const vips = ['Mr. Tanaka (Kyokuyo)', 'Ms. Laurent (Distributor EU)', 'คุณสุรเชษฐ์ (ลูกค้าส่งออก)', 'Mr. Kim (Dongwon)'];
  let k = 0;
  for (let d = -40; d <= 3; d++) {
    const date = addDays(today(), d), n = d === 0 ? 8 : Math.abs((d * 7) % 5) + 2;
    for (let j = 0; j < n; j++) {
      const ci = (k * 3 + j) % comps.length, zid = ['z-front-2-2', 'z-power-plant'][(k + j) % 2];
      const from = ['08:00', '09:00', '10:30', '13:00', '08:30', '14:00', '07:30', '09:30'][j % 8], to = ['12:00', '16:00', '15:00', '17:00', '11:30', '16:30', '17:00', '12:30'][j % 8];
      const rec = stamp({ id: 't' + (k++), name: comps[ci], plate: pl(100 + k), zone: zid, slot: '', date, from, to, kind: kinds[ci], note: j % 3 === 0 ? 'มาพบคุณ' + names[(j + 2) % 10].split(' ')[0] : '', cancelled: d < 0 && j === 4 }, 'สร้างการจอง');
      rec.createdBy = names[(k + 1) % 5]; ops.push({ kind: 'temp', rec });
    }
    if (d % 3 === 0 || d === 1) {
      const rec = stamp({ id: 't' + (k++), name: vips[(d + 40) % 4], plate: pl(300 + k), zone: 'z-pilot-plant', slot: String(1 + ((d + 40) % 4)), date, from: '09:00', to: '15:00', kind: VIP_KIND, note: 'ประชุมกับผู้บริหาร', cancelled: false }, 'สร้างการจอง');
      rec.createdBy = names[2]; ops.push({ kind: 'temp', rec });
    }
  }
  // ผลตรวจเช็คย้อนหลัง
  const perms = ops.filter(o => o.kind === 'perm').map(o => o.rec);
  const insD = ['สมศักดิ์ ใจดี', 'วีระ แก้วมณี'], insN = ['ประยุทธ มั่นคง', 'บุญมี ศรีสุข'];
  for (let d = -14; d <= -1; d++) {
    const date = addDays(today(), d), day0 = new Date(date + 'T00:00:00+07:00').getTime();
    ['d', 'n'].forEach(sh => ['z-pilot-plant', 'z-wastewater'].forEach(zid => {
      const z = ops.find(o => o.kind === 'zone' && o.rec.id === zid).rec, items = {}, t0 = day0 + (sh === 'd' ? 7.3 : 19.4) * 36e5, who = (sh === 'd' ? insD : insN)[(-d) % 2];
      z.slots.forEach((sl, i) => {
        const p = perms.find(x => x.zone === zid && x.slot === sl), q = sh === 'n' ? 4 : 0;
        const r = p ? ((i % 9 === 4 && (d + i) % 3 !== 0) || (i * 7 + d * 3 + q) % 11 === 0 ? 'none' : (i * 5 + d + q) % 23 === 0 ? 'wrong' : 'ok') : ((i + d + q) % 17 === 0 ? 'wrong' : 'none');
        items[ckKey(sl)] = { slot: sl, r, at: t0 + i * 35e3, by: who, acct: sh === 'd' ? 'guard01' : 'guard02', exp: p ? { name: p.name, plate: p.plate } : null, seen: r === 'wrong' ? pl(500 + i) : '' };
      });
      const id = ckId(zid, date, sh);
      ops.push({ kind: 'check', rec: { id, zone: zid, date, shift: sh, items, by: who, createdAt: t0, updatedAt: t0 + z.slots.length * 35e3 } });
    }));
  }
  // ตัวอย่างจองต่อเนื่องหลายเดือน (เคสพิเศษ)
  ops.push({ kind: 'temp', rec: stamp({ id: 'tm1', name: 'บจ. ผู้รับเหมาก่อสร้าง (งานโรงไฟฟ้า)', plate: '9กพ 4521', zone: 'z-power-plant', slot: '', date: addDays(today(), -14), dateTo: addDays(today(), 76), from: '07:30', to: '17:30', kind: 'Supplier', note: 'งานปรับปรุงโรงไฟฟ้า 3 เดือน', cancelled: false }, 'สร้างการจอง') });
  ops.push({ kind: 'temp', rec: stamp({ id: 'tm2', name: 'บจ. ที่ปรึกษาระบบ', plate: '2ขม 7788', zone: 'z-front-2-2', slot: '', date: today(), dateTo: addDays(today(), 29), from: '08:00', to: '17:00', kind: 'ผู้ติดต่อภายนอก', note: 'โครงการ 1 เดือน', cancelled: false }, 'สร้างการจอง') });
  ops.forEach(o => { if ('createdAcct' in o.rec) o.rec.createdAcct = 'somchai@' + USER_DOMAIN; docs.set(o.rec.id, toDoc(o.kind, o.rec)); }); demoSave();
}

/* ================= เริ่ม ================= */
bindEvents();
setInterval(tick, 15000); tick(true);
if (DEMO) { startDemo(); window.__t = { checkTemp, checkPerm, occupancy, get db() { return db; }, today, nowHM, addDays }; } else startCloud();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
