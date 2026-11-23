/**
 * Ordered schema migrations, applied in transactions and tracked with
 * `PRAGMA user_version`. Append new entries; never edit an existing one.
 */
export const MIGRATIONS: string[] = [
	// 1 — v2.0: market data, knowledge-base ledger, single-user watchlist and alerts
	`
	CREATE TABLE securities (
		exchange   TEXT NOT NULL,
		symbol     TEXT NOT NULL,
		name       TEXT NOT NULL,
		sector     TEXT,
		currency   TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (exchange, symbol)
	);
	CREATE TABLE daily_prices (
		exchange   TEXT NOT NULL,
		symbol     TEXT NOT NULL,
		date       TEXT NOT NULL,
		open       REAL,
		high       REAL,
		low        REAL,
		close      REAL NOT NULL,
		volume     REAL,
		change     REAL,
		change_pct REAL,
		trades     INTEGER,
		value      REAL,
		PRIMARY KEY (exchange, symbol, date)
	);
	CREATE INDEX idx_prices_date ON daily_prices (exchange, date);
	CREATE TABLE indexed_chunks (
		id           TEXT PRIMARY KEY,
		kind         TEXT NOT NULL,
		source       TEXT NOT NULL,
		title        TEXT,
		content_hash TEXT NOT NULL,
		indexed_at   TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX idx_chunks_source ON indexed_chunks (source);
	CREATE TABLE watchlist (
		exchange TEXT NOT NULL,
		symbol   TEXT NOT NULL,
		added_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (exchange, symbol)
	);
	CREATE TABLE alerts (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		exchange     TEXT NOT NULL,
		symbol       TEXT NOT NULL,
		condition    TEXT NOT NULL,
		threshold    REAL NOT NULL,
		note         TEXT,
		created_at   TEXT NOT NULL DEFAULT (datetime('now')),
		triggered_at TEXT,
		trigger_value REAL
	);
	`,

	// 2 — v3.0: accounts, sessions, tokens, plans and per-user watchlists/alerts.
	// Pre-existing watchlist/alert rows keep user_id NULL until the first account claims them.
	`
	CREATE TABLE users (
		id                  INTEGER PRIMARY KEY AUTOINCREMENT,
		email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
		name                TEXT NOT NULL,
		password_hash       TEXT NOT NULL,
		role                TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
		plan                TEXT NOT NULL DEFAULT 'free',
		plan_renews_at      TEXT,
		email_verified_at   TEXT,
		onboarded_at        TEXT,
		default_exchange    TEXT NOT NULL DEFAULT 'NGX',
		email_alerts        INTEGER NOT NULL DEFAULT 1,
		telegram_chat_id    TEXT,
		discord_webhook_url TEXT,
		billing_customer_id     TEXT,
		billing_subscription_id TEXT,
		created_at          TEXT NOT NULL DEFAULT (datetime('now')),
		last_login_at       TEXT
	);
	CREATE TABLE sessions (
		id           TEXT PRIMARY KEY,
		user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		user_agent   TEXT,
		ip           TEXT,
		created_at   TEXT NOT NULL DEFAULT (datetime('now')),
		last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
		expires_at   TEXT NOT NULL
	);
	CREATE INDEX idx_sessions_user ON sessions (user_id);
	CREATE TABLE auth_tokens (
		id         TEXT PRIMARY KEY,
		user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		purpose    TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		expires_at TEXT NOT NULL
	);
	CREATE INDEX idx_auth_tokens_user ON auth_tokens (user_id, purpose);
	CREATE TABLE api_tokens (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		name         TEXT NOT NULL,
		token_hash   TEXT NOT NULL UNIQUE,
		prefix       TEXT NOT NULL,
		created_at   TEXT NOT NULL DEFAULT (datetime('now')),
		last_used_at TEXT
	);
	CREATE TABLE usage (
		user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		day     TEXT NOT NULL,
		metric  TEXT NOT NULL,
		count   INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, day, metric)
	);

	CREATE TABLE watchlist_v3 (
		id       INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id  INTEGER REFERENCES users (id) ON DELETE CASCADE,
		exchange TEXT NOT NULL,
		symbol   TEXT NOT NULL,
		added_at TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (user_id, exchange, symbol)
	);
	INSERT INTO watchlist_v3 (exchange, symbol, added_at) SELECT exchange, symbol, added_at FROM watchlist;
	DROP TABLE watchlist;
	ALTER TABLE watchlist_v3 RENAME TO watchlist;

	ALTER TABLE alerts ADD COLUMN user_id INTEGER REFERENCES users (id) ON DELETE CASCADE;
	CREATE INDEX idx_alerts_active ON alerts (triggered_at, user_id);
	`,

	// 3 — v3.1: listing metadata, crypto ids, portfolios, digests, Telegram linking, job bookkeeping
	`
	ALTER TABLE securities ADD COLUMN venue TEXT;
	ALTER TABLE securities ADD COLUMN industry TEXT;
	ALTER TABLE securities ADD COLUMN market_cap REAL;
	ALTER TABLE securities ADD COLUMN source_id TEXT;

	ALTER TABLE users ADD COLUMN daily_digest INTEGER NOT NULL DEFAULT 1;
	ALTER TABLE users ADD COLUMN last_digest_on TEXT;

	CREATE TABLE holdings (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		exchange   TEXT NOT NULL,
		symbol     TEXT NOT NULL,
		quantity   REAL NOT NULL CHECK (quantity > 0),
		avg_cost   REAL NOT NULL CHECK (avg_cost >= 0),
		note       TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (user_id, exchange, symbol)
	);

	-- Small key/value store for idempotent jobs (e.g. "digest:NGX:2026-11-24" = sent).
	CREATE TABLE job_state (
		key        TEXT PRIMARY KEY,
		value      TEXT,
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	`,
];
