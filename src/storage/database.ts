/**
 * Persistence entry point. `Database.open` picks the engine from config — SQLite (a local file, the default) or
 * PostgreSQL (a connection URL) — applies migrations, and exposes one repository per domain (`db.market`,
 * `db.users`, …) that all share the connection. The repositories contain no engine-specific code.
 */
import type { DatabaseConfig } from "../config.js";
import type { Dialect, Param, Row, SqlDriver } from "./driver.js";
import { PostgresDriver } from "./postgresDriver.js";
import { AlertRepository } from "./repositories/alerts.js";
import { DisclosureRepository } from "./repositories/disclosures.js";
import { HoldingsRepository } from "./repositories/holdings.js";
import { JobStateRepository } from "./repositories/jobState.js";
import { KnowledgeLedger } from "./repositories/knowledge.js";
import { MarketRepository } from "./repositories/market.js";
import { SignalLogRepository } from "./repositories/signalLog.js";
import { UsageRepository } from "./repositories/usage.js";
import { UserRepository } from "./repositories/users.js";
import { WatchlistRepository } from "./repositories/watchlist.js";
import { SqliteDriver } from "./sqliteDriver.js";

export { isUniqueViolation, timestamp } from "./driver.js";
export type { Param, Row } from "./driver.js";

export class Database {
	readonly market = new MarketRepository(this);
	readonly ledger = new KnowledgeLedger(this);
	readonly users = new UserRepository(this);
	readonly watchlist = new WatchlistRepository(this);
	readonly alerts = new AlertRepository(this);
	readonly usage = new UsageRepository(this);
	readonly holdings = new HoldingsRepository(this);
	readonly jobs = new JobStateRepository(this);
	readonly signals = new SignalLogRepository(this);
	readonly disclosures = new DisclosureRepository(this);
	private closed = false;

	private constructor(private readonly driver: SqlDriver) {}

	/** Connect, migrate and return a ready database. */
	static async open(target: DatabaseConfig): Promise<Database> {
		const driver: SqlDriver =
			target.kind === "postgres"
				? new PostgresDriver({ url: target.url, caCert: target.caCert, poolMax: target.poolMax })
				: new SqliteDriver(target.path);
		try {
			await driver.migrate();
		} catch (err) {
			await driver.close().catch(() => undefined);
			throw err;
		}
		return new Database(driver);
	}

	/** A throwaway in-memory SQLite database (tests, scratch work). */
	static memory(): Promise<Database> {
		return Database.open({ kind: "sqlite", path: ":memory:" });
	}

	get dialect(): Dialect {
		return this.driver.dialect;
	}

	all(sql: string, params?: Param[]): Promise<Row[]> {
		return this.driver.all(sql, params);
	}

	get(sql: string, params?: Param[]): Promise<Row | undefined> {
		return this.driver.get(sql, params);
	}

	run(sql: string, params?: Param[]): Promise<{ changes: number }> {
		return this.driver.run(sql, params);
	}

	/** `SELECT COUNT(*) AS n …` and friends. */
	async count(sql: string, params?: Param[]): Promise<number> {
		return Number((await this.driver.get(sql, params))?.n ?? 0);
	}

	/**
	 * Run `fn` atomically; queries it makes (however deep) join the transaction, and nested calls join the outer one.
	 * Throwing rolls everything back.
	 */
	transaction<T>(fn: () => Promise<T>): Promise<T> {
		return this.driver.transaction(fn);
	}

	/** Inside a transaction: wait until no other transaction holds `key` (e.g. "first account"). */
	lock(key: string): Promise<void> {
		return this.driver.lock(key);
	}

	/** Throws if the database can't be queried (used by the health check). */
	async ping(): Promise<void> {
		await this.driver.get("SELECT 1 AS ok");
	}

	schemaVersion(): Promise<number> {
		return this.driver.schemaVersion();
	}

	async stats() {
		const [securities, prices, indexedChunks, users, last] = await Promise.all([
			this.count("SELECT COUNT(*) AS n FROM securities"),
			this.count("SELECT COUNT(*) AS n FROM daily_prices"),
			this.count("SELECT COUNT(*) AS n FROM indexed_chunks"),
			this.count("SELECT COUNT(*) AS n FROM users"),
			this.get("SELECT MAX(date) AS d FROM daily_prices"),
		]);
		return { securities, prices, indexedChunks, users, lastPriceDate: (last?.d as string | null | undefined) ?? null };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.driver.close();
	}
}
