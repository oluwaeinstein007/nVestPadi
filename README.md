# nVestPadi

Market intelligence for the **Nigerian Exchange (NGX)** and **US equities**: daily price sync, technical analysis, a screener, a watchlist, alerts sent to Telegram or Discord, and an AI analyst that answers from your own data and research with citations.

It works with no configuration at all. Add an AI key and Qdrant when you want `ask`, `search` and document ingestion.

```text
$ nvest market
NGX market  session 2026-11-20
  ▲ 17  ▼ 39  ■ 90   volume 305.6M   value 16.5B

Top gainers
  Symbol     Name                          Price   Change  Value
  MAYBAKER   May & Baker Nigeria           44.00  +10.00%  65.6M
  ...
```

---

## Features

| | |
|---|---|
| **Market sync** | Full NGX daily board (all ~150 equities: OHLC, volume, deals, value, sector) and US stocks via Yahoo Finance. No data API keys needed. |
| **Technical reports** | Trend, RSI, MACD, SMA 20/50/200, Bollinger Bands, ATR, volatility, 52-week range, multi-horizon performance and BUY/SELL signals, with a plain-English summary. |
| **Market breadth** | Advancers/decliners, top gainers and losers, most traded, and sector performance. |
| **Screener** | Filter by sector, name, price and RSI (e.g. *oversold banks*); sort by gainers, losers, value traded, volume or RSI. |
| **Watchlist** | Track symbols across NGX and US with sparklines. |
| **Alerts** | Price above/below, daily % change, RSI thresholds, and volume spikes (N× the 20-day average). Delivered to Telegram and/or Discord. |
| **Ask AI** | Answers questions using live technical reports, market breadth and your ingested research. It cites numbered sources and doesn't invent figures. |
| **Research ingestion** | Crawl websites (robots.txt-aware) or ingest PDFs such as annual reports, plus HTML, CSV, JSON, Markdown and text. Unchanged content is never re-embedded. |
| **Web dashboard** | Responsive light/dark UI with breadth, movers, sectors, screener, interactive charts, Ask AI, watchlist and alerts. |
| **Automation** | `--sync-every N` keeps data fresh and checks alerts on a schedule. |

## Quick start

Requires **Node.js ≥ 22.13** and **pnpm**.

```bash
pnpm install
cp .env.example .env          # optional, every setting has a default
pnpm nvest sync               # today's NGX + US prices
pnpm nvest market             # NGX breadth, movers, sectors
pnpm nvest analyze DANGCEM    # technical report
pnpm nvest serve              # dashboard → http://127.0.0.1:3000
pnpm nvest doctor             # check configuration & connectivity
```

To install the `nvest` command globally: `pnpm build && pnpm link --global`.

### Turning on AI

Add to `.env`:

```bash
AI_PROVIDER=gemini            # or openai
AI_API_KEY=...
QDRANT_URL=http://localhost:6333   # docker run -p 6333:6333 qdrant/qdrant
```

Then:

```bash
pnpm nvest sync                                  # quotes are now indexed too
pnpm nvest ingest file ./reports/gtco-2025.pdf   # add research
pnpm nvest ask "How did Nigerian banks perform this week?"
```

`ask` works without Qdrant too. It then answers from market data only.

## Configuration

All settings are optional and documented in [.env.example](.env.example). Real environment variables override `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` hides internal error details from API clients |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `DATABASE_PATH` | `data/nvestpadi.db` | SQLite file (prices, watchlist, alerts, index ledger) |
| `AI_PROVIDER` | — | `openai` or `gemini` |
| `AI_API_KEY` | — | Key for the chosen provider |
| `AI_CHAT_MODEL` | per provider | `gpt-4.1-mini` / `gemini-2.5-flash` |
| `AI_EMBEDDING_MODEL` | per provider | `text-embedding-3-small` / `gemini-embedding-001` |
| `AI_EMBEDDING_DIMENSIONS` | native | Only to match an existing Qdrant collection |
| `QDRANT_URL` | — | Enables semantic search and ingestion |
| `QDRANT_API_KEY` | — | Blank for local Qdrant |
| `QDRANT_COLLECTION` | `nvestpadi` | Created automatically, sized to your embedding model |
| `US_SYMBOLS` | top 30 S&P 500 | Comma-separated tickers for `sync us` |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Dashboard/API bind address |
| `API_KEY` | — | Require `Authorization: Bearer <key>` on the API |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | — | Telegram alert delivery |
| `DISCORD_WEBHOOK_URL` | — | Discord alert delivery |

Invalid values fail fast with a clear message (e.g. `AI_API_KEY: required when AI_PROVIDER=gemini`).

<details>
<summary>Migrating from v1 variable names</summary>

