<div align="center">

<img src="public/favicon.svg" width="56" height="56" alt="nVestPadi logo" />

# nVestPadi

**The AI research desk for Nigerian (NGX) and US stocks.**

Daily market data · plain-English technical reports · screener · email & Telegram alerts · AI answers that cite their sources

[![CI](https://github.com/oluwaeinstein007/nVestPadi/actions/workflows/ci.yml/badge.svg)](https://github.com/oluwaeinstein007/nVestPadi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0b7a4b.svg)](LICENSE)
![Node ≥ 22.13](https://img.shields.io/badge/node-%E2%89%A522.13-0b7a4b.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

[Product](#the-product) · [Self-host](#self-host-in-3-commands) · [Run the hosted product](#run-it-as-a-hosted-product) · [CLI](#cli) · [API](#rest-api) · [Architecture](docs/architecture.md) · [Upgrading](docs/upgrading.md)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/img/dashboard-dark.webp" />
  <img src="public/img/dashboard-light.webp" alt="nVestPadi dashboard: NGX market breadth, top gainers, sector performance, watchlist and alerts" width="900" />
</picture>

</div>

---

## Why nVestPadi?

Researching Nigerian stocks usually means juggling the NGX website, broker PDFs, spreadsheets and WhatsApp groups. nVestPadi puts it in one place:

- **Market data built in.** The full NGX daily board (about 150 equities) and any US tickers, with no data subscription.
- **Analysis you can read.** Every stock gets a technical report in plain English, not just a chart.
- **Alerts where you already are.** Email, Telegram or Discord when a price, RSI or volume condition hits.
- **AI that shows its work.** Answers cite the market data and documents they used, and the model is told never to invent figures.
- **Hosted or yours.** Sign up for the hosted app, or run the same code on your own server with every feature unlocked.

## The product

One codebase, two ways to run it, chosen with `APP_MODE`:

| | **Cloud** (`APP_MODE=cloud`) | **Self-hosted** (`APP_MODE=self-hosted`, default) |
|---|---|---|
| Who signs up | Anyone (open sign-up, terms acceptance) | The first account becomes the **owner**; sign-up then closes and the owner adds people with `nvest users create` |
| Plans | Free and Pro, enforced server-side | No plans, everything unlimited |
| Billing | Paystack subscriptions (card, transfer, USSD) | None |
| Email | Resend: verification, password reset, alert emails | Optional; without it, links are written to the server log |

### User journey

```text
Landing (/) ── Start free ──► Sign up (/signup) ──► Onboarding (/welcome) ──► Dashboard (/app)
   │                              │  verify-email link          1. pick a market         │
   │                              ▼  (banner until confirmed)   2. pick stocks to watch  ├─► Stock detail (/app#NGX:GTCO)
   └── Log in (/login) ◄── Forgot password (/forgot-password)   3. set alert delivery    └─► Settings (/app/settings)
                                   └─► Reset (/reset-password)                               profile · alert delivery · plan & billing
                                                                                             security & sessions · API tokens · delete account
```

Pages are guarded on the server: signed-out visitors are sent to `/login?next=…`, signed-in users skip the login page, and anyone who hasn't finished onboarding lands on `/welcome` first.

### Plans (cloud mode)

| | Free | Pro (₦4,500/month) |
|---|---|---|
| Market dashboard, reports, screener | ✓ | ✓ |
| Watchlist | 10 stocks | 100 stocks |
| Active alerts | 3 | 50 |
| AI questions | 5 / day | 100 / day |
| Alert delivery | Email, Telegram | Email, Telegram, Discord |

Limits live in [`src/services/plans.ts`](src/services/plans.ts). A test keeps the landing page's pricing copy in sync with them. Hitting a limit returns HTTP `402` with `code: "plan_limit"`, and the UI offers an upgrade.

### Features

| | |
|---|---|
| 📊 **Market breadth** | Advancers vs decliners, value traded, top gainers and losers, the most traded stocks, and every sector ranked by its move |
| 📈 **Technical reports** | Trend, RSI, MACD, SMA 20/50/200, Bollinger Bands, ATR, volatility, 52-week range, 1W–1Y performance and BUY/SELL signals with reasons |
| 🔎 **Screener** | Filter by sector, name, price and RSI (e.g. *oversold banks*); sort by gainers, losers, value, volume or RSI |
| ⭐ **Watchlist** | Per-user NGX and US symbols side by side, with sparklines |
| 🔔 **Alerts** | `above`, `below`, `change-above`, `change-below`, `rsi-above`, `rsi-below`, `volume-spike`; one digest per user per sync; re-arm after firing |
| 💬 **Ask AI** | Answers grounded in live reports, market breadth and the research library, with numbered citations |
| 📄 **Research library** | Annual-report PDFs, HTML, CSV, JSON, Markdown, or whole websites (robots.txt-aware), added by the operator with `nvest ingest` |
| 👤 **Accounts** | Email/password sign-up, email verification, password reset, session management, personal API tokens, account deletion |
| 🖥️ **Web app + CLI** | Landing page, responsive light/dark app, REST API and a scriptable `nvest` CLI (`--json` everywhere) |

## Self-host in 3 commands

Requires **Node.js ≥ 22.13** and **pnpm**. No `.env` is needed.

```bash
git clone https://github.com/oluwaeinstein007/nVestPadi
cd nVestPadi && pnpm install
pnpm nvest serve --sync-every 60   # → http://127.0.0.1:3000
```

Open the app and you're sent to **/signup** to create the owner account. Any watchlist or alerts from an older version are handed to that account. You can also create it from the terminal:

```bash
pnpm nvest users create you@example.com --name "Your Name"   # prints a temporary password
```

The CLI works without the web app too:

```bash
pnpm nvest sync            # today's NGX + US prices
pnpm nvest market          # breadth, movers, sectors
pnpm nvest analyze DANGCEM # technical report
pnpm nvest doctor          # check your setup
```

**Docker:** `cp .env.example .env && docker compose up -d` starts the app with Qdrant and an hourly sync on `127.0.0.1:3000`.

### Turn on AI (optional)

```ini
AI_PROVIDER=gemini                 # or openai
AI_API_KEY=your-key
QDRANT_URL=http://localhost:6333   # docker run -p 6333:6333 qdrant/qdrant
```

```bash
pnpm nvest ingest file ./reports/gtco-2025-annual.pdf
pnpm nvest ask "How did Nigerian banks trade this week?"
```

`ask` works without Qdrant too; it then answers from market data alone. Qdrant adds the research library and semantic `search`.

## Run it as a hosted product

1. **Configure** (see [`.env.example`](.env.example)):

   ```ini
   APP_MODE=cloud
   NODE_ENV=production
   APP_URL=https://app.yourdomain.com   # https → Secure cookies + HSTS
   HOST=0.0.0.0
   TRUST_PROXY=true                     # behind a load balancer / reverse proxy
   RESEND_API_KEY=re_…                  # verification, reset and alert emails
   EMAIL_FROM="nVestPadi <hello@yourdomain.com>"
   PAYSTACK_SECRET_KEY=sk_live_…
   PAYSTACK_PLAN_CODE=PLN_…             # a monthly "Pro" plan in Paystack
   TELEGRAM_BOT_TOKEN=…                 # optional
   ```

2. **Paystack:** create the monthly plan, then set the webhook URL to `https://app.yourdomain.com/api/billing/webhook`. The webhook is the source of truth for plan changes. It's verified with the HMAC-SHA512 signature, upgrades on `subscription.create` / `charge.success`, and downgrades on `subscription.disable`.
3. **Deploy:** [`render.yaml`](render.yaml) is a ready Render blueprint (Docker + a 1 GB disk for SQLite). Any Docker host works: mount `/data`, expose port 3000, put HTTPS in front. No persistent disk (e.g. Render's free plan)? Use [free persistent storage](#free-persistent-storage-litestream) instead.
4. **Check:** `nvest doctor` reports the mode, accounts, email, billing and AI status. In cloud mode a missing email service shows as an error.
5. **Operate:** `nvest users list | set-plan <email> pro | set-role <email> admin | set-password <email>` for support and comps. `nvest sync` (or `serve --sync-every`) refreshes data and delivers alerts to every account.

### Free persistent storage (Litestream)

Hosts like Render's free plan wipe the disk whenever the service sleeps or redeploys. The Docker image includes [Litestream](https://litestream.io): set `LITESTREAM_*` and the container restores the SQLite database from S3-compatible storage on boot, then replicates every change within about a second. No code or database changes are needed, and without these variables nothing changes.

With **Backblaze B2** (10 GB free):

1. **Buckets → Create a Bucket** (private), e.g. `nvestpadi-db`. Note its endpoint, e.g. `s3.us-west-004.backblazeb2.com`.
2. **Application Keys → Add a New Application Key**, restricted to that bucket with read and write access. Copy the `keyID` and `applicationKey` (it's shown only once).
3. Add these to your host's environment (on Render: the service's **Environment** tab):

   ```ini
   LITESTREAM_BUCKET=nvestpadi-db
   LITESTREAM_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   LITESTREAM_REGION=us-west-004
   LITESTREAM_ACCESS_KEY_ID=<keyID>
   LITESTREAM_SECRET_ACCESS_KEY=<applicationKey>
   ```

**Cloudflare R2** works the same way: create an R2 API token with read and write access, use `https://<account-id>.r2.cloudflarestorage.com` as the endpoint and `auto` as the region. If the credentials are wrong, the container refuses to start rather than running with an empty database.

## CLI

`nvest <command> [options]`. Every command supports `--json` and `--verbose`. Run `nvest help <command>` for details.

| Command | Description |
|---|---|
| `sync [ngx\|us\|all]` | Fetch the latest session, store it, index it and check every account's alerts. `--symbols A,B` `--no-index` `--every MIN` |
| `history <SYM>` | Backfill daily history. `--exchange` `--range 1mo…max` |
| `quote <SYM...>` | Latest stored quotes |
| `analyze <SYM>` | Full technical report |
| `market` | Breadth, movers, sectors. `--exchange NGX\|US` `--top N` |
| `screen` | Screener. `--sector` `--search` `--sort` `--min-price` `--max-price` `--rsi-below` `--rsi-above` `--limit` |
| `watchlist [list\|add\|remove]` | A user's watchlist (`--user email`, default: the owner) |
| `alerts [list\|add\|remove\|rearm\|check]` | e.g. `alerts add GTCO above 130 --note "breakout"` (`--user email`) |
| `users [list\|create\|set-password\|set-plan\|set-role\|delete]` | Manage accounts |
| `ingest url <URL>` · `ingest file <PATH...>` · `ingest list` | Add to the research library |
| `search <query>` | Semantic search across everything indexed |
| `ask "<question>"` | Grounded AI answer with sources |
| `serve` | Landing page, app and REST API. `--port` `--sync-every MIN` |
| `doctor` | Check mode, accounts, email, billing, AI provider and Qdrant |

## Configuration

Every variable is optional, and [`.env.example`](.env.example) documents each one. Real environment variables override `.env`. Invalid values fail fast with a readable error.

| Variable | Default | Purpose |
|---|---|---|
| `APP_MODE` | `self-hosted` | `cloud` for the hosted product (open sign-up, plans, billing) |
| `APP_URL` | `http://localhost:$PORT` | Public URL for email links and payment redirects; `https://` enables Secure cookies + HSTS |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Web server bind address |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` / `-Host` behind a proxy |
| `ALLOW_SIGNUP` | mode default | Force sign-up open (`true`) or closed (`false`) |
| `RESEND_API_KEY` + `EMAIL_FROM` | — | Transactional email |
| `PAYSTACK_SECRET_KEY` + `PAYSTACK_PLAN_CODE` | — | Pro subscriptions (cloud mode) |
| `TELEGRAM_BOT_TOKEN` | — | Lets users receive alerts on Telegram |
| `AI_PROVIDER` / `AI_API_KEY` | — | `openai` or `gemini`; enables Ask, search and ingest |
| `AI_CHAT_MODEL` / `AI_EMBEDDING_MODEL` / `AI_EMBEDDING_DIMENSIONS` | per provider | Model overrides |
| `QDRANT_URL` / `QDRANT_API_KEY` / `QDRANT_COLLECTION` | — / — / `nvestpadi` | Vector store for the research library |
| `DATABASE_PATH` | `data/nvestpadi.db` | SQLite file for prices, accounts, watchlists and alerts |
| `US_SYMBOLS` | top 30 S&P 500 | Tickers for `sync us` |
| `NODE_ENV` / `LOG_LEVEL` | `development` / `info` | Runtime mode and verbosity |

Upgrading from v2 or v1? See [docs/upgrading.md](docs/upgrading.md). The database migrates automatically.

## REST API

`nvest serve` hosts the site, the app and a JSON API on one port. Browsers authenticate with the session cookie. Scripts send a personal API token from Settings → API tokens:

```bash
curl -H "Authorization: Bearer nvp_…" https://app.yourdomain.com/api/watchlist
```

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/health` | public | Liveness |
| GET | `/api/public/snapshot?exchange=NGX` | public | Cached breadth + top movers (landing page) |
| GET | `/api/auth/session` | public | Current user (or null), mode, sign-up status, plans |
| POST | `/api/auth/signup` · `login` · `logout` | public | `{name, email, password, acceptTerms}` · `{email, password}` |
| POST | `/api/auth/forgot-password` · `reset-password` · `verify-email` | public | Email-link flows (always 200 for unknown emails) |
| POST | `/api/auth/resend-verification` | user | Send a new verification link |
| GET · PATCH · DELETE | `/api/account` | user | Overview (plan, limits, usage) · profile · delete (password required) |
| PUT · POST | `/api/account/notifications` · `/test` | user | Email / Telegram / Discord delivery |
| POST | `/api/account/onboarding` | user | `{defaultExchange, symbols[]}` |
| POST | `/api/account/password` | user | Change password (signs out other sessions) |
| GET · DELETE | `/api/account/sessions` | user | List · sign out other sessions |
| GET · POST · DELETE | `/api/account/tokens` · `/:id` | user | Personal API tokens (shown once) |
| GET | `/api/market` · `/api/screen` · `/api/securities` · `/api/securities/:exchange/:symbol` | user | Market data, screener, search, report |
| GET · POST · DELETE | `/api/watchlist` · `/:exchange/:symbol` | user | Watchlist |
| GET · POST · DELETE | `/api/alerts` · `/:id` · POST `/:id/rearm` | user | Alerts |
| POST | `/api/ask` · GET `/api/search?q=` | user | Grounded AI answer (metered) · semantic search |
| POST | `/api/billing/checkout` · `/portal` | user | Paystack checkout / manage-subscription link |
| POST | `/api/billing/webhook` | signature | Paystack events |
| POST · GET | `/api/admin/sync` · `/api/admin/overview` | admin | Trigger a sync · user and data stats |

Errors are JSON: `{"error": "human message", "code": "unauthorized" | "forbidden" | "plan_limit" | "invalid_input" | …}`.

## Security

- **Passwords** are hashed with scrypt (per-password salt). Sign-in takes the same time whether or not the account exists.
- **Sessions** use random 256-bit tokens in an `HttpOnly; SameSite=Lax` cookie (`Secure` over HTTPS). Only SHA-256 hashes are stored. Sessions last 30 days, slide while in use, and are revoked on password change or reset. Users can review and sign out sessions.
- **CSRF:** every state-changing browser request must carry a same-origin `Origin`/`Referer`. API-token requests are exempt.
- **One-time links** (verification, reset) are hashed, single-use and short-lived (48 h and 1 h). Only the newest link of each kind works.
- **Rate limits** apply to sign-in, sign-up and reset (per IP and per email), plus AI and admin routes.
- **Headers:** strict CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and HSTS over HTTPS.
- **Authorization:** routes are private unless explicitly marked public. Every watchlist and alert query is scoped to its owner.

## How it works

```text
NGX API ─┐                       ┌─► reports · screener · breadth ─► web app / CLI / API
Yahoo ───┼─► sync ─► SQLite ─────┼─► alerts ─► per-user email / Telegram / Discord
afx ─────┘              │        └─► ask ─► LLM (answers only from numbered context)
PDFs / web ─► ingest ─► embeddings ─► Qdrant ──┘
```

SQLite is the source of truth for prices, accounts and user data. Qdrant only stores text meant for retrieval. See [docs/architecture.md](docs/architecture.md) for the layout, design decisions and extension points.

## Data sources & limitations

- **NGX**: the daily board comes from NGX's public statistics API, and company names from afx.kwayisi.org. Public NGX history covers only about the last 10 sessions, so keep `serve --sync-every` running (or `sync` daily) to build the longer history that RSI, MACD and moving averages need.
- **US**: Yahoo Finance's public chart API. It's end-of-day or delayed and occasionally rate-limited; requests are retried with backoff.
- These are unofficial public endpoints and may change without notice. A commercial deployment should license its market data.

> **Disclaimer:** nVestPadi is a research and education tool. Nothing it produces is investment advice. The bundled [Terms](public/terms.html) and [Privacy Policy](public/privacy.html) are a starting point; have them reviewed before you operate a hosted service.

## Development

```bash
pnpm dev      # server with auto-reload
pnpm check    # typecheck + Biome lint + node:test suite
pnpm build    # compile to dist/
```

Contributions are welcome. Please run `pnpm check` before opening a PR.

## License

[MIT](LICENSE) © Lanre Sanni
