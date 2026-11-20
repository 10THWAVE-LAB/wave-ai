// WAVE AI — ChatGPT-style AI chat with freemium subscriptions.
// Free AI: Pollinations text API (no key needed), called server-side only.
// Stack: Express + better-sqlite3 + JWT cookie sessions. No paid services.
// Config comes from environment variables (see .env.example).

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ---------------------------------------------------------------- config
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && NODE_ENV === 'production') {
  console.error('FATAL: SESSION_SECRET env var is required in production.');
  process.exit(1);
}
const SECRET = SESSION_SECRET || 'dev-only-secret-change-me';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://text.pollinations.ai/openai';
const AI_MODEL = process.env.AI_MODEL || 'openai-fast';
const SYSTEM_PROMPT =
  'You are WAVE AI, a friendly and helpful AI assistant. Answer clearly and ' +
  'concisely. Use Markdown formatting when it helps (headings, lists, code blocks).';

app.set('trust proxy', 1); // Render terminates TLS in front of us
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// -------------------------------------------------------------- settings
// DB settings (editable in /admin) override env vars, which override defaults.
function getSettings() {
  const fromDb = (key) => db.getSettingRow.get(key)?.value;
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    gcash_number: fromDb('gcash_number') ?? process.env.GCASH_NUMBER ?? '',
    gcash_name: fromDb('gcash_name') ?? process.env.GCASH_NAME ?? '',
    pro_price_php: num(fromDb('pro_price_php') ?? process.env.PRO_PRICE_PHP, 149),
    free_daily_limit: Math.max(
      1,
      Math.floor(num(fromDb('free_daily_limit') ?? process.env.FREE_DAILY_LIMIT, 20))
    ),
    stripe_payment_link:
      fromDb('stripe_payment_link') ?? process.env.STRIPE_PAYMENT_LINK ?? '',
  };
}

// ---------------------------------------------------------- rate limiting
// Simple in-memory limiter. Good enough for a small launch; replace with
// Redis if traffic grows. Counters reset when the process restarts.
function rateLimit({ windowMs, max, keyFn, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  }, 60_000).unref();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res
        .status(429)
        .json({ error: message || 'Too many requests. Please slow down and try again in a bit.' });
    }
    next();
  };
}
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  keyFn: (req) => req.ip,
  message: 'Too many login attempts. Please try again in a few minutes.',
});
const chatLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 60,
  keyFn: (req) => `chat:${req.user.id}`,
});
const paymentLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  keyFn: (req) => `pay:${req.user.id}`,
  message: 'Too many payment submissions. Please wait a while and try again.',
});

// ------------------------------------------------------------------ auth
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: NODE_ENV === 'production',
  maxAge: 7 * 24 * 3600 * 1000, // 7 days
  path: '/',
};

