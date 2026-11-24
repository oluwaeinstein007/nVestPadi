<div align="center">

<img src="public/favicon.svg" width="56" height="56" alt="nVestPadi logo" />

# nVestPadi

**The AI research desk for Nigerian (NGX) stocks, US stocks and crypto.**

Daily market data · plain-English technical reports · portfolio tracker · screener · alerts & daily digests on email, Telegram and Discord · AI answers that cite their sources

[![CI](https://github.com/oluwaeinstein007/nVestPadi/actions/workflows/ci.yml/badge.svg)](https://github.com/oluwaeinstein007/nVestPadi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0b7a4b.svg)](LICENSE)
![Node ≥ 22.13](https://img.shields.io/badge/node-%E2%89%A522.13-0b7a4b.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

[Product](#the-product) · [Bots & digests](#telegram--discord-bots-and-daily-digests) · [Self-host](#self-host-in-3-commands) · [Run the hosted product](#run-it-as-a-hosted-product) · [CLI](#cli) · [API](#rest-api) · [Architecture](docs/architecture.md) · [Upgrading](docs/upgrading.md)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/img/dashboard-dark.webp" />
  <img src="public/img/dashboard-light.webp" alt="nVestPadi dashboard: NGX market breadth, top gainers, sector performance, watchlist and alerts" width="900" />
</picture>

</div>

---

## Why nVestPadi?

Researching Nigerian stocks usually means juggling the NGX website, broker PDFs, spreadsheets and WhatsApp groups. nVestPadi puts it in one place:

- **Market data built in.** The full NGX daily board (about 150 equities, with up to 2 years of history), NYSE and Nasdaq stocks labelled by exchange and sector, and the top 100 coins. No data subscription needed.
- **Analysis you can read.** Every stock gets a technical report in plain English, not just a chart.
- **Alerts where you already are.** Email, Telegram or Discord when a price, RSI or volume condition hits, plus a daily wrap-up of your own watchlist and portfolio.
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
| Portfolio positions | 10 | 200 |
| Active alerts | 3 | 50 |
| AI questions | 5 / day | 100 / day |
| Alert delivery & daily digest | Email, Telegram | Email, Telegram, Discord |

Limits live in [`src/services/plans.ts`](src/services/plans.ts). A test keeps the landing page's pricing copy in sync with them. Hitting a limit returns HTTP `402` with `code: "plan_limit"`, and the UI offers an upgrade.

### Features

| | |
|---|---|
| 📊 **Market breadth** | Advancers vs decliners, value traded, top gainers and losers, the most traded stocks, and every sector ranked by its move |
| 📈 **Technical reports** | Trend, RSI, MACD, SMA 20/50/200, Bollinger Bands, ATR, volatility, 52-week range and 1W–1Y performance |
| 🎯 **Buy & sell signals** | Fresh breakout signals per market with entry, stop, target and time frame, each with its own **success rate after trading costs** (past signals on that stock replayed with the same rules) next to a random-entry baseline, and an **estimated chance of profit with a confidence level**; evidence-backed ideas first. Every signal shown is logged to a public **[live track record](#live-track-record)**. SELL flags on portfolio holdings, signal alerts, and grounding for "what should I buy?" questions. See [how signals are chosen and scored](#how-signals-are-chosen-and-scored) |
| 🔎 **Screener** | Filter by sector, name, price and RSI (e.g. *oversold banks*); sort by gainers, losers, value, volume or RSI |
| 🌍 **Three markets** | NGX (~150 equities), US stocks with NYSE/Nasdaq venue, sector, industry and market cap, and the top 100 crypto coins |
| ⭐ **Watchlist** | Per-user NGX, US and crypto symbols side by side, with sparklines |
| 💼 **Portfolio** | Positions with average cost, live value, today's and total P&L, and weights, per currency (NGN and USD are never mixed) |
| 🟩 **Heatmap & charts** | Most-traded names sized by value and coloured by move; candlestick or line chart with 1D (5-minute) to 2Y ranges, SMA overlays, volume and past-signal markers |
| ⚡ **Live prices** | While a market is open, `serve` re-syncs it every `LIVE_SYNC_MINUTES` (default 5), and the stock view polls a near-live price for US stocks and crypto. NGX is delayed (no free intraday feed) |
| 🔔 **Alerts** | `above`, `below`, `change-above`, `change-below`, `rsi-above`, `rsi-below`, `volume-spike`, `signal-buy`, `signal-sell` (threshold = minimum past success rate); one digest per user per sync; re-arm after firing |
| 🤖 **Telegram & Discord bots** | `/market`, `/quote`, `/analyze`, `/signals`, `/record`, `/ask` for everyone; `/watchlist`, `/portfolio`, `/alerts`, `/digest` in a linked Telegram DM |
| 📰 **Daily digests** | Market wrap-ups to a Telegram channel and Discord webhook; personal digests built only from each user's own data |
| 💬 **Ask AI** | Answers grounded in live reports, market breadth and the research library, with numbered citations |
| 📄 **Research library** | Annual-report PDFs, HTML, CSV, JSON, Markdown, or whole websites (robots.txt-aware), added by the operator with `nvest ingest` |
| 👤 **Accounts** | Email/password sign-up, email verification, password reset, session management, personal API tokens, account deletion |
| 🖥️ **Web app + CLI** | Landing page, responsive light/dark app, REST API and a scriptable `nvest` CLI (`--json` everywhere) |

## Telegram & Discord bots and daily digests

There are two kinds of chat delivery, and they never mix:

| | Server channels (set in `.env`) | Personal (set by each user in Settings) |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` runs the bot. `TELEGRAM_CHAT_ID` is a channel or group that gets the **daily market digest**, and anyone there can use `/market`, `/quote`, `/analyze`, `/signals` and `/ask` (rate-limited) | **Connect Telegram** opens a one-time `t.me` link. That private chat then gets the user's **alerts** and **personal digest**, and answers `/watchlist`, `/portfolio`, `/alerts`, `/digest on\|off` and `/ask` (counted against their plan) |
| Discord | `DISCORD_WEBHOOK_URL` gets the daily market digest. With an app (`DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`), `/market`, `/quote`, `/analyze`, `/signals` and `/ask` work as slash commands in any server that adds it | A Pro user's own channel webhook gets their alerts and personal digest |

- **Personal digests** contain only that user's watchlist moves, portfolio value and P&L, and alert status. They're sent after the user's default market closes and skipped when there's nothing personal to report.
- **Schedule (UTC):** NGX 15:00 (after the 14:30 WAT close), US 21:30, crypto 07:00. Stock markets skip weekends and days without a new session. Each digest is claimed in the database before sending, so restarts never double-send. Runs inside `nvest serve`; turn off with `DAILY_DIGEST=false`.
- **Telegram delivery:** with `TELEGRAM_WEBHOOK_SECRET` and an https `APP_URL`, Telegram pushes updates to `/api/integrations/telegram` (verified by the secret header). Otherwise the server long-polls, which suits laptops and private servers. Run one instance per bot token.
- **Discord setup:** set the app's *Interactions Endpoint URL* to `<APP_URL>/api/integrations/discord` (requests are verified with Ed25519), then run `pnpm nvest bots setup` to register the slash commands.
- **Preview:** `nvest digest ngx` prints today's market digest, `nvest digest --user you@example.com` prints a personal one, and `--send` delivers it.

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
3. **Deploy:** any Docker host works: set `DATABASE_URL` for a managed Postgres (or mount `/data` for SQLite), expose port 3000 and put HTTPS in front.
4. **Check:** `nvest doctor` reports the mode, accounts, email, billing and AI status. In cloud mode a missing email service shows as an error.
5. **Operate:** `nvest users list | set-plan <email> pro | set-role <email> admin | set-password <email>` for support and comps. `nvest sync` (or `serve --sync-every`) refreshes data and delivers alerts to every account.

### PostgreSQL

nVestPadi runs on SQLite by default and on PostgreSQL when `DATABASE_URL` is set. The same code and tests cover both, so you can start on SQLite and move later, or begin on a managed Postgres (Aiven, Neon, Supabase, RDS…) and never think about disks.

```ini
DATABASE_URL=postgres://user:password@host:5432/dbname?sslmode=require
```

- Tables are created automatically on first start, and upgrades run under a database lock, so several instances can boot at once.
- `sslmode` works as in `psql`: `require` encrypts without checking the certificate (what most managed providers expect); `verify-full` also verifies it, using the provider's CA in `DATABASE_CA_CERT`.
- Postgres is the right choice when you run more than one instance or can't keep a disk: sign-up races, daily-limit counters, one-time links and alert firing are all atomic across instances.
- Existing SQLite data isn't migrated automatically; start the Postgres deployment fresh, or ask for a migration script.

To run the tests against a real Postgres: `TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres pnpm test` (each test gets its own throwaway schema).

## CLI

`nvest <command> [options]`. Every command supports `--json` and `--verbose`. Run `nvest help <command>` for details.

| Command | Description |
|---|---|
| `sync [ngx\|us\|crypto\|all]` | Fetch the latest session, store it, index it and check every account's alerts. `--backfill` fills missing history; `--symbols A,B` `--no-index` `--every MIN` |
| `history <SYM>` | Backfill daily history. `--exchange` `--range 1mo…max` |
| `quote <SYM...>` | Latest stored quotes |
| `analyze <SYM>` | Full technical report |
| `market` | Breadth, movers, sectors. `--exchange NGX\|US\|CRYPTO` `--top N` |
| `signals` | Fresh buy/sell signals with stop, target, chance of profit and past record; evidence-backed first. `--exchange` `--side BUY\|SELL` `--all` |
| `record` | Live track record: every logged signal, how it played out after costs, and whether the stated chances came true. `--exchange` `--recent 15` |
| `screen` | Screener. `--sector` `--search` `--sort` `--min-price` `--max-price` `--rsi-below` `--rsi-above` `--limit` |
| `watchlist [list\|add\|remove]` | A user's watchlist (`--user email`, default: the owner) |
| `alerts [list\|add\|remove\|rearm\|check]` | e.g. `alerts add GTCO above 130 --note "breakout"` (`--user email`) |
| `users [list\|create\|set-password\|set-plan\|set-role\|delete]` | Manage accounts |
| `ingest url <URL>` · `ingest file <PATH...>` · `ingest list` | Add to the research library |
| `search <query>` | Semantic search across everything indexed |
| `ask "<question>"` | Grounded AI answer with sources |
| `serve` | Landing page, app and REST API. `--port` `--sync-every MIN` |
| `digest [market] [--user email] [--send]` | Preview or send a market or personal digest |
| `bots setup` | Register Telegram commands and Discord slash commands |
| `doctor` | Check mode, accounts, email, billing, bots, digests, AI provider and Qdrant |

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
| `TELEGRAM_BOT_TOKEN` | — | The Telegram bot (personal alerts and digests, commands) |
| `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` | — | Broadcast chat for market digests · webhook mode in production |
| `DISCORD_WEBHOOK_URL` | — | Channel for market digests |
| `DISCORD_APPLICATION_ID` + `DISCORD_PUBLIC_KEY` (+ `DISCORD_BOT_TOKEN`) | — | Slash commands via the interactions endpoint |
| `DAILY_DIGEST` | `true` | Market and personal digests while `serve` runs |
| `LIVE_SYNC_MINUTES` | `5` | While a market is open, re-sync it this often (needs `serve --sync-every`); `0` turns it off |
| `COINGECKO_API_KEY` | — | Optional free demo key for higher crypto rate limits |
| `TRADING_COSTS` | `NGX=1.48/1.8,US=0.25/0.25,CRYPTO=0.5/0.5` | Buy/sell costs in % that success rates are measured after. NGX default = 1% brokerage + SEC/NGX/CSCS fees, VAT and stamp duty; set your broker's rate |
| `AI_PROVIDER` / `AI_API_KEY` | — | `openai` or `gemini`; enables Ask, search and ingest |
| `AI_CHAT_MODEL` / `AI_EMBEDDING_MODEL` / `AI_EMBEDDING_DIMENSIONS` | per provider | Model overrides |
| `QDRANT_URL` / `QDRANT_API_KEY` / `QDRANT_COLLECTION` | — / — / `nvestpadi` | Vector store for the research library |
| `DATABASE_PATH` | `data/nvestpadi.db` | SQLite file for prices, accounts, watchlists and alerts |
| `DATABASE_URL` | — | PostgreSQL connection URL; when set, used instead of SQLite (see [PostgreSQL](#postgresql)) |
| `DATABASE_CA_CERT` / `DATABASE_POOL_MAX` | — / `5` | CA certificate for `sslmode=verify-full`; connection pool size |
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
| GET | `/api/public/track-record?exchange=NGX` | public | Live record of logged signals, calibration of stated chances, recent signals (levels of open ones withheld) |
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
| GET | `/api/market` · `/api/screen` · `/api/securities` · `/api/securities/:exchange/:symbol` | user | Market data, screener, search, report (with `call`, `track` and past `trades`) |
| GET | `/api/securities/:exchange/:symbol/live` | user | Latest price, freshness (`live`/`delayed`/`close`) and today's 5-minute candles |
| GET | `/api/signals?exchange=NGX&side=BUY&minWinRate=` | user | Current signal ideas with plans and success rates, plus the market-wide record |
| GET · POST · DELETE | `/api/watchlist` · `/:exchange/:symbol` | user | Watchlist |
| GET · POST · DELETE | `/api/alerts` · `/:id` · POST `/:id/rearm` | user | Alerts |
| GET · POST · PUT · DELETE | `/api/portfolio` · `/:id` | user | Portfolio positions with P&L (adding an existing symbol averages the cost) |
| POST · DELETE | `/api/account/telegram/link` · `/api/account/telegram` | user | One-time Telegram deep link · disconnect |
| POST | `/api/ask` · GET `/api/search?q=` | user | Grounded AI answer (metered) · semantic search |
| POST | `/api/billing/checkout` · `/portal` | user | Paystack checkout / manage-subscription link |
| POST | `/api/billing/webhook` | signature | Paystack events |
| POST | `/api/integrations/telegram` · `/api/integrations/discord` | secret · Ed25519 | Bot updates and slash commands |
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

- **NGX**: the daily board (OHLC, volume, value, sector) comes from NGX's public statistics API. Company names and up to 2 years of daily closes come from afx.kwayisi.org and are backfilled automatically, so every indicator works from day one. Historical bars are close-only; full OHLC accumulates from daily syncs.
- **US**: prices and the listing venue (NYSE, Nasdaq…) from Yahoo Finance's public chart API; sector, industry and market cap from Nasdaq's public screener, refreshed daily. The stock view's live price and 5-minute candles also come from Yahoo; occasionally rate-limited; requests retry with backoff.
- **Crypto**: CoinGecko's public API — the top 100 coins by market cap, with a rolling 24-hour change. Daily candles come from Yahoo (`BTC-USD`) when its price agrees with CoinGecko's within 5%, otherwise from CoinGecko's daily closes. Without a CoinGecko key the rate limit is low; `COINGECKO_API_KEY` helps.
- **Freshness**: NGX's board updates during the session, but there's no free intraday NGX feed, so NGX prices are delayed and only have daily candles. US and crypto prices in the stock view are near-live.

### How signals are chosen and scored

- **Rules:** a BUY is a close at a new 50-session high while above the 200-day average (a breakout in an uptrend); a SELL is a new 50-session low below it. Strong = volume ≥ 1.5× its 20-day average. Only signals from the last 3 sessions are "current". Code: [`src/analysis/signals.ts`](src/analysis/signals.ts).
- **Plan:** entry at the latest price, stop 2× ATR away (at least 2%), target 3× ATR, about 20 sessions to work.
- **Success rate:** every past signal on that security is replayed with the same plan: enter at the next open, exit at the stop, target, an opposite signal or after 20 sessions. Gaps through a stop fill at the open; close-only history is checked on the close. A success is a **profit after trading costs** (`TRADING_COSTS`, ≈3.3% round trip on NGX), and the random-entry baseline has to clear the same costs; gross figures are kept alongside. Fewer than 5 past signals is flagged as too few.
- **Chance of profit and confidence:** one stock rarely has more than a few past signals, so its own record is blended with the rule's record across the market (worth 10 trades) and with live results ([`src/analysis/confidence.ts`](src/analysis/confidence.ts)). The result is an estimated chance with a 90% range. Confidence is **high** when the whole range is above a random entry, **medium** when the estimate is above it but the range overlaps, **low** otherwise.
- **Self-correcting, not self-tuning:** as logged signals finish, live outcomes feed the market-wide starting point (after 50 live results they weigh as much as the backtest), so the stated chances drift toward what is actually happening. The rules themselves are not re-fitted automatically: tuning on a few dozen live trades fits noise. Change them only after a fresh out-of-sample test; a new rule set gets a new `SIGNAL_RULE` id and starts a fresh live record.
- **Why these rules:** four rule sets were replayed on ~10 years of 24 large NGX stocks, 17 US stocks and 10 coins, chosen on data before Nov 2023 and checked on the three years after. Only NGX breakout BUYs beat a random entry in both periods (≈58–61% of trades profitable vs ≈47–49%). The previous indicator vote did no better than chance anywhere, and US, crypto and SELL signals showed no reliable edge with any rule set. Breakouts on thinly traded NGX small caps also do poorly. That's why each idea carries its own record, the market-wide record is shown next to a random entry, and only evidence-backed ideas are listed by default.

### Live track record

Every signal the app shows is written to `signal_log` the first time a sync sees it, with the stop, target and stated chance as shown ([`src/services/signalLedger.ts`](src/services/signalLedger.ts)). It's scored from the open of the session *after* the one it was seen in, with the backtest's exits and the configured costs, and frozen once closed. Signals that fade before the close stay in. The public page `/track-record`, `nvest record` and `/record` show the results per market, plus a calibration table (did "60%" signals succeed ~60% of the time?) and a Brier score against always quoting the random-entry rate.

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
