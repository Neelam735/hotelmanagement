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
`;

const DEFAULT_SETTINGS = {
  hotel_name: 'Grand Hotel',
  reception_phone: '',
  wifi_name: '',
  wifi_password: '',
  welcome_message: 'Welcome! Tap a service below and our team will take care of it.',
};

function newRoomToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  return db;
}

module.exports = { openDatabase, newRoomToken, DEFAULT_SETTINGS };
