# Architecture & Developer Guide

This document covers internal design decisions, extension points, and patterns used throughout the codebase.

---

## Core Design Principles

### 1. Idempotent ingestion via deterministic IDs

Every chunk of content maps to a deterministic UUID derived from its source identity:

```
market quote  →  SHA256("NGX:DANGCEM:2024-01-15")
web chunk     →  SHA256("https://example.com:3")
file chunk    →  SHA256("file:/abs/path/report.csv:7")
```

The same data always produces the same ID. Since Qdrant `upsert` overwrites on collision, and SQLite uses `ON CONFLICT(chunkId) DO UPDATE SET`, re-running ingestion is always safe.

### 2. Collect-then-batch pattern

All ingestion paths follow the same structure:

```
1. Collect all items (quotes, chunks, bars)
2. Filter already-ingested items (SQLite lookup)
3. embedDocuments(all_texts)   ← single batch API call
4. batchUpsert(all_points)     ← single batch DB call
```

This minimises API round-trips and avoids the N+1 problem of per-item embedding calls.

### 3. Graceful degradation

| Component | Fallback behaviour |
|---|---|
| Qdrant unavailable | `QDRANT_ENABLED=false` skips all vector ops |
| Embedding API fails | Zero-vector returned; ingestion continues |
| `better-sqlite3` missing | In-memory `Map` replaces SQLite |

---

## Module Dependency Map

```
scripts/run_ingest.ts
├── src/services/marketIngestorService.ts
│   ├── src/lib/llm.ts
│   ├── src/lib/http.ts
│   ├── src/services/storage/qdrantService.ts
│   └── src/services/TechnicalAnalysis.ts
└── src/services/ingestorService.ts
    ├── src/lib/llm.ts
    ├── src/services/chunking/textSplitter.ts
    ├── src/services/ingestion/webCrawler.ts
    ├── src/services/ingestion/documentParser.ts
    ├── src/services/storage/qdrantService.ts
    └── src/services/storage/database.ts
```

---

## Adding a New Data Source

To add a new market or document source:

1. **Create a fetcher** in `src/services/ingestion/` or extend `marketIngestorService.ts`.
2. **Normalise to text**: Each item becomes a plain-text string representation.
3. **Generate deterministic IDs**: Use `crypto.createHash('sha256').update(uniqueKey).digest('hex')` then convert to UUID v5 format (or use the existing pattern in `marketIngestorService.ts`).
4. **Call the batch helpers**:
   - `llm.embedDocuments(texts)` for embeddings
   - `qdrantService.batchUpsert(points)` for vector storage
   - `db.saveDocument(doc)` for metadata (if applicable)
5. **Add a CLI command** in `scripts/run_ingest.ts`.

---

## Qdrant Collection Schema

```
Collection: nvestpadi (default)
Vector: cosine distance, size = EMBEDDING_VECTOR_SIZE (default 1536)

Payload indexes (keyword type):
  - exchange       (e.g. "NGX", "US")
  - stock_symbol   (e.g. "AAPL", "DANGCEM")
  - date           (e.g. "2024-01-15")
```

Payload for market quotes includes:
```json
{
  "type": "market_quote",
  "exchange": "NGX",
  "stock_symbol": "DANGCEM",
  "date": "2024-01-15",
  "company_name": "Dangote Cement PLC",
  "sector": "Industrial Goods",
  "open": 320.0,
  "high": 325.0,
  "low": 318.0,
  "close": 322.5,
  "volume": 1234567,
  "content": "..."
}
```

Payload for document chunks includes:
```json
{
  "type": "web_chunk",
  "source": "https://example.com/page",
  "chunkIndex": 3,
  "title": "Page Title",
  "content": "...",
  "ingested_at": "2024-01-15T10:00:00Z"
}
```

---

## Embedding Providers

### OpenAI

Uses `@langchain/openai`. Set:
```
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
EMBEDDING_VECTOR_SIZE=1536
```

Default model: `text-embedding-ada-002`. To use `text-embedding-3-large` (3072 dims), configure inside `src/lib/llm.ts` and update `EMBEDDING_VECTOR_SIZE`.

### Gemini

Direct REST API calls to `https://generativelanguage.googleapis.com`. Set:
```
LLM_PROVIDER=gemini
GOOGLE_API_KEY=AIza...
EMBEDDING_VECTOR_SIZE=768
```

Model: `text-embedding-004`.

---

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chunkId     TEXT UNIQUE NOT NULL,
  source      TEXT NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT,
  metadata    TEXT,
  ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_source ON documents(source);
CREATE INDEX IF NOT EXISTS idx_type   ON documents(type);
```

WAL mode is enabled (`PRAGMA journal_mode=WAL`) for concurrent read access. Foreign keys are enabled but not currently used.

---

## Text Splitting Strategy

`TextSplitter` uses a recursive descent through separator priority:

```
1. Try splitting on '\n\n'  (paragraph breaks)
2. Try splitting on '\n'    (line breaks)
3. Try splitting on '. '    (sentence breaks)
4. Try splitting on ' '     (word breaks)
5. Hard split at chunkSize  (last resort)
```

After splitting, an overlap of `chunkOverlap` characters from the end of chunk N is prepended to chunk N+1. This preserves context continuity across chunk boundaries.

---

## Web Crawler Behaviour

- Same-origin enforcement: only follows links whose `hostname` matches the start URL
- Removes: `script`, `style`, `nav`, `footer`, `header`, `aside`, `noscript`
- Rate limiting: 500 ms sleep between page requests (configurable)
- Does not implement `robots.txt` parsing (disabled by default flag)
- Returns a `Map<url, CrawledPage>` — each page has `content`, `title`, `links`, and `metadata`

---

## CLI `.env` Loading

`scripts/run_ingest.ts` loads `.env` from the project root without requiring `dotenv` as a runtime dependency. It reads the file, splits on `\n`, strips comments and empty lines, and calls `process.env[key] = value` for each entry. This means `.env` must be present at the project root when running CLI commands.
