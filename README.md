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

Node.js 20+ · Express · SQLite (`better-sqlite3`, single file) · bcryptjs
passwords · JWT sessions in an httpOnly cookie · vanilla JS frontend.
No paid services, no build step.

## Run locally

```bash
npm install
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
ADMIN_EMAIL=you@example.com \
npm start
```

Then open http://localhost:3000 — sign up with the `ADMIN_EMAIL` address to
become the admin. (Or copy `.env.example` to `.env` and fill it in — but note
this project does not auto-load `.env`; export the variables or use
`env $(cat .env | xargs) npm start` in development.)

## Deploy on Render (free)

1. **Push to GitHub.** Create a repo (e.g. `10THWAVE-LAB/wave-ai`) and push
   this folder:
   ```bash
   git init
   git add .
   git commit -m "WAVE AI v1"
   git remote add origin https://github.com/10THWAVE-LAB/wave-ai.git
   git push -u origin main
   ```
2. **Create the service.** In [Render](https://render.com): **New → Blueprint**,
   connect the repo. Render reads `render.yaml` and creates a free web
   service with `SESSION_SECRET` auto-generated.
3. **Set `ADMIN_EMAIL`.** In Render → your service → **Environment**, set
   `ADMIN_EMAIL` to the email you will sign up with, then **Manual Deploy →
   Deploy latest commit** (env changes need a redeploy to take effect).
4. **Sign up.** Open your Render URL (`https://wave-ai.onrender.com`), sign up
   with the admin email, then open `/admin`.
5. **Configure payments in `/admin`:** enter your GCash number + name, check
   the Pro price (₱149) and free daily limit (20). Optionally paste a Stripe
   Payment Link to enable card payments.

### Free-tier notes (read this)

- **Render's free tier spins down after 15 minutes of inactivity** — the first
  visit after a nap takes ~30–60 seconds to wake up. That is normal.
- **Free-tier disk is ephemeral:** the SQLite database (users, chats,
  payments) is wiped when the service restarts or redeploys. That is fine for
  launching and testing. Once real users and paying subscribers arrive, add a
  Render persistent disk (paid, ~$0.25/GB/month) or move to Render Postgres
  before you have subscribers you care about.
- **Back up the database** before redeploying if it matters: download
  `wave-ai.db` from the Render shell.

## Owner setup checklist

- [ ] Deploy on Render, set `ADMIN_EMAIL`
- [ ] Sign up with the admin email, open `/admin`
- [ ] Set GCash number + name in `/admin` → Settings
- [ ] (Optional) Create a Stripe Payment Link for ₱149/month and paste it in
      Settings — card subscribers still need manual Pro activation unless you
      add a Stripe webhook later
- [ ] Share the link — post it on Facebook/TikTok/YouTube

## Changing prices and limits

In `/admin` → Settings (applies immediately, no redeploy), or via env vars
`PRO_PRICE_PHP` and `FREE_DAILY_LIMIT`.

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

- Passwords are bcrypt-hashed; sessions are signed JWTs in httpOnly cookies.
- The AI API is called from the server only — the browser never sees it.
- Auth and chat endpoints have basic in-memory rate limiting.
- Never commit `.env` or `*.db` files (see `.gitignore`).