function isAdmin(user) {
  return !!ADMIN_EMAIL && user.email.toLowerCase() === ADMIN_EMAIL;
}
function isPro(user) {
  return !!user.pro_until && new Date(user.pro_until) > new Date();
}
function publicUser(user) {
  const settings = getSettings();
  const used = db.countUsageToday.get(user.id).n;
  const pro = isPro(user);
  return {
    id: user.id,
    email: user.email,
    plan: pro ? 'pro' : 'free',
    pro_until: user.pro_until,
    is_admin: isAdmin(user),
    messages_used_today: used,
    messages_limit: pro ? null : settings.free_daily_limit,
    messages_remaining: pro ? null : Math.max(0, settings.free_daily_limit - used),
  };
}
function issueSession(res, user) {
  const token = jwt.sign({ id: user.id, email: user.email }, SECRET, {
    expiresIn: '7d',
  });
  res.cookie('wave_session', token, COOKIE_OPTS);
}
function requireAuth(req, res, next) {
  const token = req.cookies?.wave_session;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.getUserById.get(payload.id);
    if (!user) return res.status(401).json({ error: 'Please log in.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only.' });
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------- AI (Pollinations)
// Streams tokens from Pollinations' OpenAI-compatible endpoint.
// NOTE: the model is a reasoning model — it streams `delta.reasoning` tokens
// (its thinking) before `delta.content`. We forward ONLY content to the user.
async function streamFromPollinations(messages, signal, onToken) {
  const res = await fetch(AI_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`Pollinations HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotAny = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const token = json.choices?.[0]?.delta?.content || '';
          if (token) {
            gotAny = true;
            onToken(token);
          }
        } catch {
          /* ignore partial JSON lines */
        }
      }
    }
  }
  return gotAny;
}

// Fallback when streaming fails: one plain request, whole answer at once.
async function askPollinationsOnce(messages, signal) {
  const res = await fetch(AI_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, messages, stream: false }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`Pollinations HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

// ------------------------------------------------------------------ pages
const PUBLIC = path.join(__dirname, 'public');
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC, 'auth.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(PUBLIC, 'auth.html')));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC, 'app.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(PUBLIC, 'pricing.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.use('/css', express.static(path.join(PUBLIC, 'css')));
app.use('/js', express.static(path.join(PUBLIC, 'js')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ------------------------------------------------------------- public API
app.get('/api/public-settings', (req, res) => res.json(getSettings()));

// ---------------------------------------------------------------- auth API
app.post('/api/auth/signup', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.getUserByEmail.get(email))
    return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.insertUser.run(email, hash);
  const user = db.getUserById.get(info.lastInsertRowid);
  issueSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.getUserByEmail.get(email);
  // Same message either way so we don't leak which emails exist.
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  issueSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('wave_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// -------------------------------------------------------- conversations API
app.get('/api/conversations', requireAuth, (req, res) => {
  res.json({ conversations: db.listConversations.all(req.user.id) });
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const info = db.insertConversation.run(req.user.id, 'New chat');
  const convo = db.getConversation.get(info.lastInsertRowid, req.user.id);
  res.status(201).json({ conversation: convo });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const convo = db.getConversation.get(Number(req.params.id), req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ conversation: convo, messages: db.listMessages.all(convo.id) });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
  const info = db.updateConversationTitle.run(title, Number(req.params.id), req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const info = db.deleteConversation.run(Number(req.params.id), req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ ok: true });
});

// ------------------------------------------------------------- chat (SSE)
// POST /api/conversations/:id/messages — streams the AI reply as
// Server-Sent Events: {"token": "..."} chunks, then {"done": true}.
// Errors mid-stream arrive as {"error": "..."}.
app.post('/api/conversations/:id/messages', requireAuth, chatLimiter, async (req, res) => {
  const convoId = Number(req.params.id);
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message is empty.' });
  if (content.length > 4000)
    return res.status(400).json({ error: 'Message is too long (max 4000 characters).' });

  const convo = db.getConversation.get(convoId, req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });

  // Free-plan daily limit (server-enforced). Pro is unlimited.
  const settings = getSettings();
  const pro = isPro(req.user);
  const used = db.countUsageToday.get(req.user.id).n;
  if (!pro && used >= settings.free_daily_limit) {
    return res.status(402).json({
      error: 'limit_reached',
      message: `You've used your ${settings.free_daily_limit} free message${settings.free_daily_limit === 1 ? '' : 's'} for today. Upgrade to Pro for unlimited chats.`,
      used,
      limit: settings.free_daily_limit,
    });
  }

  const existing = db.listMessages.all(convoId);
  db.insertMessage.run(convoId, 'user', content);
  if (existing.length === 0) {
    // Auto-title from the first message.
    const title = content.length > 40 ? content.slice(0, 40).trimEnd() + '…' : content;
    db.updateConversationTitle.run(title, convoId, req.user.id);
  } else {
    db.touchConversation.run(convoId);
  }

  // History for the model: system prompt + last 20 messages, bounded size.
  const history = [...existing, { role: 'user', content }]
    .slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    try {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client already gone */
    }
  };

  // Stop button / closed tab: abort the upstream call, keep partial reply.
  const upstreamAbort = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      upstreamAbort.abort();
    }
  });
  const signal = AbortSignal.any([
    upstreamAbort.signal,
    AbortSignal.timeout(180_000), // 3 min hard cap per reply
  ]);

  let fullText = '';
  let saved = false;
  const saveAssistant = () => {
    if (saved) return null;
    saved = true;
    if (!fullText.trim()) return null;
    const info = db.insertMessage.run(convoId, 'assistant', fullText);
    // Count against the free daily limit (permanent ledger — survives chat deletion).
    db.recordUsage.run(req.user.id);
    return info.lastInsertRowid;
  };

  try {
    const streamed = await streamFromPollinations(messages, signal, (token) => {
      fullText += token;
      send({ token });
    });
    if (!streamed && !clientGone) {
      // Stream produced nothing — try one plain request before giving up.
      const text = await askPollinationsOnce(messages, signal);
      fullText = text;
      if (text) send({ token: text });
    }
  } catch (err) {
    if (clientGone) {
      saveAssistant(); // keep whatever partial reply we got
      return;
    }
    console.error('AI error:', err.message);
    send({ error: 'AI is busy right now — please try again in a moment.' });
    return res.end();
  }

  const messageId = saveAssistant();
  send({ done: true, message_id: messageId });
  res.end();
});

// ------------------------------------------------------------ payments API
app.post('/api/payments/gcash', requireAuth, paymentLimiter, (req, res) => {
  const ref = String(req.body.ref_number || '').trim().slice(0, 100);
  const amount = Number(req.body.amount);
  if (!ref) return res.status(400).json({ error: 'Please enter your GCash reference number.' });
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: 'Please enter the amount you paid.' });
  const info = db.insertPayment.run(req.user.id, ref, amount);
  res.status(201).json({ payment: db.getPayment.get(info.lastInsertRowid) });
});

