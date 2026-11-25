/**
 * SQLite schema migrations, applied in transactions and tracked with `PRAGMA user_version`.
 * Append new entries; never edit an existing one — real databases are already past them.
 * Keep `postgres.ts` in step: every change here needs the equivalent there.
 */
export const SQLITE_MIGRATIONS: string[] = [
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

	// 4 — v3.3: the live track record. Every signal the app shows is logged the first time it's seen and scored once
	// it plays out. Entry is the session after the one it was seen in and closed rows are never edited, so nothing can
	// be filled in with hindsight.
	`
	CREATE TABLE signal_log (
		id             INTEGER PRIMARY KEY AUTOINCREMENT,
		exchange       TEXT NOT NULL,
		symbol         TEXT NOT NULL,
		side           TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
		rule           TEXT NOT NULL,
		strength       TEXT NOT NULL,
		reason         TEXT NOT NULL,
		evidence       TEXT NOT NULL,
		signal_date    TEXT NOT NULL,
		seen_date      TEXT NOT NULL,
		logged_at      TEXT NOT NULL DEFAULT (datetime('now')),
		ref_price      REAL NOT NULL,
		stop           REAL NOT NULL,
		target         REAL NOT NULL,
		horizon        INTEGER NOT NULL,
		cost_pct       REAL NOT NULL,
		probability    REAL,
		prob_low       REAL,
		prob_high      REAL,
		confidence     TEXT,
		base_rate      REAL,
		past_trades    INTEGER NOT NULL,
		past_win_rate  REAL,
		status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed')),
		entry_date     TEXT,
		entry_price    REAL,
		exit_date      TEXT,
		exit_price     REAL,
		exit_reason    TEXT,
		last_date      TEXT,
		last_price     REAL,
		return_pct     REAL,
		net_return_pct REAL,
		sessions       INTEGER,
		UNIQUE (exchange, symbol, side, rule, signal_date)
	);
	CREATE INDEX idx_signal_log_status ON signal_log (status, exchange);
	CREATE INDEX idx_signal_log_logged ON signal_log (logged_at);
	`,

	// 5 — v3.5: NGX corporate disclosures (filings) and the dividends read from them. Ids are NGX's own list item ids.
	`
	CREATE TABLE disclosures (
		id                  INTEGER PRIMARY KEY,
		exchange            TEXT NOT NULL,
		symbol              TEXT,
		isin                TEXT NOT NULL,
		kind                TEXT NOT NULL,
		category            TEXT NOT NULL,
		company             TEXT NOT NULL,
		title               TEXT NOT NULL,
		url                 TEXT NOT NULL,
		published_at        TEXT NOT NULL,
		dividend_checked_at TEXT,
		scanned             INTEGER NOT NULL DEFAULT 0,
		summary             TEXT,
		summarized_at       TEXT
	);
	CREATE INDEX idx_disclosures_symbol ON disclosures (exchange, symbol, published_at);
	CREATE INDEX idx_disclosures_published ON disclosures (published_at);

	CREATE TABLE dividends (
		disclosure_id      INTEGER PRIMARY KEY REFERENCES disclosures (id) ON DELETE CASCADE,
		exchange           TEXT NOT NULL,
		symbol             TEXT NOT NULL,
		kind               TEXT NOT NULL,
		amount             REAL NOT NULL,
		currency           TEXT NOT NULL,
		qualification_date TEXT,
		closure_start      TEXT,
		closure_end        TEXT,
		payment_date       TEXT,
		agm_date           TEXT,
		bonus              TEXT,
		announced_at       TEXT NOT NULL
	);
	CREATE INDEX idx_dividends_symbol ON dividends (exchange, symbol, qualification_date);
	CREATE INDEX idx_dividends_qualification ON dividends (qualification_date);
	`,

	// 6 — v3.6: scanned filings transcribed by an AI model (retried until done, independently of the dividend check)
	`
	ALTER TABLE disclosures ADD COLUMN transcribed_at TEXT;
	`,
];
