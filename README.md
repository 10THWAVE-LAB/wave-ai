# 🌊 WAVE AI

A ChatGPT-style AI chat web app with freemium subscriptions. Users chat with a
free AI (no API key needed); the owner earns money from **Pro subscriptions**
(₱149/month) paid via **GCash** or **Stripe**.

- **Free plan:** 20 AI messages per day, forever
- **Pro plan:** unlimited messages, priority speed — ₱149/month
- **AI engine:** Pollinations text API (free, no key), called server-side only

## How it works

| Page | What it does |
|---|---|
| `/` | Landing page — hero, features, pricing teaser |
| `/app` | The chat app (login required): sidebar with chats, streaming replies, Markdown + code copy, stop button |
| `/pricing` | Free vs Pro, GCash payment instructions + reference-number form, optional Stripe card button |
| `/admin` | Owner dashboard: users, payment approvals, usage stats, settings (GCash number, prices, limits) |

**Payments flow (GCash):** a user sends ₱149 to the owner's GCash, submits the
reference number on `/pricing`, and the owner approves it in `/admin` — that
grants 30 days of Pro. **Stripe (optional):** set a Stripe Payment Link and a
"Pay with card" button appears on the pricing page.

## Tech

Cloudflare Workers (Hono) · D1 (SQLite) · PBKDF2 passwords (WebCrypto) · JWT
sessions in an httpOnly cookie · vanilla JS frontend bundled into the
script (`scripts/build-assets.mjs` + esbuild — the Workers Script Upload
API cannot take static assets). No paid services. The database lives in
D1, so users, chats, and payments **persist** across deploys (unlike the
old Render free tier, whose disk was wiped on restart).

The original Node + Express version is preserved on the `express-legacy`
branch.

## Run locally

```bash
npm install
# .dev.vars holds local secrets (gitignored). Fill in SESSION_SECRET with a
# fresh random value and ADMIN_EMAIL with your email:
#   SESSION_SECRET=$(openssl rand -hex 32)
#   ADMIN_EMAIL=you@example.com
npm run dev   # wrangler dev --local, no Cloudflare account needed
```

Then open http://localhost:8787 — sign up with the `ADMIN_EMAIL` address to
become the admin. Local D1 data is stored under `.wrangler/` (gitignored).

After changing anything under `public/`, re-run `npm run build` so the
bundled frontend (`src/assets.js`, committed) stays in sync — `npm run dev`
serves the bundle, not the `public/` files directly.

## Deploy on Cloudflare (free)

Cloudflare's free tier needs **no credit card** and allows commercial use,
which is why WAVE AI lives here (Render requires a card; Koyeb removed its
free tier for new accounts after joining Mistral AI).

**Recommended: the API deploy helper.** The Cloudflare dashboard sign-up
is blocked by Turnstile in some browsers, so deployment goes through the
Cloudflare API instead:

1. **Create a free Cloudflare account** on your own device, then an API
   token (My Profile → API Tokens → Create Token → the **"Edit Cloudflare
   Workers"** template, which covers Workers Scripts and D1).
2. **Run the deploy helper** (it uses the API token from Muse's Secure
   Vault — never paste the token into chat or a file):
   ```bash
   python3 scripts/cloudflare_api_deploy.py
   ```
   It finds (or creates) the D1 database `wave-ai-db`, builds and uploads
   the Worker, sets the `SESSION_SECRET` and `ADMIN_EMAIL` secrets, and
   checks the live `/healthz` endpoint. The tables are created
   automatically on the first API request — no migration step. It also
   prints the `database_id`: patch it into `wrangler.toml` (replacing
   `PLACEHOLDER-REPLACE-AFTER-D1-CREATED`) for future wrangler deploys.

**Alternative: wrangler or the dashboard.** Create the D1 database
(`npx wrangler d1 create wave-ai-db`), patch the `database_id` into
`wrangler.toml`, set the secrets (`npx wrangler secret put SESSION_SECRET`
and `ADMIN_EMAIL`), then `npm run deploy` — or connect the repo in the
dashboard (Workers & Pages → Create → Workers → Import a repository) so
every push auto-deploys.

3. **Sign up.** Open your `*.workers.dev` URL, sign up with the admin email,
   then open `/admin`.
4. **Configure payments in `/admin`:** enter your GCash number + name, check
   the Pro price (₱149) and free daily limit (20). Optionally paste a Stripe
   Payment Link to enable card payments.

### Free-tier notes (read this)

- **Workers free tier:** 100,000 requests/day, 10 ms CPU per request. Chat
  replies stream, so long AI answers are fine — waiting on the AI does not
  burn CPU. Password hashing uses PBKDF2 (WebCrypto), which is the
  Workers-friendly choice; bcrypt would exceed the CPU budget.
- **D1 free tier:** 5M rows read/day, 100k rows written/day, 500 MB storage.
  Plenty for launch. Rate limiting is D1-backed (Workers have no reliable
  in-memory state).
- **The database persists** — users and Pro subscriptions survive redeploys.
  Back it up before risky changes: `npx wrangler d1 export wave-ai-db`.

## Owner setup checklist

- [ ] Create the D1 database, patch `database_id` in `wrangler.toml`, deploy
- [ ] Set `SESSION_SECRET` and `ADMIN_EMAIL` secrets
- [ ] Sign up with the admin email, open `/admin`
- [ ] Set GCash number + name in `/admin` → Settings
- [ ] (Optional) Create a Stripe Payment Link for ₱149/month and paste it in
      Settings — card subscribers still need manual Pro activation unless you
      add a Stripe webhook later
- [ ] Share the link — post it on Facebook/TikTok/YouTube

## Changing prices and limits

In `/admin` → Settings (applies immediately, no redeploy), or via env vars
`PRO_PRICE_PHP` and `FREE_DAILY_LIMIT` in `wrangler.toml`.

## API overview

- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`
- `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/:id`
- `POST /api/conversations/:id/messages` — streams the AI reply as SSE
  (`{"token": "..."}` chunks, then `{"done": true}`); HTTP 402 when the free
  daily limit is reached
- `POST /api/payments/gcash`, `GET /api/payments/mine`
- `GET /api/admin/stats|users|payments|settings`,
  `POST /api/admin/payments/:id/approve|reject`, `PUT /api/admin/settings`
- `GET /api/public-settings`, `GET /healthz`

## Security notes

- Passwords are PBKDF2-hashed (WebCrypto, 100,000 iterations, random salt);
  sessions are signed JWTs in httpOnly cookies.
- The AI API is called from the server only — the browser never sees it.
- Auth, chat, and payment endpoints have D1-backed rate limiting.
- Never commit `.dev.vars`, `.env`, or secrets (see `.gitignore`).
