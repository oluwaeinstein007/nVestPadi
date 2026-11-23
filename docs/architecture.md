# Architecture

## Layout

```text
src/
├── cli/
│   ├── index.ts        entry: argument parsing, help, error → exit code
│   ├── command.ts      Command type, flag helpers, `cliUser` (--user / owner)
│   ├── commands/       market · portfolio (watchlist, alerts) · research · system (serve, doctor, users)
│   └── format.ts       terminal tables, colours, sparklines
├── server/
│   ├── server.ts       request pipeline: security headers → principal → CSRF → route → JSON
│   ├── router.ts       tiny router; routes are private unless `access: "public"`
│   ├── http.ts         context, body/JSON, cookies, client IP
│   ├── static.ts       pages + assets, with per-page guards (guest / user / onboarded)
│   └── routes/         auth · account · market (data, watchlist, portfolio, alerts) · platform (AI, billing, admin) · integrations (Telegram, Discord)
├── app.ts              composition root — builds every service from Config
├── config.ts           the ONLY module that reads process.env (zod-validated)
├── version.ts          single source of the app version
├── scheduler.ts        Scheduler: periodic sync, history backfill, digest ticks, Telegram polling/webhook
├── integrations/       telegram (Bot API client) · discord (webhooks, Ed25519, slash commands) · handlers (→ BotService)
├── services/
│   ├── authService.ts       sign-up/in, sessions, verification, password reset, API-token auth
│   ├── accountService.ts    profile, delivery settings, onboarding, usage metering, tokens, deletion
│   ├── plans.ts             Free/Pro limits; self-hosted = unlimited
│   ├── billingService.ts    Paystack checkout, manage link, signed webhooks
│   ├── mailer.ts · emails.ts  Resend (or log) + transactional templates
│   ├── notifier.ts          per-user email / Telegram / Discord delivery
│   ├── alertService.ts      per-user alerts, evaluation, digests
│   ├── watchlistService.ts  per-user watchlists with plan limits
│   ├── portfolioService.ts  positions, average cost, P&L per currency
│   ├── digestService.ts     daily market + personal digests (idempotent per day)
│   ├── botService.ts        chat commands shared by Telegram and Discord; account linking
│   ├── marketService.ts     sources → SQLite (→ knowledge base)
│   ├── knowledgeBase.ts     embed + upsert + search; URL/file ingestion
│   └── insightService.ts    grounded "ask" (context assembly + LLM)
├── analysis/           technicalAnalysis (pure indicators) · report · market (breadth, screener)
├── markets/            ngx (board + afx history) · yahoo (US prices, venue) · nasdaq (US sector/industry/cap) · coingecko (crypto) · types
├── ingestion/          webCrawler, documentParser (PDF/HTML/CSV/…), textSplitter
├── storage/
│   ├── database.ts     connection, migrations, transactions, statement cache
│   ├── migrations.ts   ordered schema migrations
│   ├── repositories/   market · knowledge · users (sessions, tokens) · watchlist · holdings · alerts · usage · jobState
│   └── vectorStore.ts  Qdrant
├── ai/provider.ts      OpenAI / Gemini embeddings + chat over REST
└── lib/                errors (AppError → HTTP status), crypto (scrypt, tokens), rateLimit, http, logger, shutdown, util
public/
├── index.html          landing (pricing, self-host, FAQ, live NGX teaser)
├── auth.html           login / signup / forgot / reset / verify — one shell, view chosen by path
├── welcome.html        3-step onboarding
├── app.html            dashboard
├── settings.html       account settings
├── terms.html · privacy.html
└── js/                 ES modules, no build step: core (api, toasts, theme, user menu) · dashboard · chart · auth · welcome · settings · landing
test/                   node:test suites (unit, service, HTTP, migration, static-site checks)
```

The CLI and the server both call `createApp(config)`, so they share the same behaviour. Services receive their dependencies through their constructors, which makes them easy to test with an in-memory DB, a capturing mailer and stub AI/vector stores.

## Product modes

