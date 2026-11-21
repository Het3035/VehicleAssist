// Vehicle QR contact app - 100% free stack: Node + SQLite + Web Push (no paid services).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const webpush = require('web-push');
const nodemailer = require('nodemailer');

require('./env'); // loads .env (real environment variables win)
const backup = require('./backup');
const I18N = require('./public/i18n.js'); // same dictionaries the website uses, so emails and notifications match the owner's language

const PORT = Number(process.env.PORT) || 3000;
// URL that gets encoded in the QR codes. Set BASE_URL to your LAN IP / tunnel URL
// so phones can reach it, e.g. BASE_URL=http://192.168.1.20:3000
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ---- email (any SMTP; Gmail with an app password is free) ----
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_ON = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const mailer = SMTP_ON ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;
const MAIL_FROM = process.env.SMTP_FROM || `VehicleAssist <${process.env.SMTP_USER}>`;
async function sendMail(to, subject, text) {
  if (!mailer) return false;
  try { await mailer.sendMail({ from: MAIL_FROM, to, subject, text }); return true; }
  catch (e) { console.error('Email failed:', e.message); return false; }
}

const BACKUP_DIR = backup.BACKUP_DIR();
const BACKUP_KEEP = backup.BACKUP_KEEP();
// alerts and messages older than this are deleted automatically (0 = keep forever)
const RETENTION_DAYS = process.env.MESSAGE_RETENTION_DAYS === undefined ? 90 : Math.max(0, Number(process.env.MESSAGE_RETENTION_DAYS) || 0);

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, number TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  allow_call INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, json TEXT NOT NULL
);
`);

// migrations for existing databases
for (const sql of [
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'",
  "ALTER TABLE messages ADD COLUMN sender TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN secret TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN lat REAL",
  "ALTER TABLE messages ADD COLUMN lng REAL",
  "ALTER TABLE vehicles ADD COLUMN insurance_exp TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE vehicles ADD COLUMN puc_exp TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE vehicles ADD COLUMN service_exp TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE vehicles ADD COLUMN away_msg TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN dev_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE vehicles ADD COLUMN mute_until INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN photo TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN quiet_on INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN quiet_from INTEGER NOT NULL DEFAULT 23",
  "ALTER TABLE users ADD COLUMN quiet_to INTEGER NOT NULL DEFAULT 6",
  "ALTER TABLE messages ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'",
  "ALTER TABLE users ADD COLUMN valid_after INTEGER NOT NULL DEFAULT 0",   // sessions issued before this are rejected
  "ALTER TABLE messages ADD COLUMN sender_id INTEGER NOT NULL DEFAULT 0",  // provider who sent a service update
]) { try { db.exec(sql); } catch (_) { /* already applied */ } }
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, number TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
  UNIQUE(provider_id, number)
);`);

db.exec(`
CREATE TABLE IF NOT EXISTS blocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dev_hash TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (user_id, dev_hash)
);
CREATE TABLE IF NOT EXISTS email_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS thread_msgs (
  id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  who TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders_sent (
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  field TEXT NOT NULL, exp TEXT NOT NULL, threshold INTEGER NOT NULL,
  PRIMARY KEY (vehicle_id, field, exp, threshold)
);`);

db.exec(`
CREATE TABLE IF NOT EXISTS removed_numbers (number TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS vehicle_members (
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL, PRIMARY KEY (vehicle_id, user_id)
);
CREATE TABLE IF NOT EXISTS vehicle_invites (
  code_hash TEXT PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  created INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE VIEW IF NOT EXISTS vehicle_access AS
  SELECT id AS vehicle_id, user_id FROM vehicles UNION SELECT vehicle_id, user_id FROM vehicle_members;
CREATE TABLE IF NOT EXISTS reset_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL, dev_hash TEXT NOT NULL DEFAULT '',
  target_user_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  UNIQUE(reporter_id, dev_hash, target_user_id, kind, text)
);
CREATE TABLE IF NOT EXISTS global_blocks (
  dev_hash TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);`);

// ---- persistent secrets (session key + VAPID keys), generated once ----
function secret(key, make) {
  const row = db.prepare('SELECT value FROM secrets WHERE key=?').get(key);
  if (row) return row.value;
  const value = make();
  db.prepare('INSERT INTO secrets(key,value) VALUES(?,?)').run(key, value);
  return value;
}
const SESSION_KEY = secret('session', () => crypto.randomBytes(32).toString('hex'));
const vapid = JSON.parse(secret('vapid', () => JSON.stringify(webpush.generateVAPIDKeys())));
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:owner@example.com', vapid.publicKey, vapid.privateKey);

// ---- helpers ----
const now = () => Date.now();
const sign = (s) => crypto.createHmac('sha256', SESSION_KEY).update(s).digest('base64url');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SESSION_DAYS = 30;
function setSession(res, userId) {
  const exp = now() + SESSION_DAYS * 86400000;
  const payload = `${userId}.${exp}`;
  res.cookie('sid', `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 86400000, secure: BASE_URL.startsWith('https://'),
  });
}
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function currentUser(req) {
  const raw = readCookie(req, 'sid');
  if (!raw) return null;
  const [uid, exp, sig] = raw.split('.');
  if (!sig || sign(`${uid}.${exp}`) !== sig || Number(exp) < now()) return null;
  const u = db.prepare('SELECT id,name,phone,role,email,email_verified,lang,quiet_on,quiet_from,quiet_to,valid_after FROM users WHERE id=?').get(Number(uid));
  if (!u) return null;
  // a cookie is issued at (exp - 30 days); a password reset invalidates every older cookie
  if (Number(exp) - SESSION_DAYS * 86400000 < u.valid_after) return null;
  const { valid_after, ...rest } = u;
  return rest;
}
const roleGuard = (role) => (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  if (role && u.role !== role) return res.status(403).json({ error: `This area is for ${role}s` });
  req.user = u;
  next();
};
const auth = roleGuard('owner');
const anyAuth = roleGuard(null);
const providerAuth = roleGuard('provider');
const home = (role) => (role === 'provider' ? '/provider/dashboard' : '/dashboard');

// simple in-memory rate limiter
const hits = new Map();
function limit(name, max, windowMs, perToken = true) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}:${perToken ? req.params.token || '' : ''}`;
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.', code: 'rate' });
    arr.push(t);
    hits.set(key, arr);
    next();
  };
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k); }, 600000).unref();

// Each browser gets a random id cookie. Owners can block it; we only store a keyed hash of it.
function deviceHash(req, res) {
  let id = readCookie(req, 'sd');
  if (!id || !/^[\w-]{16,40}$/.test(id)) {
    id = crypto.randomBytes(16).toString('base64url');
    res.cookie('sd', id, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 86400000, secure: BASE_URL.startsWith('https://') });
  }
  return sign('dev:' + id).slice(0, 22);
}
// anti-spam limits (override in .env if you like)
const MAX_PER_HOUR = Number(process.env.ALERT_MAX_PER_HOUR) || 4;   // new alerts per vehicle, from everyone combined
const MAX_PER_DAY = Number(process.env.ALERT_MAX_PER_DAY) || 12;
const DUPLICATE_MINUTES = 15;                                       // same problem reported again = ignored
const FOLLOWUPS_PER_CONVERSATION = 8;
// push/email at most once per cooldown per vehicle; everything still lands in the inbox
const lastPing = new Map();
function cooldownOk(vehicleId, ms) {
  const t = Date.now();
  if (t - (lastPing.get(vehicleId) || 0) < ms) return false;
  lastPing.set(vehicleId, t);
  return true;
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const normPhone = (p) => clean(p, 20).replace(/[^\d+]/g, '');
// match phones regardless of country-code prefix (+91, 0, none): compare last 10 digits
const last10 = (p) => String(p).replace(/\D/g, '').slice(-10);
const userByPhone = (p) => db.prepare("SELECT * FROM users WHERE substr(replace(replace(phone,'+',''),' ',''), -10)=?").get(last10(p));
const normPlate = (p) => clean(p, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
const maskPlate = (p) => (p.length <= 4 ? p : '•'.repeat(p.length - 4) + p.slice(-4));

const KINDS = {
  wrong_parking: 'Your vehicle is parked in a wrong or blocking spot',
  lights_on: 'Lights / ignition left on',
  window_open: 'Window, door or boot is open',
  towing: 'Vehicle is about to be towed',
  damage: 'Your vehicle may be damaged',
  emergency: 'Emergency - please come immediately',
  other: 'Other message',
  service: 'Service reminder / update',
  reminder: 'Document reminder',
};
const PUBLIC_KINDS = Object.entries(KINDS).filter(([id]) => !['service', 'reminder'].includes(id)).map(([id, text]) => ({ id, text }));

async function pushToUser(userId, payload) {
  const subs = db.prepare('SELECT id,json FROM push_subs WHERE user_id=?').all(userId);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(JSON.parse(s.json), JSON.stringify(payload), { TTL: 86400, urgency: 'high' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id=?').run(s.id);
    }
  }));
}

