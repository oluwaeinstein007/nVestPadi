/**
 * SQLite persistence (Node's built-in `node:sqlite`, no native addon).
 *
 * `Database` owns the connection, migrations and transactions; each domain has
 * its own repository hanging off it (`db.market`, `db.users`, …) so callers
 * share one connection without one giant class.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.js";
import { AlertRepository } from "./repositories/alerts.js";
import { HoldingsRepository } from "./repositories/holdings.js";
import { JobStateRepository } from "./repositories/jobState.js";
import { KnowledgeLedger } from "./repositories/knowledge.js";
import { MarketRepository } from "./repositories/market.js";
import { UsageRepository } from "./repositories/usage.js";
import { UserRepository } from "./repositories/users.js";
import { WatchlistRepository } from "./repositories/watchlist.js";

export class Database {
	private readonly conn: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();
	private depth = 0;

	readonly market: MarketRepository;
	readonly ledger: KnowledgeLedger;
	readonly users: UserRepository;
	readonly watchlist: WatchlistRepository;
	readonly alerts: AlertRepository;
	readonly usage: UsageRepository;
	readonly holdings: HoldingsRepository;
	readonly jobs: JobStateRepository;

	constructor(file: string) {
		if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
		this.conn = new DatabaseSync(file);
		this.conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		this.migrate();
		this.market = new MarketRepository(this);
		this.ledger = new KnowledgeLedger(this);
		this.users = new UserRepository(this);
		this.watchlist = new WatchlistRepository(this);
		this.alerts = new AlertRepository(this);
		this.usage = new UsageRepository(this);
		this.holdings = new HoldingsRepository(this);
		this.jobs = new JobStateRepository(this);
	}

	private migrate() {
		const { user_version: current } = this.conn.prepare("PRAGMA user_version").get() as { user_version: number };
		for (let v = current; v < MIGRATIONS.length; v++) {
			this.transaction(() => {
				this.conn.exec(MIGRATIONS[v] as string);
				this.conn.exec(`PRAGMA user_version = ${v + 1}`);
			});
		}
	}

	/** Throws if the database can't be queried (used by the health check). */
	ping() {
		this.prepare("SELECT 1").get();
	}

	get schemaVersion(): number {
		return (this.conn.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	}

	/** Prepared statements are cached by SQL text. */
	prepare(sql: string): StatementSync {
		let stmt = this.statements.get(sql);
		if (!stmt) {
			stmt = this.conn.prepare(sql);
			this.statements.set(sql, stmt);
		}
		return stmt;
	}

	/** Runs `fn` atomically. Nested calls join the outer transaction. */
	transaction<T>(fn: () => T): T {
		if (this.depth > 0) return fn();
		this.conn.exec("BEGIN IMMEDIATE");
		this.depth++;
		try {
			const result = fn();
			this.conn.exec("COMMIT");
			return result;
		} catch (err) {
			this.conn.exec("ROLLBACK");
			throw err;
		} finally {
			this.depth--;
		}
	}

	stats() {
		const one = (sql: string) => (this.prepare(sql).get() as { n: number }).n;
		return {
			securities: one("SELECT COUNT(*) AS n FROM securities"),
			prices: one("SELECT COUNT(*) AS n FROM daily_prices"),
			indexedChunks: one("SELECT COUNT(*) AS n FROM indexed_chunks"),
			users: one("SELECT COUNT(*) AS n FROM users"),
			lastPriceDate: (this.prepare("SELECT MAX(date) AS d FROM daily_prices").get() as { d: string | null }).d ?? null,
		};
	}

	close() {
		if (this.conn.isOpen) this.conn.close();
	}
}

/** SQLite datetime modifier for "now + N seconds", e.g. `datetime('now', ?)`. */
export const inSeconds = (seconds: number) => `+${Math.round(seconds)} seconds`;
