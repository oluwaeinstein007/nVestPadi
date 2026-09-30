# nVestPadi

AI-powered financial market data ingestion and analysis system for Nigerian Exchange (NGX) and US stocks. Ingests market quotes, historical OHLCV bars, web documents, and local files into a vector database (Qdrant) with optional SQLite metadata tracking.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Project Structure](#project-structure)
- [Services Reference](#services-reference)
- [Technical Indicators](#technical-indicators)
- [Data Flow](#data-flow)

---

## Features

- **NGX market data**: Fetch current quotes and historical OHLCV from the Nigerian Exchange
- **US stock market data**: Fetch current quotes and historical bars for S&P500 stocks via Yahoo Finance (no API key required)
- **Web crawling**: Crawl websites recursively and ingest text content as vector embeddings
- **File ingestion**: Parse and ingest `.txt`, `.md`, `.json`, `.csv`, `.ts`, `.js` files
- **Technical analysis**: Compute SMA, EMA, RSI, MACD, Bollinger Bands, ATR, OBV, VWAP, and Stochastic indicators
- **Vector storage**: Store and search embeddings in Qdrant with cosine similarity
- **Metadata store**: Track ingested chunks in SQLite with deduplication
- **Dual embedding providers**: OpenAI or Google Gemini
- **Idempotent ingestion**: Deterministic chunk IDs mean re-running never creates duplicates

---

## Architecture

```
CLI (scripts/run_ingest.ts)
        |
        +---> MarketIngestorService    (NGX + US market data)
        |          |
        |          +--> TechnicalAnalysis  (indicators)
        |          +--> LLM (embeddings)
        |          +--> QdrantService  (vector upsert)
        |
        +---> IngestorService          (web URLs + files)
                   |
                   +--> WebCrawler        (axios + cheerio)
                   +--> DocumentParser    (file formats)
                   +--> TextSplitter      (chunking)
                   +--> LLM (embeddings)
                   +--> QdrantService  (vector upsert)
                   +--> Database       (SQLite metadata)
```

All ingestion paths share the same batch embedding and batch upsert pattern: collect all content first, embed in batches of 100, then upsert to Qdrant in batches of 100. This minimises API round-trips and respects rate limits.

---

## Prerequisites

- Node.js >= 18
- pnpm >= 10
- A running [Qdrant](https://qdrant.tech) instance (or set `QDRANT_ENABLED=false`)
- OpenAI or Google Gemini API key for embeddings

---

## Installation

```bash
git clone <repo>
cd nVestPadi
pnpm install
cp .env.example .env
# Edit .env with your API keys and Qdrant connection
```

---

## Configuration

Copy `.env.example` to `.env` and fill in the required values.

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | Embedding provider: `openai` or `gemini` |
| `OPENAI_API_KEY` | — | OpenAI API key (required if provider is `openai`) |
| `GOOGLE_API_KEY` | — | Google API key (required if provider is `gemini`) |
| `QDRANT_HOST` | — | Qdrant server URL, e.g. `http://localhost:6333` |
| `QDRANT_KEY` | — | Qdrant API key (leave blank for local instances) |
| `QDRANT_ENABLED` | `true` | Set `false` to skip Qdrant and run in metadata-only mode |
| `QDRANT_COLLECTION_NAME` | `nvestpadi` | Qdrant collection name |
| `EMBEDDING_VECTOR_SIZE` | `1536` | Must match your embedding model output dimension |
| `DATABASE_URL` | `ingestor.db` | SQLite database file path |
| `NGX_PAGES` | `1` | Number of NGX API pages to fetch per run |
| `US_MARKET_SYMBOLS` | — | Comma-separated tickers to override the default 30-symbol list |
| `US_HISTORY_RANGE` | `1y` | Yahoo Finance range: `1d` `5d` `1mo` `3mo` `6mo` `1y` `2y` `5y` `10y` `ytd` `max` |
| `MAX_CONCURRENCY` | — | Max concurrent HTTP requests |
| `SERVER_PORT` | — | Port if running an HTTP server layer |
| `ENV` | — | Environment tag (`development`, `production`, etc.) |

### Vector size by model

| Model | Provider | Size |
|---|---|---|
| `text-embedding-ada-002` | OpenAI | 1536 |
| `text-embedding-3-small` | OpenAI | 1536 |
| `text-embedding-3-large` | OpenAI | 3072 |
| `text-embedding-004` | Gemini | 768 |

Set `EMBEDDING_VECTOR_SIZE` to match whatever model you use. If you change models, you must recreate the Qdrant collection (different vector dimensions are incompatible).

---

## Usage

All commands are run through the CLI entry point:

```bash
pnpm exec tsx scripts/run_ingest.ts <command> [args]
```

### Commands

#### `ngx` — Fetch current NGX quotes

```bash
pnpm exec tsx scripts/run_ingest.ts ngx
```

Fetches the current market snapshot for all NGX-listed stocks. The number of pages fetched is controlled by the `NGX_PAGES` environment variable.

#### `ngx-history <SYMBOL>` — Fetch NGX historical OHLCV

```bash
pnpm exec tsx scripts/run_ingest.ts ngx-history DANGCEM
pnpm exec tsx scripts/run_ingest.ts ngx-history GTCO
```

Scrapes historical open/high/low/close/volume bars for the given NGX ticker from afx.kwayisi.org.

#### `us [SYMBOL...]` — Fetch current US quotes

```bash
# Default 30 S&P500 symbols
pnpm exec tsx scripts/run_ingest.ts us

# Custom symbols
pnpm exec tsx scripts/run_ingest.ts us AAPL MSFT TSLA NVDA
```

Uses Yahoo Finance (no API key required). When no symbols are provided, falls back to the `US_MARKET_SYMBOLS` environment variable, then to the built-in list of 30 large-cap S&P500 stocks.

#### `us-history <SYMBOL> [range]` — Fetch US historical OHLCV

```bash
pnpm exec tsx scripts/run_ingest.ts us-history AAPL
pnpm exec tsx scripts/run_ingest.ts us-history MSFT 2y
pnpm exec tsx scripts/run_ingest.ts us-history TSLA 6mo
```

Valid ranges: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `10y`, `ytd`, `max`. Defaults to `US_HISTORY_RANGE` env var or `1y`.

#### `url <URL>` — Crawl and ingest a website

```bash
pnpm exec tsx scripts/run_ingest.ts url https://example.com/blog
```

Recursively crawls the site (same origin, max depth 2, max 50 pages by default), extracts text, chunks it, embeds it, and stores it in Qdrant + SQLite.

#### `file <PATH>` — Parse and ingest a local file

```bash
pnpm exec tsx scripts/run_ingest.ts file ./reports/annual_report.csv
pnpm exec tsx scripts/run_ingest.ts file ./notes/analysis.md
```

Supported formats: `.txt`, `.md`, `.ts`, `.js`, `.json`, `.csv`.

---

## Project Structure

```
nVestPadi/
├── scripts/
│   └── run_ingest.ts              # CLI entry point
├── src/
│   ├── lib/
│   │   ├── llm.ts                 # Embedding provider abstraction (OpenAI / Gemini)
│   │   └── http.ts                # HTTP fetch utility with error handling
│   └── services/
│       ├── chunking/
│       │   └── textSplitter.ts    # Recursive character-level text splitter
│       ├── ingestion/
│       │   ├── webCrawler.ts      # axios + cheerio recursive web crawler
│       │   └── documentParser.ts  # File parser (txt, md, json, csv, ts, js)
│       ├── storage/
│       │   ├── qdrantService.ts   # Qdrant vector DB client wrapper
│       │   └── database.ts        # SQLite metadata store
│       ├── marketIngestorService.ts    # NGX + US market ingestion
│       ├── ingestorService.ts          # Web URL + file ingestion
│       └── TechnicalAnalysis.ts        # Technical indicator computations
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Services Reference

### `MarketIngestorService`

Handles all market data ingestion. Source: [src/services/marketIngestorService.ts](src/services/marketIngestorService.ts)

| Method | Description |
|---|---|
| `getNGXQuotes(page?)` | Fetch current NGX market quotes |
| `getNGXHistory(symbol)` | Scrape NGX historical OHLCV from afx.kwayisi.org |
| `getUSQuotes(symbols?)` | Fetch current US stock quotes from Yahoo Finance |
| `getUSHistory(symbol, range?)` | Fetch historical US bars from Yahoo Finance |

Each method fetches data, converts it to text, batch-embeds the texts, and batch-upserts to Qdrant. Chunk IDs are a deterministic UUID derived from `SHA256(exchange:symbol:date)`.

**Default US symbols** (used when no override is provided):
`AAPL MSFT NVDA AMZN GOOGL META BRK-B LLY JPM V UNH XOM TSLA MA PG JNJ HD AVGO MRK CVX ABBV COST AMD CRM NFLX BAC PEP KO TMO WMT`

---

### `IngestorService`

Handles web and file ingestion. Source: [src/services/ingestorService.ts](src/services/ingestorService.ts)

| Method | Description |
|---|---|
| `ingestUrl(url)` | Crawl a website and ingest all pages |
| `ingestFile(filePath)` | Parse and ingest a local file |

Both methods chunk text with `TextSplitter` (1000 char chunks, 200 char overlap), deduplicate via SQLite before embedding, then batch-embed and batch-upsert to Qdrant. Chunk IDs are derived from `SHA256(source:chunkIndex)`.

---

### `QdrantService`

Vector database client. Source: [src/services/storage/qdrantService.ts](src/services/storage/qdrantService.ts)

| Method | Description |
|---|---|
| `initialize()` | Create collection and payload indexes if not already present |
| `batchUpsert(points)` | Upsert points in batches of 100 |
| `upsertPoint(id, vector, payload)` | Upsert a single point |
| `search(queryVector, limit, filter?)` | Semantic similarity search |
| `pointExists(id)` | Check if a point already exists |

Payload indexes are created for `exchange`, `stock_symbol`, and `date` to enable efficient filtered searches.

---

### `Database`

SQLite metadata store. Source: [src/services/storage/database.ts](src/services/storage/database.ts)

Automatically falls back to an in-memory `Map` if `better-sqlite3` is unavailable (e.g. in environments where native modules cannot be compiled).

| Method | Description |
|---|---|
| `saveDocument(doc)` | Upsert a document record (idempotent via `ON CONFLICT`) |
| `chunkExists(chunkId)` | Check if a chunk has already been ingested |
| `getDocumentById(id)` | Retrieve a single document |
| `getAllDocuments()` | Retrieve all stored documents |
| `close()` | Close the database connection |

Schema:
```sql
CREATE TABLE documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chunkId     TEXT UNIQUE,
  source      TEXT NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT,
  metadata    TEXT,          -- JSON string
  ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

### `LLM` (Embeddings)

Embedding provider abstraction. Source: [src/lib/llm.ts](src/lib/llm.ts)

| Method | Description |
|---|---|
| `embedDocuments(texts)` | Batch embed multiple texts (chunks of 100 internally) |
| `embedQuery(text)` | Embed a single query string |

Provider is selected by `LLM_PROVIDER` env var. If the API is unreachable, embedding calls return zero vectors so ingestion continues without crashing.

---

### `TextSplitter`

Recursive character-level text splitter. Source: [src/services/chunking/textSplitter.ts](src/services/chunking/textSplitter.ts)

Splits on `\n\n` → `\n` → `. ` → ` ` → hard split, in priority order. Applies configurable overlap between consecutive chunks.

| Option | Default | Description |
|---|---|---|
| `chunkSize` | `1000` | Maximum characters per chunk |
| `chunkOverlap` | `200` | Characters shared between adjacent chunks |
| `separators` | `['\n\n', '\n', '. ', ' ']` | Separator priority list |

---

### `WebCrawler`

Recursive website crawler. Source: [src/services/ingestion/webCrawler.ts](src/services/ingestion/webCrawler.ts)

Stays within the same origin. Removes navigation, header, footer, script, and style elements before extracting text.

| Option | Default | Description |
|---|---|---|
| `maxDepth` | `2` | Maximum link-follow depth |
| `maxPages` | `50` | Maximum pages to crawl |
| `rateLimitMs` | `500` | Delay between requests (ms) |
| `baseUrl` | start URL origin | Boundary for same-origin enforcement |

---

### `DocumentParser`

File parser. Source: [src/services/ingestion/documentParser.ts](src/services/ingestion/documentParser.ts)

| Extension | Handling |
|---|---|
| `.txt` `.md` `.ts` `.js` | Read as plain text |
| `.json` | Parsed and pretty-printed |
| `.csv` | Converted to `header: value` lines per row |

---

### `TechnicalAnalysis`

Pure functions for financial technical indicators. Source: [src/services/TechnicalAnalysis.ts](src/services/TechnicalAnalysis.ts)

---

## Technical Indicators

All indicators are computed from OHLCV (Open, High, Low, Close, Volume) arrays. Use the `analyze(bars)` function to compute everything at once:

```ts
import { TechnicalAnalysis } from './src/services/TechnicalAnalysis';

const result = TechnicalAnalysis.analyze(bars);
// result: { sma, ema, rsi, macd, bollingerBands, atr, obv, vwap, stochastic, signals }
```

| Indicator | Function | Description |
|---|---|---|
| SMA | `calculateSMA(prices, period)` | Simple Moving Average |
| EMA | `calculateEMA(prices, period)` | Exponential Moving Average |
| RSI | `calculateRSI(prices, period?)` | Relative Strength Index (Wilder's, default period 14) |
| MACD | `calculateMACD(prices, fast?, slow?, signal?)` | MACD line, signal line, histogram (defaults: 12, 26, 9) |
| Bollinger Bands | `calculateBollingerBands(prices, period?, stdDev?)` | Upper/middle/lower bands (defaults: 20, 2) |
| ATR | `calculateATR(highs, lows, closes, period?)` | Average True Range (default period 14) |
| OBV | `calculateOBV(closes, volumes)` | On-Balance Volume |
| VWAP | `calculateVWAP(highs, lows, closes, volumes)` | Volume-Weighted Average Price |
| Stochastic | `calculateStochastic(highs, lows, closes, kPeriod?, dPeriod?)` | %K and %D lines (defaults: 14, 3) |

### Signal generation

`generateSignals(indicators)` combines multiple indicators into a directional signal:

- **Signal**: `BUY`, `SELL`, or `HOLD`
- **Strength**: `strong`, `moderate`, or `weak`
- **Score**: Aggregate score from all contributing indicators

---

## Data Flow

### Market ingestion

```
CLI command
  └─ MarketIngestorService.getNGXQuotes() / getUSQuotes()
       ├─ HTTP fetch (NGX REST API / Yahoo Finance v8)
       ├─ Parse response → StockQuote[]
       ├─ Convert each quote to text representation
       ├─ Batch embed (100 texts per API call)
       ├─ Create Qdrant points (deterministic IDs)
       └─ Batch upsert to Qdrant (100 points per call)
```

### Document ingestion

```
CLI command
  └─ IngestorService.ingestUrl() / ingestFile()
       ├─ WebCrawler.start() or DocumentParser.parse()
       ├─ TextSplitter.splitText() → chunks[]
       ├─ Filter already-ingested chunks (SQLite chunkExists)
       ├─ Batch embed new chunks
       ├─ Save metadata to SQLite (ON CONFLICT upsert)
       └─ Batch upsert embeddings to Qdrant
```

### Deduplication

Chunk IDs are deterministic UUIDs:

| Source | ID derivation |
|---|---|
| Market quote | `SHA256(exchange:symbol:date)` |
| Historical bar | `SHA256(exchange:symbol:date)` |
| Web page chunk | `SHA256(url:chunkIndex)` |
| File chunk | `SHA256(file:filePath:chunkIndex)` |

Because IDs are deterministic and Qdrant upsert is idempotent, re-running any ingestion command with the same data is safe and produces no duplicates.
