const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'reports.db'));

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Create snapshots table
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    hour       INTEGER NOT NULL,
    state_csv  TEXT NOT NULL,
    dispo_csv  TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(date, hour)
  )
`);

/**
 * Save (or replace) a snapshot for a given date + hour.
 */
function saveSnapshot(date, hour, stateCSV, dispoCSV) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO snapshots (date, hour, state_csv, dispo_csv)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(date, hour, stateCSV, dispoCSV);
}

/**
 * Get a single snapshot by date + hour.
 * Returns { state_csv, dispo_csv, created_at } or undefined.
 */
function getSnapshot(date, hour) {
  const stmt = db.prepare(`
    SELECT state_csv, dispo_csv, created_at
    FROM snapshots WHERE date = ? AND hour = ?
  `);
  return stmt.get(date, hour);
}

/**
 * Get all available hours for a date.
 * Returns array of { hour, created_at }.
 */
function getAvailableHours(date) {
  const stmt = db.prepare(`
    SELECT hour, created_at
    FROM snapshots WHERE date = ?
    ORDER BY hour ASC
  `);
  return stmt.all(date);
}

module.exports = { saveSnapshot, getSnapshot, getAvailableHours };
