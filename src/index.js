// WAVE AI — ChatGPT-style AI chat with freemium subscriptions.
// Cloudflare Workers + D1 port of the Express version (see branch
// express-legacy for the original Node app).
// Free AI: Pollinations text API (no key needed), called server-side only.
// Stack: Hono + D1 (SQLite) + PBKDF2 passwords + JWT cookie sessions.
// The frontend in public/ is served unchanged via Workers Static Assets.

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import * as db from './db.js';
import * as auth from './auth.js';
import * as ai from './ai.js';

const app = new Hono();

const SYSTEM_PROMPT =
  'You are WAVE AI, a friendly and helpful AI assistant. Answer clearly and ' +
  'concisely. Use Markdown formatting when it helps (headings, lists, code blocks).';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------------ middleware
// Security headers on every Worker response (static assets get the same
// headers from public/_headers).
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
});

// Lazy schema init: the first API request on a fresh isolate creates the
// tables (idempotent), so no migration step is needed at deploy time.
app.use('/api/*', async (c, next) => {
  await db.ensureSchema(c.env.DB);
  await next();
});

// ------------------------------------------------------------------ auth
function adminEmail(env) {
  return (env.ADMIN_EMAIL || '').toLowerCase();
}
function isAdmin(env, user) {
  const admin = adminEmail(env);
  return !!admin && user.email.toLowerCase() === admin;
}
function isPro(user) {
  // pro_until is stored as a UTC 'YYYY-MM-DD HH:MM:SS' string; Workers run
  // in UTC, so parsing it here is consistent with how it was written.
  return !!user.pro_until && new Date(user.pro_until) > new Date();
}
async function publicUser(dbConn, env, user) {
  const settings = await db.getSettings(dbConn, env);
  const used = await db.countUsageToday(dbConn, user.id);
  const pro = isPro(user);
  return {
    id: user.id,
    email: user.email,
    plan: pro ? 'pro' : 'free',
    pro_until: user.pro_until,
    is_admin: isAdmin(env, user),
    messages_used_today: used,
    messages_limit: pro ? null : settings.free_daily_limit,
    messages_remaining: pro ? null : Math.max(0, settings.free_daily_limit - used),
  };
}
function cookieOpts(c) {
  // Secure cookies need HTTPS; local dev runs over plain HTTP.
  const host = new URL(c.req.url).hostname;
  const secure = host !== 'localhost' && host !== '127.0.0.1';
  return {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    maxAge: auth.SESSION_TTL_SECONDS,
    path: '/',
  };
}
async function issueSession(c, user) {
  const token = await auth.issueToken(c.env.SESSION_SECRET, user);
  setCookie(c, 'wave_session', token, cookieOpts(c));
}
async function requireAuth(c, next) {
  if (!c.env.SESSION_SECRET) {
    return c.json({ error: 'Server is not configured (SESSION_SECRET missing).' }, 500);
  }
  const token = getCookie(c, 'wave_session');
  if (!token) return c.json({ error: 'Please log in.' }, 401);
  const payload = await auth.verifyToken(c.env.SESSION_SECRET, token);
  if (!payload) return c.json({ error: 'Session expired. Please log in again.' }, 401);
  const user = await db.getUserById(c.env.DB, payload.id);
  if (!user) return c.json({ error: 'Please log in.' }, 401);
  c.set('user', user);
  await next();
}
async function requireAdmin(c, next) {
  if (!isAdmin(c.env, c.get('user'))) {
    return c.json({ error: 'Admin only.' }, 403);
  }
  await next();
}
function clientKey(c) {
  return c.req.header('CF-Connecting-IP') || 'unknown';
}

// ------------------------------------------------------------------ pages
// Static files (/css/*, /js/*, /index.html, ...) are served directly by
// Workers Static Assets without reaching this code. These clean URLs have
// no matching file, so the Worker serves the right HTML from the asset
// binding instead.
async function serveAsset(c, path) {
  const res = await c.env.ASSETS.fetch(new Request(new URL(path, c.req.url)));
  return res;
}
app.get('/', (c) => serveAsset(c, '/index.html'));
app.get('/login', (c) => serveAsset(c, '/auth.html'));
app.get('/signup', (c) => serveAsset(c, '/auth.html'));
app.get('/app', (c) => serveAsset(c, '/app.html'));
app.get('/pricing', (c) => serveAsset(c, '/pricing.html'));
app.get('/admin', (c) => serveAsset(c, '/admin.html'));