| v1 | v2 |
|---|---|
| `LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `USE_OPENAI_EMBEDDING` | `AI_PROVIDER` |
| `LLM_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` | `AI_API_KEY` |
| `GOOGLE_EMBEDDING_MODEL` | `AI_EMBEDDING_MODEL` |
| `EMBEDDING_VECTOR_SIZE` | removed (auto-detected); `AI_EMBEDDING_DIMENSIONS` if needed |
| `QDRANT_HOST`, `QDRANT_KEY`, `QDRANT_COLLECTION_NAME` | `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION` |
| `QDRANT_ENABLED` | removed (enabled when `QDRANT_URL` is set) |
| `SERVER_PORT`, `ENV`, `DATABASE_URL` | `PORT`, `NODE_ENV`, `DATABASE_PATH` |
| `ALARMS_WHOOK_URL` | `DISCORD_WEBHOOK_URL` |
| `NGX_PAGES`, `US_HISTORY_RANGE` | removed (pagination is automatic; `history --range`) |
| `MAX_CONCURRENCY`, `CHROME_PATH_ON_HOST`, `GOOGLE_PROJECT_ID`, `GOOGLE_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `TRIGGER_SCRAPPER_*`, `SLEEP_TIME_QUERY` | removed (unused) |

v1 stored points without their text, so they can't ground answers. Point v2 at a new `QDRANT_COLLECTION`.
</details>

## CLI

`nvest <command> [options]`. Every command accepts `--json` for scripting and `--verbose` for debug logs. Run `nvest help <command>` for details.

| Command | What it does |
|---|---|
| `sync [ngx\|us\|all] [--symbols A,B] [--no-index] [--every MIN]` | Fetch the latest session, store it, index it, check alerts |
| `history <SYM> [--exchange] [--range 1y]` | Backfill daily history |
| `quote <SYM...>` | Latest stored quotes |
| `analyze <SYM> [--exchange]` | Technical report |
| `market [--exchange NGX\|US] [--top N]` | Breadth, movers, sectors |
| `screen [--sector] [--search] [--sort] [--min-price] [--max-price] [--rsi-below] [--rsi-above] [--limit]` | Stock screener |
| `watchlist [list\|add\|remove] <SYM...>` | Manage your watchlist |
| `alerts [list\|add\|remove\|check]` | e.g. `alerts add GTCO above 100 --note "take profit"` |
| `ingest url <URL> [--depth] [--max-pages]` · `ingest file <PATH...>` · `ingest list` | Add research to the knowledge base |
| `search <query>` | Semantic search over everything indexed |
| `ask "<question>"` | Grounded AI answer with sources |
| `serve [--port] [--sync-every MIN]` | Dashboard + REST API |
| `doctor` | Check config, AI provider, Qdrant and alert channels |

Bare tickers are resolved automatically: NGX first, then US. Pass `--exchange` to disambiguate.

Alert conditions: `above`, `below`, `change-above`, `change-below`, `rsi-above`, `rsi-below`, `volume-spike`.

## Dashboard & REST API

`nvest serve` hosts the dashboard and a JSON API on the same port. Press <kbd>/</kbd> to search any ticker or company.

| Method | Path | |
|---|---|---|
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/status` | Enabled features, data stats |
| GET | `/api/market?exchange=NGX&top=8` | Breadth, movers, sectors |
| GET | `/api/screen?exchange=&sector=&search=&sort=&minPrice=&maxPrice=&rsiBelow=&rsiAbove=&limit=` | Screener |
| GET | `/api/securities?q=` | Symbol/company search |
| GET | `/api/securities/:exchange/:symbol` | Technical report + history |
| GET · POST · DELETE | `/api/watchlist` · `/api/watchlist/:exchange/:symbol` | Watchlist |
| GET · POST · DELETE | `/api/alerts` · `/api/alerts/:id` | Alerts |
| POST | `/api/sync` `{ "exchange": "all" }` | Trigger a sync |
| POST | `/api/ask` `{ "question": "…" }` | AI answer |
| GET | `/api/search?q=` | Semantic search |

The server binds to `127.0.0.1` by default. When `API_KEY` is set, every route except `/api/health` requires `Authorization: Bearer <key>`, and the dashboard prompts for the key. `ask`, `sync` and `search` are rate-limited to 20 requests per minute per IP.

## Deployment

```bash
cp .env.example .env     # set AI_*, API_KEY, alert channels…
docker compose up -d     # app on 127.0.0.1:3000 + Qdrant, syncing hourly
```

The image runs as a non-root user, keeps SQLite on the `/data` volume, has a health check, and shuts down gracefully on `SIGTERM`. Without Docker, run `pnpm build && pnpm start`.

## Data sources & limitations

- **NGX daily board**: NGX's public statistics API. **Company names** come from afx.kwayisi.org.
- **NGX history**: afx.kwayisi.org only publishes the last ~10 sessions (close and volume). Run `nvest sync` each trading day, or `serve --sync-every`, to build longer NGX history for RSI, MACD and moving averages.
- **US**: the Yahoo Finance public chart API. Data is end-of-day or delayed, and Yahoo may rate-limit (requests are retried with backoff).
- These are unofficial public endpoints and can change without notice. nVestPadi is a research tool, **not investment advice**.

## Development

```bash
pnpm dev          # dashboard with auto-reload
pnpm check        # typecheck + lint (Biome) + tests (node:test)
pnpm build        # compile to dist/
```

See [docs/architecture.md](docs/architecture.md) for the design and extension points.