`APP_MODE` switches between the hosted product and a private server without forking code:

- **Entitlements** come from `limitsFor(user, mode)`: Free/Pro limits in cloud mode, unlimited when self-hosted. Services enforce them (`PlanLimitError` → HTTP 402), so the CLI and API can't bypass them.
- **Sign-up** is open in cloud mode. Self-hosted, the first account becomes the admin and sign-up closes. `ALLOW_SIGNUP` overrides either default.
- **Billing** is enabled only in cloud mode with Paystack configured. Paystack webhooks drive plan state. `currentPlan()` also drops a Pro plan to Free once its renewal date is more than 7 days past, a safety net for missed webhooks.

## Request pipeline

```text
request ─► security headers ─► resolve principal (Bearer nvp_… token, else session cookie)
        ├─ non-/api: StaticSite.resolve → page guard → redirect (/login?next=…, /welcome, /app) or asset
        └─ /api: route match ─► CSRF same-origin check (cookie-auth or anonymous, non-GET)
                 ─► read body ─► authorize (public | user | admin) ─► rate limit ─► handler ─► JSON
errors: AppError subclasses carry status + code; ZodError → 400; anything else → 500 (message hidden in production)
```

## Data model

```text
securities, daily_prices      shared market data (source of truth for analysis)
indexed_chunks                ledger of what's embedded in Qdrant
users                         email (NOCASE unique), scrypt hash, role, plan, verification, onboarding, delivery settings, billing refs
sessions, auth_tokens         SHA-256 hashed tokens with expiry; purged after each sync
api_tokens                    SHA-256 hashed personal tokens (prefix kept for display)
usage                         per-user daily counters (AI questions)
watchlist, alerts             per user (ON DELETE CASCADE); rows from v2 have user_id NULL until the first account claims them
holdings                      per-user positions (quantity, average cost)
job_state                     idempotency keys for jobs: digest:<MARKET>:<day>, enrich:US:<day>, history:<MARKET>:<SYM>
securities.venue/industry/market_cap/source_id   listing metadata; source_id = CoinGecko coin id
```

## Data flow

```text
                ┌── NGX API ──┐   ┌── Yahoo ──┐
                ▼             ▼   ▼           │
  nvest sync → MarketService.sync ──► SQLite (securities, daily_prices)
                      │                    │
                      │ (AI + Qdrant set)  ├─► analysis/* (reports, screener, breadth)
                      ▼                    └─► AlertService.check ─► Notifier (per user: email / Telegram / Discord)
               KnowledgeBase.indexQuotes
                      │
  nvest ingest ───────┴─► embed (changed chunks only) ─► Qdrant
                                                          │
  nvest ask ─► InsightService: symbol reports + breadth + vector hits ─► LLM ─► answer [n]
```

## Key decisions

**SQLite is the source of truth for market data.** Prices are structured data, so screening, technical analysis and alerts run on SQL rather than on a vector store. Qdrant holds only text meant for retrieval: research documents and one quote snapshot per symbol per day. Raw OHLCV bars aren't embedded, since that would add cost without useful semantic recall.

**Idempotency.** Every vector point has a deterministic UUID, the SHA-256 of `web:<url>:<i>`, `file:<path>:<i>` or `quote:<EX>:<SYM>:<date>`. The `indexed_chunks` table stores a content hash per ID, so re-running ingestion skips unchanged chunks and re-embeds changed ones. Price upserts use `ON CONFLICT … COALESCE`, so a sparser source never wipes fields from a richer one.

**No fake vectors.** AI failures throw. The v1 zero-vector fallback silently polluted the index, and it's gone.

**Self-sizing collection.** The Qdrant collection is created on first write with the dimension of the first embedding. A later mismatch, such as switching models, fails with an actionable message.

**Graceful capability tiers.** Market features need nothing. `ask` needs an AI provider. `search` and `ingest` need AI plus Qdrant. Email, Telegram and billing each light up when their variables are set. A missing capability raises `FeatureUnavailableError`, which the CLI shows as a hint and the API returns as a 503.

