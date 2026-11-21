// Vehicle QR contact app - 100% free stack: Node + SQLite + Web Push (no paid services).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const webpush = require('web-push');
const nodemailer = require('nodemailer');

// load .env (no extra dependency); real environment variables win
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* no .env file */ }

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
  return db.prepare('SELECT id,name,phone,role,email,email_verified FROM users WHERE id=?').get(Number(uid)) || null;
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
    `${body}\n\nOpen your dashboard to reply: ${BASE_URL}/dashboard\n\nYou get this because email alerts are on for your VehicleAssist account. You can turn them off in your dashboard.`);
}
function notifyUser(userId, payload) {
  return Promise.all([pushToUser(userId, payload), emailUser(userId, payload.title, payload.body)]);
}

// ---- app ----
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
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

// -- owner: vehicles --
const vehicleOut = (v) => ({
  id: v.id, token: v.token, number: v.number, label: v.label, allowCall: !!v.allow_call, url: `${BASE_URL}/v/${v.token}`,
  insuranceExp: v.insurance_exp, pucExp: v.puc_exp, serviceExp: v.service_exp, awayMsg: v.away_msg, muteUntil: v.mute_until,
});
const dateOrEmpty = (x, old) => (x === undefined ? old : (/^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? String(x) : ''));

app.get('/api/vehicles', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM vehicles WHERE user_id=? ORDER BY id DESC').all(req.user.id).map(vehicleOut));
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
  res.json({ ok: true });
});

app.get('/api/vehicles/:id/qr.svg', auth, async (req, res) => {
  const v = ownVehicle(req, res); if (!v) return;
  const svg = await QRCode.toString(`${BASE_URL}/v/${v.token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// -- owner: inbox --
app.get('/api/messages', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.kind, m.text, m.contact, m.sender, m.created, m.is_read, m.secret, m.lat, m.lng, m.dev_hash, m.silent, v.number, v.label
    FROM messages m JOIN vehicles v ON v.id = m.vehicle_id
    WHERE v.user_id = ? AND m.hidden = 0 ORDER BY m.id DESC LIMIT 100`).all(req.user.id);
  const ids = rows.map((r) => r.id);
  const th = ids.length ? db.prepare(`SELECT message_id, who, text, created FROM thread_msgs WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) : [];
  res.json(rows.map(({ secret, dev_hash, ...m }) => ({
    ...m, kindText: KINDS[m.kind] || m.kind, isRead: !!m.is_read, canReply: !!secret, canBlock: !!dev_hash, silent: !!m.silent,
    thread: th.filter((t) => t.message_id === m.id),
  })));
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
  const m = db.prepare('SELECT m.id, m.secret FROM messages m JOIN vehicles v ON v.id=m.vehicle_id WHERE m.id=? AND v.user_id=?').get(Number(req.params.id), req.user.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (!m.secret) return res.status(400).json({ error: 'You cannot reply to this message' });
  db.prepare('INSERT INTO thread_msgs(message_id,who,text,created) VALUES(?,?,?,?)').run(m.id, 'owner', text, now());
  db.prepare('UPDATE messages SET is_read=1 WHERE id=?').run(m.id);
  res.json({ ok: true });
});
app.post('/api/messages/read', auth, (req, res) => {
  db.prepare('UPDATE messages SET is_read=1 WHERE vehicle_id IN (SELECT id FROM vehicles WHERE user_id=?)').run(req.user.id);
  res.json({ ok: true });
});
app.delete('/api/messages/:id', auth, (req, res) => {
  db.prepare('DELETE FROM messages WHERE id=? AND vehicle_id IN (SELECT id FROM vehicles WHERE user_id=?)').run(Number(req.params.id), req.user.id);
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
  const ok = await sendMail(email, 'Your VehicleAssist verification code',
    `Your code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email.`);
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
  const insert = (silent, hidden) => db.prepare(
    'INSERT INTO messages(vehicle_id,kind,text,contact,created,secret,lat,lng,dev_hash,silent,hidden) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(v.id, kind, text, contact, t, secret, hasLoc ? lat : null, hasLoc ? lng : null, dev, silent, hidden);

  // 1. blocked sender: look like it worked, but the owner never sees it
  if (db.prepare('SELECT 1 FROM blocks WHERE user_id=? AND dev_hash=?').get(v.user_id, dev)) {
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
  insert(muted ? 1 : 0, 0);
  // 5. at most one push/email every 2 minutes per vehicle; the inbox always has everything
  if (!muted && cooldownOk(v.id, 120000)) {
    notifyUser(v.user_id, {
      title: `Alert for ${v.label || v.number}`,
      body: text ? `${KINDS[kind]}: ${text}` : KINDS[kind],
    }).catch(() => {});
  }
  res.json({ ok: true, thread: secret, muted });
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
  db.prepare('INSERT INTO messages(vehicle_id,kind,text,sender,created) VALUES(?,?,?,?,?)').run(v.id, 'service', text, req.user.name, now());
  notifyUser(v.user_id, { title: `Service update from ${req.user.name}`, body: text }).catch(() => {});
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
    number: maskPlate(m.number), kindText: KINDS[m.kind], text: m.text, created: m.created,
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
      notifyUser(m.user_id, { title: `Reply about ${m.number}`, body: text }).catch(() => {});
    }
  }
  res.json({ ok: true });
});

// -- document expiry reminders (insurance / PUC / service), checked at start and every 6h --
const REM_FIELDS = { insurance_exp: 'Insurance', puc_exp: 'PUC certificate', service_exp: 'Service' };
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
      const when = days < 0 ? `expired on ${exp}` : days === 0 ? 'expires today' : days === 1 ? 'expires tomorrow' : `expires in ${days} days (${exp})`;
      const text = `${name} for ${v.label || v.number} ${when}.`;
      db.prepare('INSERT INTO messages(vehicle_id,kind,text,sender,created) VALUES(?,?,?,?,?)').run(v.id, 'reminder', text, 'VehicleAssist', now());
      notifyUser(v.user_id, { title: 'Document reminder', body: text }).catch(() => {});
    }
  }
}
runReminders();
setInterval(() => { try { runReminders(); } catch (e) { console.error(e); } }, 6 * 3600000).unref();

// pages
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
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
  if (BASE_URL.includes('localhost')) console.log('Tip: set BASE_URL to your LAN IP so phones can scan (see README).');
});
