import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { cfg } from "./config.js";

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
export const db = new Database(cfg.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY,
  address TEXT UNIQUE NOT NULL,
  encrypted_key TEXT NOT NULL,
  funder_tx_hash TEXT,
  funded_amount TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  consent_withdrawn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  tx_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  block_number INTEGER,
  fee_bot TEXT,
  event_project_id TEXT,
  event_voter TEXT,
  next_eligible_at INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS campaign (
  key TEXT PRIMARY KEY, value TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT,
  matchday_votes INTEGER,
  rank INTEGER,
  raw TEXT,
  taken_at TEXT DEFAULT (datetime('now'))
);
`);

export const kv = {
  get: (k) => db.prepare("SELECT value FROM campaign WHERE key=?").get(k)?.value,
  set: (k, v) =>
    db.prepare(
      "INSERT INTO campaign(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(k, String(v)),
};

db.prepare("INSERT OR IGNORE INTO campaign(key,value) VALUES('paused','0')").run();
db.prepare("INSERT OR IGNORE INTO campaign(key,value) VALUES('total_fees_bot','0')").run();