**Schema migrations.** `storage/migrations.ts` holds an ordered array, applied in transactions and tracked with `PRAGMA user_version`. To change the schema, append a new entry and never edit an old one.

**No auth dependencies.** Passwords (scrypt), tokens and HMAC verification use `node:crypto`. Sessions are server-side rows rather than JWTs, so sign-out, "sign out everywhere" and password changes take effect immediately.

**Secure by default.** Routes are private unless marked public, HTML pages are reachable only through guarded page routes, and every user-owned query takes the user's ID.

**The research library is shared.** Documents are ingested by the operator (CLI) and serve every user's answers. Per-user document uploads would need a `userId` payload filter in Qdrant and an upload route.

## Background jobs

`nvest serve` starts a `Scheduler`:

- **Sync** every `--sync-every` minutes (never overlapping), then **backfill** symbols with fewer than 60 sessions (NGX 40, US 15, crypto 5 per run). Each symbol is retried at most once a day, so a slow or rate-limited source is never hammered.
- **Digests** are checked every minute. Once a market's time passes on a trading day, it re-syncs if the data is older than 20 minutes, claims `digest:<MARKET>:<day>`, posts the market digest to the broadcast channels, then sends personal digests (`users.last_digest_on` is set before sending, so a crash can't double-send).
- **Telegram** uses a webhook when a secret and an https `APP_URL` are configured, otherwise long polling. Only one instance per bot token should run either mode.

## Chat bots

`BotService` is platform-agnostic. It takes a command plus a `BotContext` (platform, chat, private or not, linked user) and returns light markup that the adapters convert (Telegram HTML, Discord markdown). Personal commands require a linked user, and a user is only resolved for **private** Telegram chats whose id was linked through a single-use `telegram-link` token. Group chats and Discord servers only ever see market data. Unlinked `/ask` is rate-limited per chat; linked `/ask` uses the account's daily AI allowance.

## Grounded answers

`InsightService.ask` builds a numbered context:

1. **Symbol reports.** Tickers are detected in the question: all-caps tokens, or words of 5+ characters matching a ticker, plus company-name matches. Each detected symbol gets a `reportToText` summary. History is fetched on demand if it's missing.
2. **Market overview.** Added when the question mentions the market, movers or sectors, or when no symbol was found.
3. **Vector hits.** The top 8 semantic matches above a 0.3 cosine score.

The system prompt restricts the model to that context and requires inline `[n]` citations. The response returns the source list so UIs can render it.

## Extending

- **New market.** Add a fetcher in `src/markets/` that returns `MarketSnapshot`; add the code to `EXCHANGES`, `CURRENCY` and `MARKET_NAMES` (and `WEEKDAY_MARKETS` if it closes at weekends) in `types.ts`; branch on it in `MarketService.sync` and `fetchHistory`; give it a time in `DIGEST_TIMES`; and add a tab in `public/app.html`. Ghana (GSE) and Kenya (NSE) are the cheapest next candidates, because afx.kwayisi.org serves them in the same format as NGX.
- **New bot command.** Add it to `BOT_COMMANDS` and a `case` in `BotService.dispatch`. Telegram's command menu and Discord's slash commands are generated from that list (`nvest bots setup`).
- **New alert condition.** Add it to `ALERT_CONDITIONS` and a `case` in `AlertService.evaluate`. The CLI, API validation and dashboard pick it up automatically.
- **New plan or limit.** Edit `PLANS` / `PlanLimits` in `services/plans.ts`, enforce it in the owning service, and update the pricing copy in `public/index.html` (a test checks they match).
- **New API route.** Add it to the matching module in `server/routes/`. Pass `{ access: "public" }` only if it must work signed out.
- **New document format.** Add a `case` in `parseDocument` and list the extension in `SUPPORTED_EXTENSIONS`.
- **New AI provider.** Implement `AIProvider` in `src/ai/provider.ts`, then extend `AIProviderName` and `DEFAULT_MODELS` in `config.ts`.
