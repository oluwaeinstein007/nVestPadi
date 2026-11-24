# Upgrading

## v3.1 → v3.2 (candles, live prices, signals with success rates)

No migration; nothing is removed.

- **PostgreSQL is supported** alongside SQLite: set `DATABASE_URL` to use it (see the README). SQLite stays the default.
- **Signals changed.** The current call (`report.call`) now comes from breakout rules with a trade plan and a measured track record; the old indicator vote is still in `report.signal` but no longer drives anything in the UI, bots or alerts. Expect fewer, different signals.
- **Live sync is on by default** when `serve --sync-every` is used: each market is re-synced every `LIVE_SYNC_MINUTES` (default `5`) while it's open. That's ~30 Yahoo requests per US sync; set `LIVE_SYNC_MINUTES=0` to keep only the regular sync.
- **New alert conditions** `signal-buy` and `signal-sell`; the threshold is the minimum past success rate (0 = any signal).
- **Crypto candles:** coins already stored with close-only history are re-fetched once from Yahoo in the background after the next sync.

## v3.0 → v3.1 (crypto, portfolio, bots and digests)

The database migrates automatically (schema v3). Nothing is removed.

- **`TELEGRAM_CHAT_ID` and `DISCORD_WEBHOOK_URL` are back** with a new meaning: server-wide broadcast channels for daily market digests. They are no longer personal alert targets. v3.0 warned if they were set; v3.1 uses them.
- **Telegram linking replaced typed chat IDs.** Users click **Connect Telegram** in Settings. Existing chat IDs keep working. `PUT /api/account/notifications` no longer accepts `telegramChatId`; use `POST /api/account/telegram/link` and `DELETE /api/account/telegram`.
- **New optional variables:** `TELEGRAM_WEBHOOK_SECRET`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DAILY_DIGEST` (default `true`), `COINGECKO_API_KEY`.
- **Personal digests are on by default** for every account (`users.daily_digest = 1`). They're only sent when the user has an active channel and something personal to report. Users can turn them off in Settings or with `/digest off`.
- **New market `CRYPTO`.** `nvest sync` (= `all`) now also syncs the top 100 coins. To skip it, sync `ngx` and `us` explicitly.
- **History:** NGX symbols are backfilled with up to 520 sessions in the background after each sync. Run `nvest sync ngx --backfill` to do them all at once (a few minutes). US history now defaults to 2 years.
- **Health check** `/api/health` now queries the database and returns `version` and `uptimeSeconds`. Every response carries an `X-Request-Id` header.

## v2 → v3 (accounts and the hosted product)

v3 turns nVestPadi from a single-user tool into a multi-user product with accounts. Your data carries over automatically.

**What happens on first start**

1. The database migrates in place (schema v1 → v2). Prices, securities and the knowledge-base ledger are untouched.
2. Your existing watchlist and alerts are kept, unowned, until the **first account is created**. That account becomes the server's owner (admin) and inherits them.
3. Create that account by opening `/signup`, or from the terminal:

   ```bash
   pnpm nvest users create you@example.com --name "Your Name"
   ```

**Environment variables**

| v2 | v3 |
|---|---|
| `API_KEY` | Removed. Sign in with an account; scripts use personal API tokens (Settings → API tokens) sent as `Authorization: Bearer nvp_…` |
| `TELEGRAM_CHAT_ID` | Removed. `TELEGRAM_BOT_TOKEN` stays server-wide; each user adds their own chat ID in Settings → Alert delivery |
| `DISCORD_WEBHOOK_URL` | Removed. Each user adds their own webhook in Settings → Alert delivery |
| — | New: `APP_MODE`, `APP_URL`, `TRUST_PROXY`, `ALLOW_SIGNUP`, `RESEND_API_KEY`, `EMAIL_FROM`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE` (all optional — see `.env.example`) |

Removed variables are ignored, and `nvest doctor` warns if they're still set.

**API and CLI changes**

- Every `/api` route except `/api/health`, `/api/auth/*`, `/api/public/*` and the billing webhook now needs a session cookie or an API token.
- `POST /api/sync` moved to `POST /api/admin/sync` (admins only).
- `nvest watchlist` and `nvest alerts` act as the owner by default; pass `--user <email>` to act as someone else. `nvest alerts check` still evaluates every account's alerts.
- Browser requests that change data must come from the app's own origin (CSRF protection). Scripts using API tokens are unaffected.

## v1 → v2 (environment variables)

| v1 | v2+ |
|---|---|
| `LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `USE_OPENAI_EMBEDDING` | `AI_PROVIDER` |
| `LLM_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` | `AI_API_KEY` |
| `GOOGLE_EMBEDDING_MODEL` | `AI_EMBEDDING_MODEL` |
| `EMBEDDING_VECTOR_SIZE` | removed (auto-detected); `AI_EMBEDDING_DIMENSIONS` if needed |
| `QDRANT_HOST`, `QDRANT_KEY`, `QDRANT_COLLECTION_NAME` | `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION` |
| `QDRANT_ENABLED` | removed (enabled when `QDRANT_URL` is set) |
| `SERVER_PORT`, `ENV`, `DATABASE_URL` | `PORT`, `NODE_ENV`, `DATABASE_PATH` |
| `ALARMS_WHOOK_URL` | `DISCORD_WEBHOOK_URL` |
| `NGX_PAGES`, `US_HISTORY_RANGE` | removed (automatic pagination; `history --range`) |
| `MAX_CONCURRENCY`, `CHROME_PATH_ON_HOST`, `GOOGLE_PROJECT_ID`, `GOOGLE_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `TRIGGER_SCRAPPER_*`, `SLEEP_TIME_QUERY` | removed (unused) |

v1 stored vectors without their text, so they can't ground answers. Point v2 at a new `QDRANT_COLLECTION`.