const userLang = (id) => { const r = db.prepare('SELECT lang FROM users WHERE id=?').get(id); return r && I18N.valid(r.lang) ? r.lang : 'en'; };
const tr = (id, key, vars) => I18N.t(key, vars, userLang(id));

// every owner notification goes out by push AND (if verified + SMTP set up) email. No scanner phone numbers in emails.
const emailBudget = new Map();
async function emailUser(userId, subject, body) {
  if (!mailer) return;
  const u = db.prepare('SELECT email, email_verified FROM users WHERE id=?').get(userId);
  if (!u || !u.email || !u.email_verified) return;
  const t = now();
  const recent = (emailBudget.get(userId) || []).filter((x) => t - x < 3600000);
  if (recent.length >= 20) return; // max 20 emails per owner per hour
  recent.push(t); emailBudget.set(userId, recent);
  await sendMail(u.email, subject,
    `${body}\n\n${tr(userId, 'sv.dash', { url: BASE_URL + '/dashboard' })}\n\n${tr(userId, 'sv.why')}`);
}
function notifyUser(userId, payload) {
  return Promise.all([pushToUser(userId, payload), emailUser(userId, payload.title, payload.body)]);
}

// every person on a vehicle (owner + invited family/drivers) gets the alert on their own phone/email, in their own language
// quiet hours: the alert is still saved in the inbox, it just does not ping (Emergency and Towing always do). Uses the server's clock.
function inQuiet(userId) {
  const u = db.prepare('SELECT quiet_on, quiet_from, quiet_to FROM users WHERE id=?').get(userId);
  if (!u || !u.quiet_on || u.quiet_from === u.quiet_to) return false;
  const h = new Date().getHours();
  return u.quiet_from > u.quiet_to ? (h >= u.quiet_from || h < u.quiet_to) : (h >= u.quiet_from && h < u.quiet_to);
}
function notifyVehicle(vehicleId, make, urgent = false) {
  const ids = db.prepare('SELECT user_id FROM vehicle_access WHERE vehicle_id=?').all(vehicleId).map((r) => r.user_id).filter((id) => urgent || !inQuiet(id));
  return Promise.all(ids.map((id) => notifyUser(id, make(id)).catch(() => {})));
}
const ACCESS = 'SELECT vehicle_id FROM vehicle_access WHERE user_id=?'; // vehicles this person can see

// ---- app ----
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
// photos: the scanner's phone shrinks the picture first (about 100 KB); here we only accept real JPEGs, as small files on disk
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
function readPhoto(str) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(str));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length >= 500 && buf.length <= 380000 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? buf : null;
}
function savePhoto(buf) {
  const name = crypto.randomBytes(16).toString('hex') + '.jpg';
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  return name;
}
// delete photo files that no alert points to any more (alert deleted, vehicle or account deleted, retention purge)
function sweepPhotos() {
  try {
    const keep = new Set(db.prepare("SELECT photo FROM messages WHERE photo<>''").all().map((r) => r.photo));
    for (const f of fs.readdirSync(PHOTO_DIR)) {
      const fp = path.join(PHOTO_DIR, f);
      if (!keep.has(f)) fs.unlinkSync(fp);
    }
  } catch (e) { console.error('Photo cleanup failed:', e.message); }
}
const smallJson = express.json({ limit: '20kb' });
const photoJson = express.json({ limit: '560kb' });
app.use((req, res, next) => (/^\/api\/public\/[^/]+\/alert$/.test(req.path) ? photoJson : smallJson)(req, res, next));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, file) => {
    // pages, styles and scripts are always re-checked so design updates show up immediately
    res.setHeader('Cache-Control', /\.(woff2|png)$/.test(file) ? 'public, max-age=604800' : 'no-cache');
  },
}));

// -- auth --
app.post('/api/register', limit('reg', 10, 3600000), (req, res) => {
  const name = clean(req.body.name, 60);
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Enter a valid phone number' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (userByPhone(phone)) return res.status(409).json({ error: 'This phone is already registered' });
  const role = req.body.role === 'provider' ? 'provider' : 'owner';
  const { salt, hash } = hashPassword(password);
  const id = db.prepare('INSERT INTO users(name,phone,pass_salt,pass_hash,created,role) VALUES(?,?,?,?,?,?)')
    .run(name, phone, salt, hash, now(), role).lastInsertRowid;
  setSession(res, Number(id));
  res.json({ ok: true, next: home(role) });
});

app.post('/api/login', limit('login', 10, 600000), (req, res) => {
  const phone = normPhone(req.body.phone);
  const u = userByPhone(phone);
  if (!u || !checkPassword(String(req.body.password || ''), u.pass_salt, u.pass_hash)) {
    return res.status(401).json({ error: 'Wrong phone or password' });
  }
  setSession(res, u.id);
  res.json({ ok: true, next: home(u.role) });
});

app.post('/api/logout', (req, res) => { res.clearCookie('sid'); res.json({ ok: true }); });
app.get('/api/me', anyAuth, (req, res) => {
  const { email_verified, ...u } = req.user;
  res.json({ ...u, emailVerified: !!email_verified, emailEnabled: SMTP_ON, next: home(req.user.role) });
});
// remembers the language for emails/notifications; harmless for logged-out visitors
app.post('/api/quiet', auth, (req, res) => {
  const hr = (x, d) => (Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 23 ? Number(x) : d);
  db.prepare('UPDATE users SET quiet_on=?, quiet_from=?, quiet_to=? WHERE id=?').run(req.body.on ? 1 : 0, hr(req.body.from, 23), hr(req.body.to, 6), req.user.id);
  res.json({ ok: true });
});
app.post('/api/lang', (req, res) => {
  const l = String((req.body || {}).lang || '');
  const u = currentUser(req);
  if (u && I18N.valid(l)) db.prepare('UPDATE users SET lang=? WHERE id=?').run(l, u.id);
  res.json({ ok: true });
});

// -- owner: vehicles --
const vehicleOut = (v, uid) => ({
  shared: uid !== undefined && v.user_id !== uid, ownerName: v.owner_name || '',
  id: v.id, token: v.token, number: v.number, label: v.label, allowCall: !!v.allow_call, url: `${BASE_URL}/v/${v.token}`,
  insuranceExp: v.insurance_exp, pucExp: v.puc_exp, serviceExp: v.service_exp, awayMsg: v.away_msg, muteUntil: v.mute_until,
});
const dateOrEmpty = (x, old) => (x === undefined ? old : (/^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? String(x) : ''));

app.get('/api/vehicles', auth, (req, res) => {
  res.json(db.prepare(`SELECT v.*, u.name AS owner_name FROM vehicles v JOIN users u ON u.id=v.user_id WHERE v.id IN (${ACCESS}) ORDER BY v.id DESC`)
    .all(req.user.id).map((v) => vehicleOut(v, req.user.id)));
});