app.get('/healthz', (c) => c.json({ ok: true }));

// ------------------------------------------------------------- public API
app.get('/api/public-settings', async (c) =>
  c.json(await db.getSettings(c.env.DB, c.env))
);

// ---------------------------------------------------------------- auth API
app.post('/api/auth/signup', async (c) => {
  if (!c.env.SESSION_SECRET) {
    return c.json({ error: 'Server is not configured (SESSION_SECRET missing).' }, 500);
  }
  const allowed = await db.checkRateLimit(c.env.DB, `auth:${clientKey(c)}`, 15 * 60_000, 20);
  if (!allowed) {
    return c.json({ error: 'Too many login attempts. Please try again in a few minutes.' }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!EMAIL_RE.test(email)) {
    return c.json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters.' }, 400);
  }
  if (await db.getUserByEmail(c.env.DB, email)) {
    return c.json({ error: 'An account with this email already exists. Try logging in.' }, 409);
  }
  const hash = await auth.hashPassword(password);
  const id = await db.insertUser(c.env.DB, email, hash);
  const user = await db.getUserById(c.env.DB, id);
  await issueSession(c, user);
  return c.json({ user: await publicUser(c.env.DB, c.env, user) }, 201);
});

app.post('/api/auth/login', async (c) => {
  if (!c.env.SESSION_SECRET) {
    return c.json({ error: 'Server is not configured (SESSION_SECRET missing).' }, 500);
  }
  const allowed = await db.checkRateLimit(c.env.DB, `auth:${clientKey(c)}`, 15 * 60_000, 20);
  if (!allowed) {
    return c.json({ error: 'Too many login attempts. Please try again in a few minutes.' }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = await db.getUserByEmail(c.env.DB, email);
  // Same message either way so we don't leak which emails exist.
  if (!user || !(await auth.verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'Wrong email or password.' }, 401);
  }
  await issueSession(c, user);
  return c.json({ user: await publicUser(c.env.DB, c.env, user) });
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, 'wave_session', { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', requireAuth, async (c) =>
  c.json({ user: await publicUser(c.env.DB, c.env, c.get('user')) })
);

// -------------------------------------------------------- conversations API
app.get('/api/conversations', requireAuth, async (c) =>
  c.json({ conversations: await db.listConversations(c.env.DB, c.get('user').id) })
);

app.post('/api/conversations', requireAuth, async (c) => {
  const id = await db.insertConversation(c.env.DB, c.get('user').id, 'New chat');
  const convo = await db.getConversation(c.env.DB, id, c.get('user').id);
  return c.json({ conversation: convo }, 201);
});

app.get('/api/conversations/:id', requireAuth, async (c) => {
  const convo = await db.getConversation(c.env.DB, Number(c.req.param('id')), c.get('user').id);
  if (!convo) return c.json({ error: 'Conversation not found.' }, 404);
  return c.json({
    conversation: convo,
    messages: await db.listMessages(c.env.DB, convo.id),
  });
});

app.patch('/api/conversations/:id', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) return c.json({ error: 'Title cannot be empty.' }, 400);
  const changes = await db.updateConversationTitle(
    c.env.DB,
    title,
    Number(c.req.param('id')),
    c.get('user').id
  );
  if (changes === 0) return c.json({ error: 'Conversation not found.' }, 404);
  return c.json({ ok: true });
});

app.delete('/api/conversations/:id', requireAuth, async (c) => {
  const changes = await db.deleteConversation(
    c.env.DB,
    Number(c.req.param('id')),
    c.get('user').id
  );
  if (changes === 0) return c.json({ error: 'Conversation not found.' }, 404);
  return c.json({ ok: true });
});

// ------------------------------------------------------------- chat (SSE)
// POST /api/conversations/:id/messages — streams the AI reply as
// Server-Sent Events: {"token": "..."} chunks, then {"done": true}.
// Errors mid-stream arrive as {"error": "..."}.
app.post('/api/conversations/:id/messages', requireAuth, async (c) => {
  const dbConn = c.env.DB;
  const user = c.get('user');
  const allowed = await db.checkRateLimit(dbConn, `chat:${user.id}`, 10 * 60_000, 60);
  if (!allowed) {
    return c.json({ error: 'Too many requests. Please slow down and try again in a bit.' }, 429);
  }
  const convoId = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const content = String(body.content || '').trim();
  if (!content) return c.json({ error: 'Message is empty.' }, 400);
  if (content.length > 4000) {
    return c.json({ error: 'Message is too long (max 4000 characters).' }, 400);
  }

  const convo = await db.getConversation(dbConn, convoId, user.id);
  if (!convo) return c.json({ error: 'Conversation not found.' }, 404);

  // Free-plan daily limit (server-enforced). Pro is unlimited.
  const settings = await db.getSettings(dbConn, c.env);
  const pro = isPro(user);
  const used = await db.countUsageToday(dbConn, user.id);
  if (!pro && used >= settings.free_daily_limit) {
    return c.json(
      {
        error: 'limit_reached',
        message: `You've used your ${settings.free_daily_limit} free message${settings.free_daily_limit === 1 ? '' : 's'} for today. Upgrade to Pro for unlimited chats.`,
        used,
        limit: settings.free_daily_limit,
      },
      402
    );
  }

  const existing = await db.listMessages(dbConn, convoId);
  await db.insertMessage(dbConn, convoId, 'user', content);
  if (existing.length === 0) {
    // Auto-title from the first message.
    const title = content.length > 40 ? content.slice(0, 40).trimEnd() + '…' : content;
    await db.updateConversationTitle(dbConn, title, convoId, user.id);
  } else {
    await db.touchConversation(dbConn, convoId);
  }

  // History for the model: system prompt + last 20 messages, bounded size.
  const history = [...existing, { role: 'user', content }]
    .slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

  // Stop button / closed tab: abort the upstream call, keep partial reply.
  const upstreamAbort = new AbortController();
  const signal = AbortSignal.any([
    upstreamAbort.signal,
    AbortSignal.timeout(180_000), // 3 min hard cap per reply
  ]);

  let fullText = '';
  let saved = false;
  const saveAssistant = async () => {
    if (saved) return null;
    saved = true;
    if (!fullText.trim()) return null;
    const messageId = await db.insertMessage(dbConn, convoId, 'assistant', fullText);
    // Count against the free daily limit (permanent ledger — survives chat deletion).
    await db.recordUsage(dbConn, user.id);
    return messageId;
  };
  c.req.raw.signal.addEventListener('abort', () => {
    upstreamAbort.abort();
    c.executionCtx.waitUntil(saveAssistant());
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (obj) => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    } catch {
      /* client already gone */
    }
  };

  // Pump the upstream stream into the response. The response stream keeps
  // the Worker alive while it is open.
  (async () => {
    try {
      const streamed = await ai.streamFromPollinations(c.env, messages, signal, (token) => {
        fullText += token;
        send({ token });
      });
      if (!streamed && !upstreamAbort.signal.aborted) {
        // Stream produced nothing — try one plain request before giving up.
        const text = await ai.askPollinationsOnce(c.env, messages, signal);
        fullText = text;
        if (text) await send({ token: text });
      }
    } catch (err) {
      if (upstreamAbort.signal.aborted) {
        await saveAssistant(); // keep whatever partial reply we got
      } else {
        console.error('AI error:', err.message);
        await send({ error: 'AI is busy right now — please try again in a moment.' });
        try {
          await writer.close();
        } catch {
          /* already closed */
        }
        return;
      }
    }
    const messageId = await saveAssistant();
    await send({ done: true, message_id: messageId });
    try {
      await writer.close();
    } catch {
      /* already closed */
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// ------------------------------------------------------------ payments API
app.post('/api/payments/gcash', requireAuth, async (c) => {
  const user = c.get('user');
  const allowed = await db.checkRateLimit(c.env.DB, `pay:${user.id}`, 60 * 60_000, 10);
  if (!allowed) {
    return c.json({ error: 'Too many payment submissions. Please wait a while and try again.' }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const ref = String(body.ref_number || '').trim().slice(0, 100);
  const amount = Number(body.amount);
  if (!ref) return c.json({ error: 'Please enter your GCash reference number.' }, 400);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: 'Please enter the amount you paid.' }, 400);
  }
  const id = await db.insertPayment(c.env.DB, user.id, ref, amount);
  return c.json({ payment: await db.getPayment(c.env.DB, id) }, 201);
});

app.get('/api/payments/mine', requireAuth, async (c) =>
  c.json({ payments: await db.listPaymentsByUser(c.env.DB, c.get('user').id) })
);

// --------------------------------------------------------------- admin API
app.get('/api/admin/stats', requireAuth, requireAdmin, async (c) => {
  const dbConn = c.env.DB;
  return c.json({
    total_users: await db.countUsers(dbConn),
    pro_users: await db.countProUsers(dbConn),
    messages_today: await db.countMessagesToday(dbConn),
    pending_payments: await db.countPendingPayments(dbConn),
  });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (c) => {
  const users = await db.listUsers(c.env.DB);
  return c.json({
    users: users.map((u) => ({ ...u, plan: isPro(u) ? 'pro' : 'free' })),
  });
});

app.get('/api/admin/payments', requireAuth, requireAdmin, async (c) =>
  c.json({ payments: await db.listAllPayments(c.env.DB) })
);

// Approving grants (or extends) Pro for 30 days from the current expiry.
app.post('/api/admin/payments/:id/approve', requireAuth, requireAdmin, async (c) => {
  const dbConn = c.env.DB;
  const payment = await db.getPayment(dbConn, Number(c.req.param('id')));
  if (!payment) return c.json({ error: 'Payment not found.' }, 404);
  if (payment.status !== 'pending') {
    return c.json({ error: 'This payment was already reviewed.' }, 400);
  }
  const user = await db.getUserById(dbConn, payment.user_id);
  const base =
    user.pro_until && new Date(user.pro_until) > new Date()
      ? new Date(user.pro_until)
      : new Date();
  const proUntil = new Date(base.getTime() + 30 * 24 * 3600 * 1000);
  const stamp = proUntil.toISOString().replace('T', ' ').slice(0, 19);
  await db.setProUntil(dbConn, stamp, user.id);
  await db.setPaymentStatus(dbConn, 'approved', payment.id);
  return c.json({ ok: true, pro_until: stamp });
});

app.post('/api/admin/payments/:id/reject', requireAuth, requireAdmin, async (c) => {
  const payment = await db.getPayment(c.env.DB, Number(c.req.param('id')));
  if (!payment) return c.json({ error: 'Payment not found.' }, 404);
  if (payment.status !== 'pending') {
    return c.json({ error: 'This payment was already reviewed.' }, 400);
  }
  await db.setPaymentStatus(c.env.DB, 'rejected', payment.id);
  return c.json({ ok: true });
});

app.get('/api/admin/settings', requireAuth, requireAdmin, async (c) =>
  c.json(await db.getSettings(c.env.DB, c.env))
);

app.put('/api/admin/settings', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const allowed = [
    'gcash_number',
    'gcash_name',
    'pro_price_php',
    'free_daily_limit',
    'stripe_payment_link',
  ];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    let value = String(body[key]).trim();
    if (key === 'pro_price_php') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return c.json({ error: 'Pro price must be a number (0 or more).' }, 400);
      }
      value = String(n);
    }
    if (key === 'free_daily_limit') {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n) || n < 1) {
        return c.json({ error: 'Free daily limit must be at least 1.' }, 400);
      }
      value = String(n);
    }
    await db.upsertSetting(c.env.DB, key, value.slice(0, 500));
  }
  return c.json(await db.getSettings(c.env.DB, c.env));
});

// ------------------------------------------------------------------- 404s
app.notFound(async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api')) {
    return c.json({ error: 'Not found.' }, 404);
  }
  // Unknown page route: serve the landing page (same as the Express app).
  return serveAsset(c, '/index.html');
});

export default app;
