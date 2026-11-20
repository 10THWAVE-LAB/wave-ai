// WAVE AI — SQLite database layer (better-sqlite3, single file).
// Tables: users, conversations, messages, payments, settings.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wave-ai.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pro_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref_number TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Permanent per-day usage ledger. Separate from messages so deleting a
  -- chat cannot reset the free-plan counter.
  CREATE TABLE IF NOT EXISTS usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC);
`);

// ---------------------------------------------------------------- users
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare(
  'INSERT INTO users (email, password_hash) VALUES (?, ?)'
);
const setProUntil = db.prepare('UPDATE users SET pro_until = ? WHERE id = ?');
const listUsers = db.prepare(
  'SELECT id, email, pro_until, created_at FROM users ORDER BY created_at DESC'
);
const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
const countProUsers = db.prepare(
  "SELECT COUNT(*) AS n FROM users WHERE pro_until IS NOT NULL AND pro_until > datetime('now')"
);

// ------------------------------------------------------- conversations
const listConversations = db.prepare(
  'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
);
const getConversation = db.prepare(
  'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
);
const insertConversation = db.prepare(
  'INSERT INTO conversations (user_id, title) VALUES (?, ?)'
);
const updateConversationTitle = db.prepare(
  "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
);
const touchConversation = db.prepare(
  "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
);
const deleteConversation = db.prepare(
  'DELETE FROM conversations WHERE id = ? AND user_id = ?'
);

// ------------------------------------------------------------ messages
const listMessages = db.prepare(
  'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
);
const insertMessage = db.prepare(
  'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
);
// Assistant messages sent by this user today (UTC) — the free-plan counter.
// Kept in a permanent ledger so deleting a chat cannot reset the limit.
const countUsageToday = db.prepare(
  "SELECT COALESCE((SELECT count FROM usage WHERE user_id = ? AND day = date('now')), 0) AS n"
);
const recordUsage = db.prepare(`
  INSERT INTO usage (user_id, day, count) VALUES (?, date('now'), 1)
  ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1
`);
const countMessagesToday = db.prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND date(created_at) = date('now')"
);

// ------------------------------------------------------------ payments
const insertPayment = db.prepare(
  'INSERT INTO payments (user_id, ref_number, amount) VALUES (?, ?, ?)'
);
const getPayment = db.prepare('SELECT * FROM payments WHERE id = ?');
const listPaymentsByUser = db.prepare(
  'SELECT id, ref_number, amount, status, created_at, reviewed_at FROM payments WHERE user_id = ? ORDER BY created_at DESC'
);
const listAllPayments = db.prepare(`
  SELECT p.id, p.user_id, u.email, p.ref_number, p.amount, p.status, p.created_at, p.reviewed_at
  FROM payments p JOIN users u ON u.id = p.user_id
  ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.created_at DESC
`);
const setPaymentStatus = db.prepare(
  "UPDATE payments SET status = ?, reviewed_at = datetime('now') WHERE id = ?"
);
const countPendingPayments = db.prepare(
  "SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'"
);

// ------------------------------------------------------------ settings
// Settings live in the DB so the owner can change them in /admin without a
// redeploy. Env vars are the fallback defaults (see getSetting in server.js).
const getSettingRow = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const listSettings = db.prepare('SELECT key, value FROM settings');

module.exports = {
  db,
  getUserByEmail,
  getUserById,
  insertUser,
  setProUntil,
  listUsers,
  countUsers,
  countProUsers,
  listConversations,
  getConversation,
  insertConversation,
  updateConversationTitle,
  touchConversation,
  deleteConversation,
  listMessages,
  insertMessage,
  countUsageToday,
  recordUsage,
  countMessagesToday,
  insertPayment,
  getPayment,
  listPaymentsByUser,
  listAllPayments,
  setPaymentStatus,
  countPendingPayments,
  getSettingRow,
  upsertSetting,
  listSettings,
};
