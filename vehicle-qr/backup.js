// Daily database backup. Free: uses SQLite's own online backup, no extra software.
//
//   npm run backup            one backup now (safe even while the server is running)
//
// The server also calls this by itself once a day. Set BACKUP_DIR in .env to a folder on
// ANOTHER drive (or a OneDrive / Google Drive folder) so one dead disk cannot take both copies.
const fs = require('fs');
const path = require('path');

const FILE = /^app-\d{4}-\d{2}-\d{2}\.db$/;
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => FILE.test(f)).sort().reverse().map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, modified: st.mtimeMs };
    });
  } catch (_) { return []; }
}

const todayExists = (dir) => fs.existsSync(path.join(dir, `app-${today()}.db`));

async function runBackup(db, dir, keep) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `app-${today()}.db`);
  const tmp = `${dest}.tmp`;
  try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
  await db.backup(tmp);           // consistent copy, even with the server writing
  // make the copy one self-contained file (no -wal/-shm companions) so it can be moved or opened anywhere
  const copy = new (require('better-sqlite3'))(tmp);
  copy.pragma('journal_mode = DELETE');
  copy.close();
  fs.renameSync(tmp, dest);       // only a finished file ever gets the real name
  for (const old of listBackups(dir).slice(Math.max(keep, 1))) {
    try { fs.unlinkSync(path.join(dir, old.file)); } catch (_) { /* ignore */ }
  }
  return { file: dest, size: fs.statSync(dest).size };
}

const BACKUP_DIR = () => process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_KEEP = () => Number(process.env.BACKUP_KEEP) || 14;

module.exports = { runBackup, listBackups, todayExists, BACKUP_DIR, BACKUP_KEEP };

if (require.main === module) {
  require('./env');
  const Database = require('better-sqlite3');
  const dbFile = path.join(__dirname, 'data', 'app.db');
  if (!fs.existsSync(dbFile)) { console.error('No database yet at', dbFile); process.exit(1); }
  const db = new Database(dbFile, { fileMustExist: true });
  runBackup(db, BACKUP_DIR(), BACKUP_KEEP())
    .then((r) => { console.log(`Backup saved: ${r.file} (${Math.round(r.size / 1024)} KB)`); db.close(); })
    .catch((e) => { console.error('Backup failed:', e.message); process.exit(1); });
}
