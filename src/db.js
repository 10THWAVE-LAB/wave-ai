// WAVE AI — D1 database layer (Cloudflare Workers).
// Same tables as the Express version (see branch express-legacy, db.js):
// users, conversations, messages, payments, settings, usage (+ rate_limits).
// D1 is SQLite, so the SQL carries over — but every call is an async
// prepared statement, not a better-sqlite3 sync call.
//
// Schema is created lazily: ensureSchema() runs CREATE TABLE IF NOT EXISTS
// once per isolate (idempotent), so no wrangler migration step is needed.
//
// NOTE on foreign keys: D1 does not enforce them by default, so cascades
// that matter are done explicitly in code (see deleteConversation).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pro_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref_number TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Permanent per-day usage ledger. Separate from messages so deleting a
  // chat cannot reset the free-plan counter.
  `CREATE TABLE IF NOT EXISTS usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,
  // D1-backed rate limiting (Workers have no reliable in-memory state).
  // One row per key per window; old windows are pruned on each check.
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (key, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC)`,
];

// Runs once per isolate; retried on the next request if it fails.
let schemaPromise = null;
export function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db
      .batch(SCHEMA.map((sql) => db.prepare(sql)))
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

// ------------------------------------------------------------------ users
export async function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}
export async function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}
export async function insertUser(db, email, passwordHash) {
  const res = await db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .bind(email, passwordHash)
    .run();
  return res.meta.last_row_id;
}
export async function setProUntil(db, stamp, userId) {
  await db
    .prepare('UPDATE users SET pro_until = ? WHERE id = ?')
    .bind(stamp, userId)
    .run();
}
export async function listUsers(db) {
  const { results } = await db
    .prepare('SELECT id, email, pro_until, created_at FROM users ORDER BY created_at DESC')
    .all();
  return results;
}
export async function countUsers(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row.n;
}
export async function countProUsers(db) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM users WHERE pro_until IS NOT NULL AND pro_until > datetime('now')"
    )
    .first();
  return row.n;
}

// ----------------------------------------------------------- conversations
export async function listConversations(db, userId) {
  const { results } = await db
    .prepare(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
    )
    .bind(userId)
    .all();
  return results;
}
export async function getConversation(db, id, userId) {
  return db
    .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
}
export async function insertConversation(db, userId, title) {
  const res = await db
    .prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)')
    .bind(userId, title)
    .run();
  return res.meta.last_row_id;
}
export async function updateConversationTitle(db, title, id, userId) {
  const res = await db
    .prepare(
      "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    )
    .bind(title, id, userId)
    .run();
  return res.meta.changes;
}
export async function touchConversation(db, id) {
  await db
    .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}
// Deletes the conversation AND its messages (D1 does not enforce the
// ON DELETE CASCADE, so both deletes are explicit).
export async function deleteConversation(db, id, userId) {
  const [msgRes, convoRes] = await db.batch([
    db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id = ? AND user_id = ?)').bind(id, userId),
    db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').bind(id, userId),
  ]);
  return convoRes.meta.changes;
}

// ---------------------------------------------------------------- messages
export async function listMessages(db, conversationId) {
  const { results } = await db
    .prepare(
      'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
    )
    .bind(conversationId)
    .all();
  return results;
}
export async function insertMessage(db, conversationId, role, content) {
  const res = await db
    .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .bind(conversationId, role, content)
    .run();
  return res.meta.last_row_id;
}
// Assistant messages sent by this user today (UTC) — the free-plan counter.
// Kept in a permanent ledger so deleting a chat cannot reset the limit.
export async function countUsageToday(db, userId) {
  const row = await db
    .prepare(
      "SELECT COALESCE((SELECT count FROM usage WHERE user_id = ? AND day = date('now')), 0) AS n"
    )
    .bind(userId)
    .first();
  return row.n;
}
export async function recordUsage(db, userId) {
  await db
    .prepare(
      `INSERT INTO usage (user_id, day, count) VALUES (?, date('now'), 1)
       ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`
    )
    .bind(userId)
    .run();
}
export async function countMessagesToday(db) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND date(created_at) = date('now')"
    )
    .first();
  return row.n;
}

// ---------------------------------------------------------------- payments
export async function insertPayment(db, userId, refNumber, amount) {
  const res = await db
    .prepare('INSERT INTO payments (user_id, ref_number, amount) VALUES (?, ?, ?)')
    .bind(userId, refNumber, amount)
    .run();
  return res.meta.last_row_id;
}
export async function getPayment(db, id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first();
}
export async function listPaymentsByUser(db, userId) {
  const { results } = await db
    .prepare(
      'SELECT id, ref_number, amount, status, created_at, reviewed_at FROM payments WHERE user_id = ? ORDER BY created_at DESC'
    )
    .bind(userId)
    .all();
  return results;
}
export async function listAllPayments(db) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.user_id, u.email, p.ref_number, p.amount, p.status, p.created_at, p.reviewed_at
       FROM payments p JOIN users u ON u.id = p.user_id
       ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.created_at DESC`
    )
    .all();
  return results;
}
export async function setPaymentStatus(db, status, paymentId) {
  await db
    .prepare("UPDATE payments SET status = ?, reviewed_at = datetime('now') WHERE id = ?")
    .bind(status, paymentId)
    .run();
}
export async function countPendingPayments(db) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'")
    .first();
  return row.n;
}

// ---------------------------------------------------------------- settings
// Settings live in the DB so the owner can change them in /admin without a
// redeploy. Env vars are the fallback defaults.
export async function getSettings(db, env) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const fromDb = new Map(results.map((r) => [r.key, r.value]));
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    gcash_number: fromDb.get('gcash_number') ?? env.GCASH_NUMBER ?? '',
    gcash_name: fromDb.get('gcash_name') ?? env.GCASH_NAME ?? '',
    pro_price_php: num(fromDb.get('pro_price_php') ?? env.PRO_PRICE_PHP, 149),
    free_daily_limit: Math.max(
      1,
      Math.floor(num(fromDb.get('free_daily_limit') ?? env.FREE_DAILY_LIMIT, 20))
    ),
    stripe_payment_link:
      fromDb.get('stripe_payment_link') ?? env.STRIPE_PAYMENT_LINK ?? '',
  };
}
export async function upsertSetting(db, key, value) {
  await db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .bind(key, value)
    .run();
}

// ------------------------------------------------------------ rate limiting
// Returns true if the request is allowed (and counts it), false if the
// key has used up `max` hits inside the current `windowMs` window.
export async function checkRateLimit(db, key, windowMs, max) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await db
    .prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?')
    .bind(key, windowStart)
    .first();
  if (row && row.count >= max) return false;
  await db.batch([
    db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`
      )
      .bind(key, windowStart),
    // Prune windows older than an hour so the table stays small.
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Date.now() - 3600_000),
  ]);
  return true;
}
