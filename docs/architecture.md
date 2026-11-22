# Architecture

## Layout

```text
src/
├── cli/            nvest command-line interface (+ terminal formatting)
├── server/         REST API + static dashboard (node:http)
├── app.ts          composition root — builds every service from Config
├── config.ts       the ONLY module that reads process.env (zod-validated)
├── scheduler.ts    periodic sync + alert check
├── services/
│   ├── marketService.ts    sources → SQLite (→ knowledge base)
│   ├── knowledgeBase.ts    embed + upsert + search; URL/file ingestion
│   ├── insightService.ts   grounded "ask" (context assembly + LLM)
│   └── alertService.ts     alert evaluation + Telegram/Discord delivery
├── analysis/
│   ├── technicalAnalysis.ts  pure indicator functions
│   ├── report.ts             per-security report & summary
│   └── market.ts             breadth, sectors, screener
├── markets/        data sources (ngx.ts, yahoo.ts) + shared types
├── ingestion/      webCrawler, documentParser (PDF/HTML/CSV/…), textSplitter
├── storage/        database.ts (node:sqlite), vectorStore.ts (Qdrant)
├── ai/provider.ts  OpenAI / Gemini embeddings + chat over REST
└── lib/            http (retry/timeout), logger, shutdown, util
public/             landing page (/), dashboard (/app) and screenshots — vanilla HTML/CSS/JS, no build step
test/               node:test suites
```

The CLI and the server both call `createApp(config)`, so they share the same behaviour. Services receive their dependencies through their constructors, which makes them easy to test with an in-memory DB and stub AI/vector stores (see `test/ai.test.ts`).

## Data flow

```text
                ┌── NGX API ──┐   ┌── Yahoo ──┐
                ▼             ▼   ▼           │
  nvest sync → MarketService.sync ──► SQLite (securities, daily_prices)
                      │                    │
                      │ (AI + Qdrant set)  ├─► analysis/* (reports, screener, breadth)
                      ▼                    └─► AlertService.check ─► Telegram / Discord
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

**Graceful capability tiers.** Market features need nothing. `ask` needs an AI provider. `search` and `ingest` need AI plus Qdrant. A missing capability raises `FeatureUnavailableError`, which the CLI shows as a hint and the API returns as a 503.

**Schema migrations.** `database.ts` holds an ordered `MIGRATIONS` array, applied in transactions and tracked with `PRAGMA user_version`. To change the schema, append a new entry and never edit an old one.

## Grounded answers

`InsightService.ask` builds a numbered context:

1. **Symbol reports.** Tickers are detected in the question: all-caps tokens, or words of 5+ characters matching a ticker, plus company-name matches. Each detected symbol gets a `reportToText` summary. History is fetched on demand if it's missing.
2. **Market overview.** Added when the question mentions the market, movers or sectors, or when no symbol was found.
3. **Vector hits.** The top 8 semantic matches above a 0.3 cosine score.

The system prompt restricts the model to that context and requires inline `[n]` citations. The response returns the source list so UIs can render it.

## Extending

- **New exchange.** Add a fetcher in `src/markets/` that returns `MarketSnapshot`, add the code to `EXCHANGES`/`CURRENCY` in `types.ts`, then branch on it in `MarketService.sync` and `loadHistory`.
- **New alert condition.** Add it to `ALERT_CONDITIONS` and a `case` in `AlertService.evaluate`. The CLI, API validation and dashboard pick it up automatically.
- **New document format.** Add a `case` in `parseDocument` and list the extension in `SUPPORTED_EXTENSIONS`.
- **New AI provider.** Implement `AIProvider` in `src/ai/provider.ts`, then extend `AIProviderName` and `DEFAULT_MODELS` in `config.ts`.
