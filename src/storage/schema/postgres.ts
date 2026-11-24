/**
 * PostgreSQL schema migrations, tracked in the `schema_migrations` table and applied under an advisory lock (so two
 * instances booting at once — e.g. during an overlapping deploy — can't race).
 *
 * Mirrors the SQLite schema (`sqlite.ts`) so the repositories' SQL runs unchanged on both:
 *  - timestamps are TEXT in `YYYY-MM-DD HH:MM:SS` UTC, exactly like SQLite, so they compare and sort the same way;
 *  - booleans are 0/1 INTEGERs;
 *  - SQLite's REAL becomes DOUBLE PRECISION (Postgres REAL is 4 bytes and would corrupt prices and volumes);
 *  - email uniqueness is case-insensitive through a unique index on LOWER(email).
 *
 * Append new entries; never edit an existing one. Every change here needs its SQLite twin.
 */
const NOW = "to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')";

export const POSTGRES_MIGRATIONS: string[] = [
	// 1 — baseline, equivalent to SQLite migrations 1–3
	`
	CREATE TABLE securities (
		exchange   TEXT NOT NULL,
		symbol     TEXT NOT NULL,
		name       TEXT NOT NULL,
		sector     TEXT,
		currency   TEXT NOT NULL,
		venue      TEXT,
		industry   TEXT,
		market_cap DOUBLE PRECISION,
		source_id  TEXT,
		updated_at TEXT NOT NULL DEFAULT (${NOW}),
		PRIMARY KEY (exchange, symbol)
	);

	CREATE TABLE daily_prices (
		exchange   TEXT NOT NULL,
		symbol     TEXT NOT NULL,
		date       TEXT NOT NULL,
		open       DOUBLE PRECISION,
		high       DOUBLE PRECISION,
		low        DOUBLE PRECISION,
		close      DOUBLE PRECISION NOT NULL,
		volume     DOUBLE PRECISION,
		change     DOUBLE PRECISION,
		change_pct DOUBLE PRECISION,
		trades     INTEGER,
		value      DOUBLE PRECISION,
		PRIMARY KEY (exchange, symbol, date)
	);
	CREATE INDEX idx_prices_date ON daily_prices (exchange, date);

	CREATE TABLE indexed_chunks (
		id           TEXT PRIMARY KEY,
		kind         TEXT NOT NULL,
		source       TEXT NOT NULL,
		title        TEXT,
		content_hash TEXT NOT NULL,
		indexed_at   TEXT NOT NULL DEFAULT (${NOW})
	);
	CREATE INDEX idx_chunks_source ON indexed_chunks (source);

	CREATE TABLE users (
		id                      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		email                   TEXT NOT NULL,
		name                    TEXT NOT NULL,
		password_hash           TEXT NOT NULL,
		role                    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
		plan                    TEXT NOT NULL DEFAULT 'free',
		plan_renews_at          TEXT,
		email_verified_at       TEXT,
		onboarded_at            TEXT,
		default_exchange        TEXT NOT NULL DEFAULT 'NGX',
		email_alerts            INTEGER NOT NULL DEFAULT 1,
		telegram_chat_id        TEXT,
		discord_webhook_url     TEXT,
		billing_customer_id     TEXT,
		billing_subscription_id TEXT,
		daily_digest            INTEGER NOT NULL DEFAULT 1,
		last_digest_on          TEXT,
		created_at              TEXT NOT NULL DEFAULT (${NOW}),
		last_login_at           TEXT
	);
	CREATE UNIQUE INDEX users_email_lower ON users (LOWER(email));

	CREATE TABLE sessions (
		id           TEXT PRIMARY KEY,
		user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		user_agent   TEXT,
		ip           TEXT,
		created_at   TEXT NOT NULL DEFAULT (${NOW}),
		last_seen_at TEXT NOT NULL DEFAULT (${NOW}),
		expires_at   TEXT NOT NULL
	);
	CREATE INDEX idx_sessions_user ON sessions (user_id);

	CREATE TABLE auth_tokens (
		id         TEXT PRIMARY KEY,
		user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		purpose    TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (${NOW}),
		expires_at TEXT NOT NULL
	);
	CREATE INDEX idx_auth_tokens_user ON auth_tokens (user_id, purpose);

	CREATE TABLE api_tokens (
		id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		name         TEXT NOT NULL,
		token_hash   TEXT NOT NULL UNIQUE,
		prefix       TEXT NOT NULL,
		created_at   TEXT NOT NULL DEFAULT (${NOW}),
		last_used_at TEXT
	);

	CREATE TABLE usage (
		user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		day     TEXT NOT NULL,
		metric  TEXT NOT NULL,
		count   INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, day, metric)
	);

	CREATE TABLE watchlist (
		id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		user_id  INTEGER REFERENCES users (id) ON DELETE CASCADE,
		exchange TEXT NOT NULL,
		symbol   TEXT NOT NULL,
		added_at TEXT NOT NULL DEFAULT (${NOW}),
		UNIQUE (user_id, exchange, symbol)
	);

	CREATE TABLE alerts (
		id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		user_id       INTEGER REFERENCES users (id) ON DELETE CASCADE,
		exchange      TEXT NOT NULL,
		symbol        TEXT NOT NULL,
		condition     TEXT NOT NULL,
		threshold     DOUBLE PRECISION NOT NULL,
		note          TEXT,
		created_at    TEXT NOT NULL DEFAULT (${NOW}),
		triggered_at  TEXT,
		trigger_value DOUBLE PRECISION
	);
	CREATE INDEX idx_alerts_active ON alerts (triggered_at, user_id);

	CREATE TABLE holdings (
		id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		exchange   TEXT NOT NULL,
		symbol     TEXT NOT NULL,
		quantity   DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
		avg_cost   DOUBLE PRECISION NOT NULL CHECK (avg_cost >= 0),
		note       TEXT,
		created_at TEXT NOT NULL DEFAULT (${NOW}),
		updated_at TEXT NOT NULL DEFAULT (${NOW}),
		UNIQUE (user_id, exchange, symbol)
	);

	CREATE TABLE job_state (
		key        TEXT PRIMARY KEY,
		value      TEXT,
		updated_at TEXT NOT NULL DEFAULT (${NOW})
	);
	`,
];
