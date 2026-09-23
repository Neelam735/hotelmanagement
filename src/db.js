const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// node:sqlite prints an ExperimentalWarning when first used; hide just that one.
const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/.test(data.message)) {
    return false;
  }
  return originalEmit.call(process, name, data, ...args);
};
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          TEXT NOT NULL UNIQUE,
  floor           TEXT,
  token           TEXT NOT NULL UNIQUE,
  pin             TEXT,
  dnd             INTEGER NOT NULL DEFAULT 0,
  stay_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  service     TEXT NOT NULL,
  department  TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '{}',
  note        TEXT,
  device_id   TEXT,
  due_at      TEXT,
  status      TEXT NOT NULL DEFAULT 'new',
  staff_reply TEXT,
  handled_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_room ON requests(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  department    TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Guest phones that entered the room's PIN, valid for one stay.
CREATE TABLE IF NOT EXISTS guest_devices (
  device_id       TEXT NOT NULL,
  room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  stay_started_at TEXT NOT NULL,
  verified_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (device_id, room_id)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  price       INTEGER NOT NULL,          -- minor units (paise / cents)
  veg         INTEGER,                   -- 1 veg, 0 non-veg, NULL not shown
  available   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const DEFAULT_SETTINGS = {
  hotel_name: 'Grand Hotel',
  reception_phone: '',
  wifi_name: '',
  wifi_password: '',
  welcome_message: 'Welcome! Tap a service below and our team will take care of it.',
  // Wall-clock times guests pick (wake-up calls etc.) are in this zone.
  timezone: process.env.HOTEL_TIMEZONE || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  // Minutes a new request may wait before it is flagged as overdue.
  overdue_minutes: '10',
  // Guests must enter the room's stay PIN before using the page.
  require_pin: 'true',
  currency: 'INR',
};

function newRoomToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function newPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  // Migrations for databases created by earlier versions.
  const requestCols = db.prepare('PRAGMA table_info(requests)').all().map((c) => c.name);
  if (!requestCols.includes('device_id')) db.exec('ALTER TABLE requests ADD COLUMN device_id TEXT');
  if (!requestCols.includes('due_at')) db.exec('ALTER TABLE requests ADD COLUMN due_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_device ON requests(device_id)');
  const roomCols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  if (!roomCols.includes('pin')) db.exec('ALTER TABLE rooms ADD COLUMN pin TEXT');
  const setPin = db.prepare('UPDATE rooms SET pin = ? WHERE id = ?');
  for (const { id } of db.prepare('SELECT id FROM rooms WHERE pin IS NULL').all()) setPin.run(newPin(), id);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  return db;
}

module.exports = { openDatabase, newRoomToken, newPin, DEFAULT_SETTINGS };
