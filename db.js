const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    avatar      TEXT DEFAULT '',
    role        TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

const userQueries = {
  create: db.prepare(`
    INSERT INTO users (id, username, email, password, role)
    VALUES (?, ?, ?, ?, ?)
  `),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  findById: db.prepare('SELECT id, username, email, avatar, role, created_at FROM users WHERE id = ?'),
  setRoleByUsername: db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE username = ?`),
};

const configuredAdminUsername = process.env.ADMIN_USERNAME || 'Leo';
if (configuredAdminUsername) {
  userQueries.setRoleByUsername.run('admin', configuredAdminUsername);
}

module.exports = { db, DB_PATH, userQueries };