app.post('/api/vehicles', auth, (req, res) => {
  const number = normPlate(req.body.number);
  if (number.length < 3) return res.status(400).json({ error: 'Enter the vehicle number' });
  const count = db.prepare('SELECT COUNT(*) c FROM vehicles WHERE user_id=?').get(req.user.id).c;
  if (count >= 20) return res.status(400).json({ error: 'Vehicle limit reached' });
  const token = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO vehicles(user_id,token,number,label,allow_call,created) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, token, number, clean(req.body.label, 40), req.body.allowCall ? 1 : 0, now());
  res.json(vehicleOut(db.prepare('SELECT * FROM vehicles WHERE token=?').get(token)));
});

function ownVehicle(req, res) {
  const v = db.prepare('SELECT * FROM vehicles WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!v) res.status(404).json({ error: 'Not found' });
  return v;
}

app.patch('/api/vehicles/:id', auth, (req, res) => {
  const v = ownVehicle(req, res); if (!v) return;
  const b = req.body;
  const mins = Number(b.muteMinutes);
  const mute = b.muteMinutes === undefined ? v.mute_until : (mins > 0 ? Date.now() + Math.min(mins, 10080) * 60000 : 0);
  db.prepare('UPDATE vehicles SET label=?, allow_call=?, insurance_exp=?, puc_exp=?, service_exp=?, away_msg=?, mute_until=? WHERE id=?').run(
    b.label !== undefined ? clean(b.label, 40) : v.label,
    b.allowCall !== undefined ? (b.allowCall ? 1 : 0) : v.allow_call,
    dateOrEmpty(b.insuranceExp, v.insurance_exp), dateOrEmpty(b.pucExp, v.puc_exp), dateOrEmpty(b.serviceExp, v.service_exp),
    b.awayMsg !== undefined ? clean(b.awayMsg, 120) : v.away_msg, mute, v.id);
  res.json(vehicleOut(db.prepare('SELECT * FROM vehicles WHERE id=?').get(v.id)));
});

app.delete('/api/vehicles/:id', auth, (req, res) => {
  const v = ownVehicle(req, res); if (!v) return;
  db.prepare('DELETE FROM vehicles WHERE id=?').run(v.id);
  sweepPhotos();
  res.json({ ok: true });
});

app.get('/api/vehicles/:id/qr.svg', auth, async (req, res) => {
  const v = db.prepare(`SELECT * FROM vehicles WHERE id=? AND id IN (${ACCESS})`).get(Number(req.params.id), req.user.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const svg = await QRCode.toString(`${BASE_URL}/v/${v.token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// -- people on a vehicle: invite a spouse or driver with a one-time code; they get every alert too --
const MAX_PEOPLE = 5; // owner + 4
const INVITE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const inviteHash = (code) => sign('invite:' + String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''));
app.get('/api/vehicles/:id/people', auth, (req, res) => {
  const v = ownVehicle(req, res); if (!v) return;
  const people = db.prepare('SELECT u.id, u.name, vm.created FROM vehicle_members vm JOIN users u ON u.id=vm.user_id WHERE vm.vehicle_id=? ORDER BY vm.created').all(v.id);
  res.json({ people, max: MAX_PEOPLE });
});
app.post('/api/vehicles/:id/invite', auth, limit('invite', 10, 3600000), (req, res) => {
  const v = ownVehicle(req, res); if (!v) return;
  db.prepare('DELETE FROM vehicle_invites WHERE expires<?').run(now());
  const n = db.prepare('SELECT COUNT(*) c FROM vehicle_members WHERE vehicle_id=?').get(v.id).c;
  if (n + 1 >= MAX_PEOPLE) return res.status(400).json({ error: 'A vehicle can have up to 5 people' });
  db.prepare('DELETE FROM vehicle_invites WHERE vehicle_id=?').run(v.id); // one open invite per vehicle
  let raw = ''; for (let i = 0; i < 8; i++) raw += INVITE_CHARS[crypto.randomInt(INVITE_CHARS.length)];
  db.prepare('INSERT INTO vehicle_invites(code_hash,vehicle_id,created,expires) VALUES(?,?,?,?)').run(inviteHash(raw), v.id, now(), now() + 7 * 86400000);
  res.json({ code: raw.slice(0, 4) + '-' + raw.slice(4), days: 7 });
});
app.delete('/api/vehicles/:id/people/:uid', auth, (req, res) => {
  const v = ownVehicle(req, res); if (!v) return;
  db.prepare('DELETE FROM vehicle_members WHERE vehicle_id=? AND user_id=?').run(v.id, Number(req.params.uid));
  res.json({ ok: true });
});
app.post('/api/vehicles/:id/leave', auth, (req, res) => {
  db.prepare('DELETE FROM vehicle_members WHERE vehicle_id=? AND user_id=?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});
app.post('/api/join', auth, limit('join', 10, 3600000), (req, res) => {
  const bad = () => res.status(400).json({ error: 'Invalid or expired code' });
  const code = String(req.body.code || '');
  if (code.replace(/[^A-Za-z0-9]/g, '').length !== 8) return bad();
  const inv = db.prepare('SELECT * FROM vehicle_invites WHERE code_hash=?').get(inviteHash(code));
  if (!inv || inv.expires < now()) return bad();
  const v = db.prepare('SELECT * FROM vehicles WHERE id=?').get(inv.vehicle_id);
  if (!v) return bad();
  if (v.user_id === req.user.id || db.prepare('SELECT 1 FROM vehicle_members WHERE vehicle_id=? AND user_id=?').get(v.id, req.user.id)) {
    return res.status(400).json({ error: 'You already get alerts for this vehicle' });
  }
  if (db.prepare('SELECT COUNT(*) c FROM vehicle_members WHERE vehicle_id=?').get(v.id).c + 1 >= MAX_PEOPLE) return res.status(400).json({ error: 'A vehicle can have up to 5 people' });
  db.transaction(() => {
    db.prepare('INSERT INTO vehicle_members(vehicle_id,user_id,created) VALUES(?,?,?)').run(v.id, req.user.id, now());
    db.prepare('DELETE FROM vehicle_invites WHERE code_hash=?').run(inv.code_hash);
  })();
  res.json({ ok: true, number: v.label || v.number });
});

// -- owner: inbox --
app.get('/api/messages', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.kind, m.text, m.contact, m.sender, m.created, m.is_read, m.secret, m.lat, m.lng, m.dev_hash, m.silent, m.sender_id, m.photo, v.number, v.label, v.user_id AS owner_id
    FROM messages m JOIN vehicles v ON v.id = m.vehicle_id
    WHERE v.id IN (${ACCESS}) AND m.hidden = 0 ORDER BY m.id DESC LIMIT 100`).all(req.user.id);
  const ids = rows.map((r) => r.id);
  const th = ids.length ? db.prepare(`SELECT message_id, who, text, created FROM thread_msgs WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) : [];
  res.json(rows.map(({ secret, dev_hash, sender_id, owner_id, photo, ...m }) => ({
    ...m, hasPhoto: !!photo, kindText: KINDS[m.kind] || m.kind, isRead: !!m.is_read, canReply: !!secret, silent: !!m.silent,
    // blocking and reporting stay with the vehicle's owner
    canBlock: !!dev_hash && owner_id === req.user.id,
    canReport: owner_id === req.user.id && (!!dev_hash || (m.kind === 'service' && sender_id > 0)),
    thread: th.filter((t) => t.message_id === m.id),
  })));
});
app.get('/api/messages/:id/photo', auth, (req, res) => {
  const m = db.prepare("SELECT photo FROM messages WHERE id=? AND photo<>'' AND vehicle_id IN (" + ACCESS + ')').get(Number(req.params.id), req.user.id);
  if (!m || !/^[a-f0-9]{32}\.jpg$/.test(m.photo)) return res.status(404).json({ error: 'Not found' });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.sendFile(path.join(PHOTO_DIR, m.photo));
});
app.post('/api/messages/:id/block', auth, (req, res) => {
  const m = db.prepare('SELECT m.id, m.dev_hash FROM messages m JOIN vehicles v ON v.id=m.vehicle_id WHERE m.id=? AND v.user_id=?').get(Number(req.params.id), req.user.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (!m.dev_hash) return res.status(400).json({ error: 'This message has no sender to block' });
  db.prepare('INSERT OR IGNORE INTO blocks(user_id,dev_hash,created) VALUES(?,?,?)').run(req.user.id, m.dev_hash, now());
  // hide their earlier messages too, so one tap clears a whole burst
  const hidden = db.prepare('UPDATE messages SET hidden=1 WHERE dev_hash=? AND vehicle_id IN (SELECT id FROM vehicles WHERE user_id=?)').run(m.dev_hash, req.user.id).changes;
  res.json({ ok: true, hidden });
});
app.get('/api/blocks', auth, (req, res) => {
  res.json({ count: db.prepare('SELECT COUNT(*) c FROM blocks WHERE user_id=?').get(req.user.id).c });
});
app.delete('/api/blocks', auth, (req, res) => {
  db.prepare('DELETE FROM blocks WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});
app.post('/api/messages/:id/reply', auth, limit('reply', 30, 600000), (req, res) => {
  const text = clean(req.body.text, 300);
  if (!text) return res.status(400).json({ error: 'Type a reply' });
  const m = db.prepare('SELECT m.id, m.secret FROM messages m WHERE m.id=? AND m.vehicle_id IN (' + ACCESS + ')').get(Number(req.params.id), req.user.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (!m.secret) return res.status(400).json({ error: 'You cannot reply to this message' });
  db.prepare('INSERT INTO thread_msgs(message_id,who,text,created) VALUES(?,?,?,?)').run(m.id, 'owner', text, now());
  db.prepare('UPDATE messages SET is_read=1 WHERE id=?').run(m.id);
  res.json({ ok: true });
});
app.post('/api/messages/read', auth, (req, res) => {
  db.prepare('UPDATE messages SET is_read=1 WHERE vehicle_id IN (' + ACCESS + ')').run(req.user.id);
  res.json({ ok: true });
});
app.delete('/api/messages/:id', auth, (req, res) => {
  db.prepare('DELETE FROM messages WHERE id=? AND vehicle_id IN (' + ACCESS + ')').run(Number(req.params.id), req.user.id);
  sweepPhotos();
  res.json({ ok: true });
});

// -- owner: push notifications (free, built into browsers) --
app.get('/api/push/key', auth, (req, res) => res.json({ key: vapid.publicKey }));
app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: 'Bad subscription' });
  db.prepare('INSERT INTO push_subs(user_id,endpoint,json) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, json=excluded.json')
    .run(req.user.id, sub.endpoint, JSON.stringify(sub));
  res.json({ ok: true });
});

// -- owner: email alerts (verified with a 6-digit code) --
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
app.post('/api/email/start', auth, limit('emailstart', 5, 3600000), async (req, res) => {
  if (!mailer) return res.status(503).json({ error: 'Email is not set up on this server yet' });
  const email = clean(req.body.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT INTO email_codes(user_id,email,code_hash,expires,attempts) VALUES(?,?,?,?,0)
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, code_hash=excluded.code_hash, expires=excluded.expires, attempts=0`)
    .run(req.user.id, email, sign(`email:${req.user.id}:${code}`), now() + 10 * 60000);
  const ok = await sendMail(email, tr(req.user.id, 'sv.code.subj'), tr(req.user.id, 'sv.code.body', { c: code }));
  if (!ok) return res.status(502).json({ error: 'Could not send the email. Check the email settings on the server.' });
  res.json({ ok: true });
});
app.post('/api/email/verify', auth, limit('emailverify', 20, 3600000), (req, res) => {
  const row = db.prepare('SELECT * FROM email_codes WHERE user_id=?').get(req.user.id);
  if (!row || row.expires < now()) return res.status(400).json({ error: 'Code expired. Ask for a new one.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many wrong codes. Ask for a new one.' });
  if (!safeEq(sign(`email:${req.user.id}:${String(req.body.code || '').trim()}`), row.code_hash)) {
    db.prepare('UPDATE email_codes SET attempts=attempts+1 WHERE user_id=?').run(req.user.id);
    return res.status(400).json({ error: 'Wrong code' });
  }
  db.prepare('UPDATE users SET email=?, email_verified=1 WHERE id=?').run(row.email, req.user.id);
  db.prepare('DELETE FROM email_codes WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});
app.delete('/api/email', auth, (req, res) => {
  db.prepare("UPDATE users SET email='', email_verified=0 WHERE id=?").run(req.user.id);
  db.prepare('DELETE FROM email_codes WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

// ---- delete a user and everything that belongs to them (vehicles, messages, push, customers, blocks cascade) ----
function deleteUser(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM reports WHERE reporter_id=? OR target_user_id=?').run(id, id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
  })();
  emailBudget.delete(id);
  sweepPhotos();
}

// -- forgot password: a 6-digit code goes to the owner's VERIFIED email (same free SMTP as alerts) --
const resetBudget = new Map();
app.post('/api/reset/start', limit('resetstart', 5, 3600000), (req, res) => {
  const done = { ok: true }; // identical answer whether or not the account exists, so numbers cannot be probed
  const u = mailer && userByPhone(normPhone(req.body.phone));
  if (!u || !u.email || !u.email_verified) return res.json(done);
  const t = now();
  const recent = (resetBudget.get(u.id) || []).filter((x) => t - x < 3600000);
  if (recent.length >= 3) return res.json(done);
  recent.push(t); resetBudget.set(u.id, recent);
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT INTO reset_codes(user_id,code_hash,expires,attempts) VALUES(?,?,?,0)
    ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0`)
    .run(u.id, sign(`reset:${u.id}:${code}`), t + 10 * 60000);
  sendMail(u.email, tr(u.id, 'sv.reset.subj'), tr(u.id, 'sv.reset.body', { c: code })).catch(() => {});
  res.json(done);
});
app.post('/api/reset/finish', limit('resetfinish', 10, 3600000), (req, res) => {
  const bad = () => res.status(400).json({ error: 'That code is wrong or has expired. Ask for a new one.' });
  const password = String(req.body.password || '');
  const u = userByPhone(normPhone(req.body.phone));
  const row = u && db.prepare('SELECT * FROM reset_codes WHERE user_id=?').get(u.id);
  if (!row || row.expires < now() || row.attempts >= 5) return bad();
  if (!safeEq(sign(`reset:${u.id}:${String(req.body.code || '').trim()}`), row.code_hash)) {
    db.prepare('UPDATE reset_codes SET attempts=attempts+1 WHERE user_id=?').run(u.id);
    return bad();
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const { salt, hash } = hashPassword(password);
  // valid_after signs out every device that was logged in with the old password
  db.prepare('UPDATE users SET pass_salt=?, pass_hash=?, valid_after=? WHERE id=?').run(salt, hash, now(), u.id);
  db.prepare('DELETE FROM reset_codes WHERE user_id=?').run(u.id);
  if (u.email && u.email_verified) {
    sendMail(u.email, tr(u.id, 'sv.changed.subj'), tr(u.id, 'sv.changed.body')).catch(() => {});
  }
  res.json({ ok: true });
});

// -- report an alert (spam, prank, abuse). Blocks and hides it for this owner; repeat offenders are banned site-wide --
const AUTO_BAN_REPORTS = Number(process.env.AUTO_BAN_REPORTS) || 3; // different owners who must report the same sender
const REPORT_REASONS = { spam: 'Spam or prank', abuse: 'Abusive or threatening', fake: 'Fake emergency', other: 'Other' };
app.post('/api/messages/:id/report', auth, limit('report', 20, 3600000, false), (req, res) => {
  const m = db.prepare('SELECT m.id, m.kind, m.text, m.dev_hash, m.sender_id FROM messages m JOIN vehicles v ON v.id=m.vehicle_id WHERE m.id=? AND v.user_id=?')
    .get(Number(req.params.id), req.user.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const fromProvider = m.kind === 'service' && m.sender_id > 0;
  if (!m.dev_hash && !fromProvider) return res.status(400).json({ error: 'This message cannot be reported' });
  const reason = REPORT_REASONS[req.body.reason] || REPORT_REASONS.other;
  db.prepare('INSERT OR IGNORE INTO reports(reporter_id,dev_hash,target_user_id,kind,text,reason,created) VALUES(?,?,?,?,?,?,?)')
    .run(req.user.id, m.dev_hash || '', fromProvider ? m.sender_id : 0, m.kind, m.text, reason, now());
  if (m.dev_hash) {
    db.prepare('INSERT OR IGNORE INTO blocks(user_id,dev_hash,created) VALUES(?,?,?)').run(req.user.id, m.dev_hash, now());
    db.prepare('UPDATE messages SET hidden=1 WHERE dev_hash=? AND vehicle_id IN (SELECT id FROM vehicles WHERE user_id=?)').run(m.dev_hash, req.user.id);
    const owners = db.prepare("SELECT COUNT(DISTINCT reporter_id) c FROM reports WHERE dev_hash=? AND status<>'dismissed'").get(m.dev_hash).c;
    if (owners >= AUTO_BAN_REPORTS) {
      db.prepare('INSERT OR IGNORE INTO global_blocks(dev_hash,reason,created) VALUES(?,?,?)').run(m.dev_hash, `auto: reported by ${owners} owners`, now());
    }
  } else {
    db.prepare('UPDATE messages SET hidden=1 WHERE id=?').run(m.id); // provider messages: hide, admin decides
  }
  res.json({ ok: true });
});

// -- your data: download a copy, or delete the account for good --
function exportData(userId) {
  const u = db.prepare('SELECT name,phone,role,email,email_verified,created FROM users WHERE id=?').get(userId);
  const vehicles = db.prepare('SELECT id,number,label,allow_call,insurance_exp,puc_exp,service_exp,away_msg,created FROM vehicles WHERE user_id=?').all(userId);
  const msgs = db.prepare(`SELECT m.id,m.kind,m.text,m.contact,m.sender,m.lat,m.lng,m.created,m.hidden,v.number
    FROM messages m JOIN vehicles v ON v.id=m.vehicle_id WHERE v.user_id=? ORDER BY m.id`).all(userId);
  const th = db.prepare(`SELECT t.message_id,t.who,t.text,t.created FROM thread_msgs t JOIN messages m ON m.id=t.message_id
    JOIN vehicles v ON v.id=m.vehicle_id WHERE v.user_id=? ORDER BY t.id`).all(userId);
  return {
    exportedAt: new Date().toISOString(),
    account: { ...u, email_verified: !!u.email_verified, created: new Date(u.created).toISOString() },
    vehicles, messages: msgs.map((m) => ({ ...m, thread: th.filter((t) => t.message_id === m.id) })),
    customers: u.role === 'provider' ? db.prepare('SELECT name,number,note,created FROM customers WHERE provider_id=?').all(userId) : undefined,
    blockedSenders: db.prepare('SELECT COUNT(*) c FROM blocks WHERE user_id=?').get(userId).c,
  };
}
app.get('/api/account/export', anyAuth, limit('export', 10, 3600000, false), (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="my-vehicleassist-data.json"');
  res.json(exportData(req.user.id));
});

// the same data as a readable PDF (English, Hindi, Marathi, Gujarati and Tamil text all draw correctly)
const PDFDocument = require('pdfkit');
const FONTS = path.join(__dirname, 'fonts');
app.get('/api/account/export.pdf', anyAuth, limit('exportpdf', 10, 3600000, false), (req, res) => {
  const d = exportData(req.user.id);
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: 'My VehicleAssist data', Author: 'VehicleAssist' } });
  doc.registerFont('L', path.join(FONTS, 'hanken-400.ttf'));
  doc.registerFont('LB', path.join(FONTS, 'hanken-700.ttf'));
  doc.registerFont('D', path.join(FONTS, 'noto-dev-400.ttf'));
  doc.registerFont('DB', path.join(FONTS, 'noto-dev-600.ttf'));
  doc.registerFont('G', path.join(FONTS, 'noto-guj-400.ttf'));
  doc.registerFont('GB', path.join(FONTS, 'noto-guj-600.ttf'));
  doc.registerFont('M', path.join(FONTS, 'noto-tam-400.ttf'));
  doc.registerFont('MB', path.join(FONTS, 'noto-tam-600.ttf'));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="my-vehicleassist-data.pdf"' });
  doc.pipe(res);

  const INK = '#14181d', MUTE = '#5d6670', BRAND = '#0a3d91', LINE = '#d6d9d2';
  const when = (t) => new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  // Write text one word at a time, picking the Hindi font for Devanagari and the Latin font for everything else.
  // (pdfkit cannot wrap lines that mix two fonts, so the wrapping is done here.)
  const put = (str, { bold = false, size = 10, color = INK, indent = 0, gap = 0 } = {}) => {
    const left = doc.page.margins.left + indent, right = doc.page.width - doc.page.margins.right, lh = size * 1.5;
    const maxW = right - left;
    // Hindi/Marathi (Devanagari), Gujarati and Tamil each get their own font; everything else uses the Latin font
    const fontFor = (seg) => {
      const f = /[ऀ-ॿ]/.test(seg) ? 'D' : /[઀-૿]/.test(seg) ? 'G' : /[஀-௿]/.test(seg) ? 'M' : 'L';
      return bold ? f + 'B' : f;
    };
    const segsOf = (w) => w.split(/([ऀ-ॿ઀-૿஀-௿‌‍]+)/).filter(Boolean);
    const widthOf = (segs) => segs.reduce((a, sg) => a + doc.font(fontFor(sg)).fontSize(size).widthOfString(sg), 0);
    doc.fontSize(size).fillColor(color);
    let x = left, y = doc.y;
    const newLine = () => { x = left; y += lh; if (y + lh > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; } };
    if (y + lh > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
    const spW = doc.font(bold ? 'LB' : 'L').fontSize(size).widthOfString(' ');
    const words = String(str ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const draw = (segs) => segs.forEach((sg) => { doc.font(fontFor(sg)).fontSize(size).fillColor(color).text(sg, x, y, { lineBreak: false }); x += doc.widthOfString(sg); });
    words.forEach((w, wi) => {
      let pieces = [w];
      if (widthOf(segsOf(w)) > maxW) { // a single very long word: cut it into pieces that fit
        pieces = []; let cur = '';
        for (const ch of w) { if (widthOf(segsOf(cur + ch)) > maxW && cur) { pieces.push(cur); cur = ''; } cur += ch; }
        if (cur) pieces.push(cur);
      }
      pieces.forEach((pc, pi) => {
        const segs = segsOf(pc), wd = widthOf(segs);
        if (wi === 0 && pi === 0) { /* first word starts the line */ }
        else if (pi > 0 || x + spW + wd > right) { if (x > left) newLine(); }
        else x += spW;
        draw(segs);
      });
    });
    doc.x = doc.page.margins.left; doc.y = y + lh;
    if (gap) doc.moveDown(gap);
  };
  const heading = (t) => {
    doc.moveDown(1.1);
    if (doc.y > doc.page.height - 140) doc.addPage();
    put(t, { bold: true, size: 14, color: BRAND });
    const y = doc.y + 2; doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(LINE).lineWidth(1).stroke(); doc.moveDown(0.6);
  };
  const kv = (k, v) => { if (v === '' || v == null) return; put(`${k}: ${v}`); };
  const KIND = Object.fromEntries(Object.entries(KINDS));

  put('My VehicleAssist data', { bold: true, size: 22, gap: 0.2 });
  put(`Created ${when(Date.now())}. This is a copy of what is stored about your account.`, { color: MUTE, size: 9 });

  heading('Account');
  kv('Name', d.account.name); kv('Phone', d.account.phone);
  kv('Account type', d.account.role === 'provider' ? 'Service provider' : 'Vehicle owner');
  kv('Email', d.account.email ? `${d.account.email}${d.account.email_verified ? ' (verified)' : ' (not verified)'}` : '');
  kv('Joined', when(d.account.created)); kv('Blocked senders', d.blockedSenders);

  if (d.account.role === 'owner') {
    heading(`Vehicles (${d.vehicles.length})`);
    if (!d.vehicles.length) put('No vehicles.', { color: MUTE });
    d.vehicles.forEach((v) => {
      put(v.number + (v.label ? `  -  ${v.label}` : ''), { bold: true, size: 11 });
      kv('"Call owner" button', v.allow_call ? 'shown to people who scan' : 'hidden');
      kv('Insurance expiry', v.insurance_exp); kv('PUC expiry', v.puc_exp); kv('Next service', v.service_exp);
      kv('Away note', v.away_msg); kv('Added', when(v.created)); doc.moveDown(0.6);
    });

    heading(`Alerts and conversations (${d.messages.length})`);
    if (!d.messages.length) put('No alerts stored.', { color: MUTE });
    d.messages.forEach((m) => {
      if (doc.y > doc.page.height - 130) doc.addPage();
      const title = m.kind === 'service' ? `Service update from ${m.sender}` : (KIND[m.kind] || m.kind);
      put(title, { bold: true });
      put(`${when(m.created)}  |  ${m.number}${m.hidden ? '  |  hidden (blocked or reported sender)' : ''}`, { color: MUTE, size: 8.5 });
      if (m.text) put(m.text);
      if (m.contact) put(`Phone the sender typed in: ${m.contact}`);
      if (m.lat != null) put(`Location shared: ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`);
      m.thread.forEach((t) => put(`${t.who === 'owner' ? 'You' : 'Them'} (${when(t.created)}): ${t.text}`, { indent: 14, size: 9, color: MUTE }));
      doc.moveDown(0.7);
    });
  } else {
    heading(`Customers (${(d.customers || []).length})`);
    if (!(d.customers || []).length) put('No customers.', { color: MUTE });
    (d.customers || []).forEach((c) => {
      put(`${c.name}  -  ${c.number}`, { bold: true });
      if (c.note) put(c.note, { color: MUTE, size: 9 });
      doc.moveDown(0.5);
    });
  }

  // page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // otherwise writing in the footer area starts a new page
    doc.font('L').fontSize(8).fillColor(MUTE).text(`VehicleAssist  |  page ${i + 1} of ${range.count}`, 50, doc.page.height - 34, { width: doc.page.width - 100, align: 'center', lineBreak: false });
  }
  doc.end();
});
app.delete('/api/account', anyAuth, limit('delacct', 5, 3600000, false), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  // 400, not 401/403, so the page shows "wrong password" instead of bouncing to the login screen
  if (!checkPassword(String(req.body.password || ''), u.pass_salt, u.pass_hash)) return res.status(400).json({ error: 'Wrong password' });
  deleteUser(u.id);
  res.clearCookie('sid');
  res.json({ ok: true });
});
app.get('/api/site', (req, res) => {
  res.json({ contactEmail: process.env.CONTACT_EMAIL || '', retentionDays: RETENTION_DAYS, emailEnabled: SMTP_ON });
});

// ---- admin (optional): set ADMIN_PASSWORD in .env, then open /admin ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const adminSig = (exp) => sign(`admin:${exp}:${sign(ADMIN_PASSWORD)}`);
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const raw = readCookie(req, 'adm');
  const [exp, sig] = (raw || '').split('.');
  return !!sig && Number(exp) > now() && safeEq(adminSig(exp), sig);
}
const adminGuard = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Admin login required' }));
app.post('/api/admin/login', limit('adminlogin', 5, 600000, false), (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin is off. Set ADMIN_PASSWORD in the .env file and restart.' });
  if (!safeEq(sign('pw:' + String(req.body.password || '')), sign('pw:' + ADMIN_PASSWORD))) return res.status(400).json({ error: 'Wrong password' });
  const exp = now() + 8 * 3600000;
  res.cookie('adm', `${exp}.${adminSig(exp)}`, { httpOnly: true, sameSite: 'strict', maxAge: 8 * 3600000, secure: BASE_URL.startsWith('https://') });
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('adm'); res.json({ ok: true }); });
app.get('/api/admin/overview', adminGuard, (req, res) => {
  const c = (sql, ...a) => db.prepare(sql).get(...a).c;
  res.json({
    owners: c("SELECT COUNT(*) c FROM users WHERE role='owner'"), providers: c("SELECT COUNT(*) c FROM users WHERE role='provider'"),
    vehicles: c('SELECT COUNT(*) c FROM vehicles'), alerts24h: c("SELECT COUNT(*) c FROM messages WHERE created>? AND kind NOT IN ('service','reminder')", now() - 86400000),
    openReports: c("SELECT COUNT(*) c FROM reports WHERE status='open'"), bannedDevices: c('SELECT COUNT(*) c FROM global_blocks'),
    backupDir: BACKUP_DIR, backups: backup.listBackups(BACKUP_DIR).slice(0, 5), retentionDays: RETENTION_DAYS, autoBanAfter: AUTO_BAN_REPORTS,
  });
});
app.get('/api/admin/reports', adminGuard, (req, res) => {
  res.json(db.prepare(`SELECT r.id, r.created, r.status, r.reason, r.kind, r.text, r.dev_hash, r.target_user_id,
      ru.name AS reporter_name, ru.phone AS reporter_phone, tu.name AS target_name, tu.role AS target_role,
      (SELECT COUNT(DISTINCT x.reporter_id) FROM reports x WHERE r.dev_hash<>'' AND x.dev_hash=r.dev_hash) AS reporters,
      EXISTS(SELECT 1 FROM global_blocks g WHERE r.dev_hash<>'' AND g.dev_hash=r.dev_hash) AS banned
    FROM reports r LEFT JOIN users ru ON ru.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.target_user_id
    ORDER BY (r.status='open') DESC, r.id DESC LIMIT 200`).all()
    .map(({ dev_hash, banned, ...r }) => ({ ...r, hasDevice: !!dev_hash, banned: !!banned })));
});
app.post('/api/admin/reports/:id/ban', adminGuard, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.dev_hash) {
    db.prepare('INSERT OR IGNORE INTO global_blocks(dev_hash,reason,created) VALUES(?,?,?)').run(r.dev_hash, 'admin', now());
    db.prepare("UPDATE reports SET status='actioned' WHERE dev_hash=?").run(r.dev_hash);
  } else db.prepare("UPDATE reports SET status='actioned' WHERE id=?").run(r.id);
  res.json({ ok: true });
});
app.post('/api/admin/reports/:id/dismiss', adminGuard, (req, res) => {
  db.prepare("UPDATE reports SET status='dismissed' WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});
app.get('/api/admin/bans', adminGuard, (req, res) => {
  res.json(db.prepare('SELECT dev_hash, reason, created FROM global_blocks ORDER BY created DESC LIMIT 200').all());
});
app.post('/api/admin/bans/remove', adminGuard, (req, res) => {
  db.prepare('DELETE FROM global_blocks WHERE dev_hash=?').run(String(req.body.dev_hash || ''));
  res.json({ ok: true });
});
app.get('/api/admin/users', adminGuard, (req, res) => {
  const q = `%${clean(req.query.q, 40)}%`;
  res.json(db.prepare(`SELECT id,name,phone,role,email,email_verified,created,
      (SELECT COUNT(*) FROM vehicles v WHERE v.user_id=users.id) AS vehicles
    FROM users WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY id DESC LIMIT 100`).all(q, q, q)
    .map(({ email_verified, ...u }) => ({ ...u, emailVerified: !!email_verified })));
});
app.post('/api/admin/users/:id/delete', adminGuard, (req, res) => {
  deleteUser(Number(req.params.id));
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/password', adminGuard, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const temp = crypto.randomBytes(6).toString('base64url');
  const { salt, hash } = hashPassword(temp);
  db.prepare('UPDATE users SET pass_salt=?, pass_hash=?, valid_after=? WHERE id=?').run(salt, hash, now(), id);
  res.json({ ok: true, password: temp });
});
app.post('/api/admin/backup', adminGuard, async (req, res) => {
  try { const r = await backup.runBackup(db, BACKUP_DIR, BACKUP_KEEP); res.json({ ok: true, file: r.file, size: r.size }); }
  catch (e) { res.status(500).json({ error: 'Backup failed: ' + e.message }); }
});

// -- public (scanner) side: no login, no owner phone unless owner opted in --
app.get('/api/public/:token', limit('pubinfo', 60, 600000), (req, res) => {
  const v = db.prepare('SELECT v.*, u.phone FROM vehicles v JOIN users u ON u.id=v.user_id WHERE v.token=?').get(req.params.token);
  if (!v) return res.status(404).json({ error: 'This sticker is not registered' });
  deviceHash(req, res);
  res.json({
    number: maskPlate(v.number), label: v.label, allowCall: !!v.allow_call, awayMsg: v.away_msg,
    phone: v.allow_call ? v.phone : null,
    kinds: PUBLIC_KINDS,
  });
});

// Contact by vehicle number (no sticker needed). Returns only what the scan page needs.
app.post('/api/contact/lookup', limit('lookup', 15, 600000), (req, res) => {
  const number = normPlate(req.body.number);
  const v = number.length >= 3 && db.prepare('SELECT v.token FROM vehicles v WHERE v.number=?').get(number);
  if (!v) return res.status(404).json({ error: 'This vehicle is not registered on the app yet' });
  res.json({ token: v.token });
});

app.post('/api/public/:token/alert', limit('alert', 5, 600000), limit('alertday', 30, 86400000, false), async (req, res) => {
  const v = db.prepare('SELECT * FROM vehicles WHERE token=?').get(req.params.token);
  if (!v) return res.status(404).json({ error: 'This sticker is not registered' });
  const kind = String(req.body.kind || '');
  if (!KINDS[kind] || ['service', 'reminder'].includes(kind)) return res.status(400).json({ error: 'Pick a reason' });
  const text = clean(req.body.text, 300);
  const contact = normPhone(req.body.contact);
  if (kind === 'other' && !text) return res.status(400).json({ error: 'Please type a message' });
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && req.body.lat !== null && req.body.lat !== '';
  const dev = deviceHash(req, res);
  const t = now();
  const secret = crypto.randomBytes(12).toString('base64url');
  let photoBuf = null, photoFile = '';
  if (req.body.photo) { photoBuf = readPhoto(req.body.photo); if (!photoBuf) return res.status(400).json({ error: 'That photo could not be used' }); }
  const insert = (silent, hidden) => db.prepare(
    'INSERT INTO messages(vehicle_id,kind,text,contact,created,secret,lat,lng,dev_hash,silent,hidden,photo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(v.id, kind, text, contact, t, secret, hasLoc ? lat : null, hasLoc ? lng : null, dev, silent, hidden, photoFile);

  // 1. blocked sender (by this owner, or banned site-wide after reports): look like it worked, but the owner never sees it
  if (db.prepare('SELECT 1 FROM global_blocks WHERE dev_hash=?').get(dev)
    || db.prepare('SELECT 1 FROM blocks WHERE user_id=? AND dev_hash=?').get(v.user_id, dev)) {
    insert(0, 1);
    return res.json({ ok: true, thread: secret });
  }
  // 2. hard cap per vehicle, whoever is sending (switching phones or networks does not help)
  const counted = "vehicle_id=? AND hidden=0 AND kind NOT IN ('service','reminder') AND created>?";
  const lastHour = db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${counted}`).get(v.id, t - 3600000).c;
  const lastDay = db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${counted}`).get(v.id, t - 86400000).c;
  if (lastHour >= MAX_PER_HOUR || lastDay >= MAX_PER_DAY) {
    return res.status(429).json({ error: 'This vehicle has had several alerts recently. Please wait a while before sending another.', code: 'vehicle_cap' });
  }
  // 3. the same problem was already reported a moment ago
  if (kind !== 'other' && db.prepare('SELECT 1 FROM messages WHERE vehicle_id=? AND hidden=0 AND kind=? AND created>?').get(v.id, kind, t - DUPLICATE_MINUTES * 60000)) {
    return res.json({ ok: true, duplicate: true });
  }
  // 4. owner paused alerts: save quietly, no push or email
  const muted = v.mute_until > t;
  if (photoBuf) photoFile = savePhoto(photoBuf); // only stored for alerts that reach the owner
  insert(muted ? 1 : 0, 0);
  // 5. at most one push/email every 2 minutes per vehicle; the inbox always has everything
  const urgent = kind === 'emergency' || kind === 'towing';
  if (!muted && (urgent || cooldownOk(v.id, 120000))) { // urgent alerts always go out
    notifyVehicle(v.id, (uid) => ({
      title: tr(uid, 'sv.alert', { v: v.label || v.number }),
      body: text ? `${tr(uid, 'kind.' + kind)}: ${text}` : tr(uid, 'kind.' + kind),
    }), urgent);
  }
  res.json({ ok: true, thread: secret, muted });
});

// -- a customer who is not on the app can have their vehicle number taken off every garage's list, and kept off --
app.post('/api/remove-number', limit('removenum', 5, 3600000), (req, res) => {
  const number = normPlate(req.body.number);
  if (number.length < 3) return res.status(400).json({ error: 'Enter the vehicle number' });
  if (db.prepare('SELECT 1 FROM vehicles WHERE number=?').get(number)) return res.json({ ok: true, registered: true }); // registered owners manage this themselves
  db.transaction(() => {
    db.prepare('DELETE FROM customers WHERE number=?').run(number);
    db.prepare('INSERT OR IGNORE INTO removed_numbers(number,created) VALUES(?,?)').run(number, now());
  })();
  res.json({ ok: true });
});

// -- service providers: manage customers, send reminders/updates to registered owners --
const customerOut = (c) => ({
  id: c.id, name: c.name, number: c.number, note: c.note, onApp: !!c.vid,
});
const customerQuery = 'SELECT c.*, (SELECT v.id FROM vehicles v WHERE v.number=c.number) AS vid FROM customers c';

app.get('/api/provider/customers', providerAuth, (req, res) => {
  res.json(db.prepare(`${customerQuery} WHERE c.provider_id=? ORDER BY c.id DESC`).all(req.user.id).map(customerOut));
});
app.post('/api/provider/customers', providerAuth, (req, res) => {
  const number = normPlate(req.body.number);
  const name = clean(req.body.name, 60);
  if (number.length < 3) return res.status(400).json({ error: 'Enter the vehicle number' });
  if (db.prepare('SELECT 1 FROM removed_numbers WHERE number=?').get(number) && !db.prepare('SELECT 1 FROM vehicles WHERE number=?').get(number)) {
    return res.status(400).json({ error: 'This vehicle owner asked not to be listed' });
  }
  if (!name) return res.status(400).json({ error: 'Enter the customer name' });
  try {
    db.prepare('INSERT INTO customers(provider_id,name,number,note,created) VALUES(?,?,?,?,?)')
      .run(req.user.id, name, number, clean(req.body.note, 120), now());
  } catch (_) { return res.status(409).json({ error: 'You already added this vehicle' }); }
  res.json({ ok: true });
});
app.delete('/api/provider/customers/:id', providerAuth, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id=? AND provider_id=?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});
app.post('/api/provider/customers/:id/notify', providerAuth, limit('notify', 30, 3600000), async (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=? AND provider_id=?').get(Number(req.params.id), req.user.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const text = clean(req.body.text, 300);
  if (!text) return res.status(400).json({ error: 'Type a message' });
  const v = db.prepare('SELECT * FROM vehicles WHERE number=?').get(c.number);
  if (!v) return res.status(404).json({ error: 'This owner has not registered the vehicle on the app yet' });
  db.prepare('INSERT INTO messages(vehicle_id,kind,text,sender,sender_id,created) VALUES(?,?,?,?,?,?)').run(v.id, 'service', text, req.user.name, req.user.id, now());
  notifyVehicle(v.id, (uid) => ({ title: tr(uid, 'sv.service', { n: req.user.name }), body: text }));
  res.json({ ok: true });
});

// -- scanner side of a conversation: the secret link is the scanner's only credential --
function threadFor(token) {
  return db.prepare('SELECT m.*, v.number, v.user_id, v.mute_until FROM messages m JOIN vehicles v ON v.id=m.vehicle_id WHERE m.secret=? AND m.secret<>\'\'').get(token);
}
app.get('/api/thread/:token', limit('thread', 120, 600000), (req, res) => {
  const m = threadFor(req.params.token);
  if (!m) return res.status(404).json({ error: 'Conversation not found' });
  res.json({
    number: maskPlate(m.number), kind: m.kind, kindText: KINDS[m.kind], text: m.text, created: m.created,
    msgs: db.prepare('SELECT who, text, created FROM thread_msgs WHERE message_id=? ORDER BY id').all(m.id),
  });
});
app.post('/api/thread/:token', limit('followup', 20, 600000), (req, res) => {
  const m = threadFor(req.params.token);
  if (!m) return res.status(404).json({ error: 'Conversation not found' });
  const text = clean(req.body.text, 300);
  if (!text) return res.status(400).json({ error: 'Type a message' });
  const sent = db.prepare("SELECT COUNT(*) c FROM thread_msgs WHERE message_id=? AND who='scanner'").get(m.id).c;
  if (sent >= FOLLOWUPS_PER_CONVERSATION) return res.status(429).json({ error: 'Message limit reached for this conversation.', code: 'thread_cap' });
  db.prepare('INSERT INTO thread_msgs(message_id,who,text,created) VALUES(?,?,?,?)').run(m.id, 'scanner', text, now());
  if (!m.hidden) { // blocked senders can keep typing, nobody is told
    db.prepare('UPDATE messages SET is_read=0 WHERE id=?').run(m.id);
    if (m.mute_until <= now() && cooldownOk(m.vehicle_id, 60000)) {
      notifyVehicle(m.vehicle_id, (uid) => ({ title: tr(uid, 'sv.reply', { n: m.number }), body: text }));
    }
  }
  res.json({ ok: true });
});

// -- urgent alerts nobody has opened are sent again to everyone on the vehicle, so one missed phone is not the end --
const ESCALATE_MIN = process.env.ESCALATE_MINUTES === undefined ? 5 : Number(process.env.ESCALATE_MINUTES);
function runEscalation() {
  if (!(ESCALATE_MIN > 0)) return;
  const t = now();
  const rows = db.prepare(`SELECT m.id, m.kind, m.text, m.vehicle_id, v.number, v.label FROM messages m JOIN vehicles v ON v.id=m.vehicle_id
    WHERE m.kind IN ('emergency','towing') AND m.is_read=0 AND m.hidden=0 AND m.silent=0 AND m.escalated=0 AND m.created<? AND m.created>?`)
    .all(t - ESCALATE_MIN * 60000, t - 6 * 3600000);
  for (const m of rows) {
    db.prepare('UPDATE messages SET escalated=1 WHERE id=?').run(m.id);
    notifyVehicle(m.vehicle_id, (uid) => ({
      title: tr(uid, 'sv.again', { t: tr(uid, 'sv.alert', { v: m.label || m.number }) }),
      body: m.text ? `${tr(uid, 'kind.' + m.kind)}: ${m.text}` : tr(uid, 'kind.' + m.kind),
    }));
  }
}
setInterval(() => { try { runEscalation(); } catch (e) { console.error(e); } }, 60000).unref();

// -- document expiry reminders (insurance / PUC / service), checked at start and every 6h --
const REM_FIELDS = { insurance_exp: 'Insurance', puc_exp: 'PUC certificate', service_exp: 'Service' };
const REM_KEY = { insurance_exp: 'insurance', puc_exp: 'puc', service_exp: 'service' };
function runReminders() {
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  for (const v of db.prepare('SELECT * FROM vehicles').all()) {
    for (const [col, name] of Object.entries(REM_FIELDS)) {
      const exp = v[col];
      if (!exp) continue;
      const days = Math.round((Date.parse(exp + 'T00:00:00Z') - today) / 86400000);
      const threshold = [0, 1, 7, 30].find((t) => days <= t);
      if (threshold === undefined) continue;
      const fresh = db.prepare('INSERT OR IGNORE INTO reminders_sent(vehicle_id,field,exp,threshold) VALUES(?,?,?,?)').run(v.id, col, exp, threshold).changes;
      if (!fresh) continue;
      const when = (uid) => days < 0 ? tr(uid, 'sv.exp.past', { d: exp }) : days === 0 ? tr(uid, 'sv.exp.today') : days === 1 ? tr(uid, 'sv.exp.tomorrow') : tr(uid, 'sv.exp.days', { n: days, d: exp });
      const textFor = (uid) => tr(uid, 'sv.rem', { doc: tr(uid, 'sv.doc.' + REM_KEY[col]), veh: v.label || v.number, when: when(uid) });
      const text = textFor(v.user_id);
      db.prepare('INSERT INTO messages(vehicle_id,kind,text,sender,created) VALUES(?,?,?,?,?)').run(v.id, 'reminder', text, 'VehicleAssist', now());
      notifyVehicle(v.id, (uid) => ({ title: tr(uid, 'sv.reminder'), body: textFor(uid) }));
    }
  }
}
runReminders();
setInterval(() => { try { runReminders(); } catch (e) { console.error(e); } }, 6 * 3600000).unref();

// ---- daily housekeeping: backup first, then delete expired data ----
function purgeOld() {
  const t = now();
  if (RETENTION_DAYS > 0) db.prepare('DELETE FROM messages WHERE created<?').run(t - RETENTION_DAYS * 86400000);
  db.prepare('DELETE FROM email_codes WHERE expires<?').run(t);
  db.prepare('DELETE FROM reset_codes WHERE expires<?').run(t);
  db.prepare("DELETE FROM reports WHERE status<>'open' AND created<?").run(t - 180 * 86400000);
}
async function housekeeping() {
  try { if (!backup.todayExists(BACKUP_DIR)) await backup.runBackup(db, BACKUP_DIR, BACKUP_KEEP); }
  catch (e) { console.error('Backup failed:', e.message); }
  try { purgeOld(); } catch (e) { console.error('Cleanup failed:', e.message); }
  sweepPhotos();
}
housekeeping();
setInterval(housekeeping, 3600000).unref(); // checks hourly; the backup itself happens once per day

// pages
const page =(f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/v/:token', page('contact.html'));
app.get('/contact', page('contact.html'));
app.get('/owner', page('login.html'));
app.get('/provider', page('login.html'));
app.get('/dashboard', page('dashboard.html'));
app.get('/provider/dashboard', page('provider-home.html'));
app.get('/sticker/:id', page('sticker.html'));

app.listen(PORT, () => {
  console.log(`\nVehicle QR app running:  http://localhost:${PORT}`);
  console.log(`QR codes point to:       ${BASE_URL}/v/<token>`);
  console.log(SMTP_ON ? `Email alerts:            on (${process.env.SMTP_HOST})` : 'Email alerts:            off (see README to turn on, free)');
  console.log(`Daily backup:            ${BACKUP_DIR} (keeping ${BACKUP_KEEP})`);
  console.log(ADMIN_PASSWORD ? `Admin page:              ${BASE_URL}/admin` : 'Admin page:              off (set ADMIN_PASSWORD in .env to turn on)');
  if (BASE_URL.includes('localhost')) console.log('Tip: set BASE_URL to your LAN IP so phones can scan (see README).');
});