app.get('/api/payments/mine', requireAuth, (req, res) => {
  res.json({ payments: db.listPaymentsByUser.all(req.user.id) });
});

// --------------------------------------------------------------- admin API
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  res.json({
    total_users: db.countUsers.get().n,
    pro_users: db.countProUsers.get().n,
    messages_today: db.countMessagesToday.get().n,
    pending_payments: db.countPendingPayments.get().n,
  });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.listUsers.all().map((u) => ({
    ...u,
    plan: isPro(u) ? 'pro' : 'free',
  }));
  res.json({ users });
});

app.get('/api/admin/payments', requireAuth, requireAdmin, (req, res) => {
  res.json({ payments: db.listAllPayments.all() });
});

// Approving grants (or extends) Pro for 30 days from the current expiry.
app.post('/api/admin/payments/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const payment = db.getPayment.get(Number(req.params.id));
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.status !== 'pending')
    return res.status(400).json({ error: 'This payment was already reviewed.' });
  const user = db.getUserById.get(payment.user_id);
  const base = user.pro_until && new Date(user.pro_until) > new Date()
    ? new Date(user.pro_until)
    : new Date();
  const proUntil = new Date(base.getTime() + 30 * 24 * 3600 * 1000);
  const stamp = proUntil.toISOString().replace('T', ' ').slice(0, 19);
  db.setProUntil.run(stamp, user.id);
  db.setPaymentStatus.run('approved', payment.id);
  res.json({ ok: true, pro_until: stamp });
});

app.post('/api/admin/payments/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const payment = db.getPayment.get(Number(req.params.id));
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.status !== 'pending')
    return res.status(400).json({ error: 'This payment was already reviewed.' });
  db.setPaymentStatus.run('rejected', payment.id);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.json(getSettings());
});

app.put('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const allowed = [
    'gcash_number',
    'gcash_name',
    'pro_price_php',
    'free_daily_limit',
    'stripe_payment_link',
  ];
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    let value = String(req.body[key]).trim();
    if (key === 'pro_price_php') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0)
        return res.status(400).json({ error: 'Pro price must be a number (0 or more).' });
      value = String(n);
    }
    if (key === 'free_daily_limit') {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n) || n < 1)
        return res.status(400).json({ error: 'Free daily limit must be at least 1.' });
      value = String(n);
    }
    db.upsertSetting.run(key, value.slice(0, 500));
  }
  res.json(getSettings());
});

// ------------------------------------------------------------------- 404s
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, 'index.html')));

app.listen(PORT, () => {
  console.log(`WAVE AI listening on port ${PORT}`);
  console.log(`AI provider: ${AI_BASE_URL} (model: ${AI_MODEL})`);
  if (!ADMIN_EMAIL) console.log('Note: ADMIN_EMAIL is not set — no account can open /admin yet.');
});
