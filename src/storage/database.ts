/**
 * SQLite persistence (Node's built-in `node:sqlite`, no native addon).
 *
 * Holds structured market data (securities, daily prices), user state
 * (watchlist, alerts) and the ledger of indexed knowledge-base chunks used to
 * skip re-embedding unchanged content. Schema changes go in MIGRATIONS and are
 * applied in order, tracked with `PRAGMA user_version`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Exchange, PriceBar, Quote, Security } from "../markets/types.js";

const MIGRATIONS: string[] = [
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
];

type Row = Record<string, SQLInputValue>;

export interface IndexedChunk {
	id: string;
	kind: string;
	source: string;
	title: string | null;
	contentHash: string;
}

export interface AlertRow {
	id: number;
	exchange: Exchange;
	symbol: string;
	condition: string;
	threshold: number;
	note: string | null;
	createdAt: string;
	triggeredAt: string | null;
	triggerValue: number | null;
}

export class Database {
	private readonly db: DatabaseSync;

	constructor(file: string) {
		if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
		this.db = new DatabaseSync(file);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		this.migrate();
	}

	private migrate() {
		const { user_version: current } = this.db.prepare("PRAGMA user_version").get() as {
			user_version: number;
		};
		for (let v = current; v < MIGRATIONS.length; v++) {
			this.transaction(() => {
				this.db.exec(MIGRATIONS[v] as string);
				this.db.exec(`PRAGMA user_version = ${v + 1}`);
			});
		}
	}

	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	close() {
		if (this.db.isOpen) this.db.close();
	}

	// ---------------------------------------------------------------------------
	// Market data
	// ---------------------------------------------------------------------------

	upsertSecurities(securities: Security[]) {
		const stmt = this.db.prepare(`
			INSERT INTO securities (exchange, symbol, name, sector, currency)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (exchange, symbol) DO UPDATE SET
				name = excluded.name,
				sector = COALESCE(excluded.sector, securities.sector),
				currency = excluded.currency,
				updated_at = datetime('now')
		`);
		this.transaction(() => {
			for (const s of securities) stmt.run(s.exchange, s.symbol, s.name, s.sector, s.currency);
		});
	}

	upsertPrices(bars: PriceBar[]) {
		const stmt = this.db.prepare(`
			INSERT INTO daily_prices
				(exchange, symbol, date, open, high, low, close, volume, change, change_pct, trades, value)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (exchange, symbol, date) DO UPDATE SET
				open = COALESCE(excluded.open, daily_prices.open),
				high = COALESCE(excluded.high, daily_prices.high),
				low = COALESCE(excluded.low, daily_prices.low),
				close = excluded.close,
				volume = COALESCE(excluded.volume, daily_prices.volume),
				change = COALESCE(excluded.change, daily_prices.change),
				change_pct = COALESCE(excluded.change_pct, daily_prices.change_pct),
				trades = COALESCE(excluded.trades, daily_prices.trades),
				value = COALESCE(excluded.value, daily_prices.value)
		`);
		this.transaction(() => {
			for (const b of bars) {
				stmt.run(
					b.exchange,
					b.symbol,
					b.date,
					b.open,
					b.high,
					b.low,
					b.close,
					b.volume,
					b.change,
					b.changePct,
					b.trades,
					b.value,
				);
			}
		});
	}

	getSecurity(exchange: Exchange, symbol: string): Security | null {
		const row = this.db
			.prepare("SELECT * FROM securities WHERE exchange = ? AND symbol = ?")
			.get(exchange, symbol.toUpperCase()) as Row | undefined;
		return row ? toSecurity(row) : null;
	}

	/** Exchanges on which a symbol is known, e.g. to resolve `nvest analyze GTCO`. */
	findExchanges(symbol: string): Exchange[] {
		const rows = this.db
			.prepare("SELECT exchange FROM securities WHERE symbol = ? ORDER BY exchange")
			.all(symbol.toUpperCase()) as { exchange: Exchange }[];
		return rows.map((r) => r.exchange);
	}

	searchSecurities(query: string, exchange?: Exchange, limit = 20): Security[] {
		const like = `%${query.toUpperCase()}%`;
		const rows = this.db
			.prepare(`
				SELECT * FROM securities
				WHERE (UPPER(symbol) LIKE ? OR UPPER(name) LIKE ?) AND (? IS NULL OR exchange = ?)
				ORDER BY (UPPER(symbol) = ?) DESC, (UPPER(symbol) LIKE ?) DESC, symbol
				LIMIT ?
			`)
			.all(
				like,
				like,
				exchange ?? null,
				exchange ?? null,
				query.toUpperCase(),
				`${query.toUpperCase()}%`,
				limit,
			) as Row[];
		return rows.map(toSecurity);
	}

	allSymbols(): { exchange: Exchange; symbol: string; name: string }[] {
		return this.db.prepare("SELECT exchange, symbol, name FROM securities").all() as {
			exchange: Exchange;
			symbol: string;
			name: string;
		}[];
	}

	/** Most recent bar per security (optionally for one exchange), joined with security info. */
	latestQuotes(exchange?: Exchange): Quote[] {
		const rows = this.db
			.prepare(`
				SELECT p.*, s.name, s.sector, s.currency
				FROM daily_prices p
				JOIN securities s ON s.exchange = p.exchange AND s.symbol = p.symbol
				WHERE (? IS NULL OR p.exchange = ?)
				  AND p.date = (
					SELECT MAX(date) FROM daily_prices p2
					WHERE p2.exchange = p.exchange AND p2.symbol = p.symbol
				  )
				ORDER BY p.exchange, p.symbol
			`)
			.all(exchange ?? null, exchange ?? null) as Row[];
		return rows.map(toQuote);
	}

	latestQuote(exchange: Exchange, symbol: string): Quote | null {
		const row = this.db
			.prepare(`
				SELECT p.*, s.name, s.sector, s.currency
				FROM daily_prices p
				JOIN securities s ON s.exchange = p.exchange AND s.symbol = p.symbol
				WHERE p.exchange = ? AND p.symbol = ?
				ORDER BY p.date DESC LIMIT 1
			`)
			.get(exchange, symbol.toUpperCase()) as Row | undefined;
		return row ? toQuote(row) : null;
	}

	/** Daily bars ordered oldest → newest; `limit` keeps the most recent N. */
	history(exchange: Exchange, symbol: string, limit = 400): PriceBar[] {
		const rows = this.db
			.prepare(`
				SELECT * FROM (
					SELECT * FROM daily_prices WHERE exchange = ? AND symbol = ?
					ORDER BY date DESC LIMIT ?
				) ORDER BY date ASC
			`)
			.all(exchange, symbol.toUpperCase(), limit) as Row[];
		return rows.map(toBar);
	}

	stats() {
		const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
		return {
			securities: one("SELECT COUNT(*) AS n FROM securities"),
			prices: one("SELECT COUNT(*) AS n FROM daily_prices"),
			indexedChunks: one("SELECT COUNT(*) AS n FROM indexed_chunks"),
			lastPriceDate:
				(this.db.prepare("SELECT MAX(date) AS d FROM daily_prices").get() as { d: string | null }).d ?? null,
		};
	}

	// ---------------------------------------------------------------------------
	// Knowledge-base ledger
	// ---------------------------------------------------------------------------

	/** Map of id → content hash for the given chunk IDs that are already indexed. */
	indexedHashes(ids: string[]): Map<string, string> {
		const out = new Map<string, string>();
		const stmt = this.db.prepare("SELECT content_hash FROM indexed_chunks WHERE id = ?");
		for (const id of ids) {
			const row = stmt.get(id) as { content_hash: string } | undefined;
			if (row) out.set(id, row.content_hash);
		}
		return out;
	}

	recordIndexed(chunks: IndexedChunk[]) {
		const stmt = this.db.prepare(`
			INSERT INTO indexed_chunks (id, kind, source, title, content_hash)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				content_hash = excluded.content_hash, title = excluded.title, indexed_at = datetime('now')
		`);
		this.transaction(() => {
			for (const c of chunks) stmt.run(c.id, c.kind, c.source, c.title, c.contentHash);
		});
	}

	listSources(
		limit = 100,
	): { source: string; kind: string; title: string | null; chunks: number; indexedAt: string }[] {
		return this.db
			.prepare(`
				SELECT source, kind, MAX(title) AS title, COUNT(*) AS chunks, MAX(indexed_at) AS indexedAt
				FROM indexed_chunks WHERE kind != 'quote'
				GROUP BY source, kind ORDER BY indexedAt DESC LIMIT ?
			`)
			.all(limit) as { source: string; kind: string; title: string | null; chunks: number; indexedAt: string }[];
	}

	// ---------------------------------------------------------------------------
	// Watchlist
	// ---------------------------------------------------------------------------

	addToWatchlist(exchange: Exchange, symbol: string) {
		this.db
			.prepare("INSERT OR IGNORE INTO watchlist (exchange, symbol) VALUES (?, ?)")
			.run(exchange, symbol.toUpperCase());
	}

	removeFromWatchlist(exchange: Exchange, symbol: string): boolean {
		const r = this.db
			.prepare("DELETE FROM watchlist WHERE exchange = ? AND symbol = ?")
			.run(exchange, symbol.toUpperCase());
		return Number(r.changes) > 0;
	}

	watchlist(): { exchange: Exchange; symbol: string; addedAt: string }[] {
		return this.db.prepare("SELECT exchange, symbol, added_at AS addedAt FROM watchlist ORDER BY added_at").all() as {
			exchange: Exchange;
			symbol: string;
			addedAt: string;
		}[];
	}

	// ---------------------------------------------------------------------------
	// Alerts
	// ---------------------------------------------------------------------------

	createAlert(a: {
		exchange: Exchange;
		symbol: string;
		condition: string;
		threshold: number;
		note?: string;
	}): AlertRow {
		const r = this.db
			.prepare("INSERT INTO alerts (exchange, symbol, condition, threshold, note) VALUES (?, ?, ?, ?, ?)")
			.run(a.exchange, a.symbol.toUpperCase(), a.condition, a.threshold, a.note ?? null);
		return this.getAlert(Number(r.lastInsertRowid)) as AlertRow;
	}

	getAlert(id: number): AlertRow | null {
		const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as Row | undefined;
		return row ? toAlert(row) : null;
	}

	listAlerts(options: { activeOnly?: boolean } = {}): AlertRow[] {
		const rows = this.db
			.prepare(`SELECT * FROM alerts ${options.activeOnly ? "WHERE triggered_at IS NULL" : ""} ORDER BY id`)
			.all() as Row[];
		return rows.map(toAlert);
	}

	markAlertTriggered(id: number, value: number) {
		this.db.prepare("UPDATE alerts SET triggered_at = datetime('now'), trigger_value = ? WHERE id = ?").run(value, id);
	}

	deleteAlert(id: number): boolean {
		return Number(this.db.prepare("DELETE FROM alerts WHERE id = ?").run(id).changes) > 0;
	}
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const num = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : Number(v));

function toSecurity(r: Row): Security {
	return {
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		name: String(r.name),
		sector: (r.sector as string | null) ?? null,
		currency: String(r.currency),
	};
}

function toBar(r: Row): PriceBar {
	return {
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		date: String(r.date),
		open: num(r.open),
		high: num(r.high),
		low: num(r.low),
		close: Number(r.close),
		volume: num(r.volume),
		change: num(r.change),
		changePct: num(r.change_pct),
		trades: num(r.trades),
		value: num(r.value),
	};
}

function toQuote(r: Row): Quote {
	return {
		...toBar(r),
		name: String(r.name),
		sector: (r.sector as string | null) ?? null,
		currency: String(r.currency),
	};
}

function toAlert(r: Row): AlertRow {
	return {
		id: Number(r.id),
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		condition: String(r.condition),
		threshold: Number(r.threshold),
		note: (r.note as string | null) ?? null,
		createdAt: String(r.created_at),
		triggeredAt: (r.triggered_at as string | null) ?? null,
		triggerValue: num(r.trigger_value),
	};
}
