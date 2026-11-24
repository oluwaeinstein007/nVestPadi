/**
 * PostgreSQL via `pg` (node-postgres) with a small connection pool.
 *
 * A transaction checks out one connection and every query made inside it — at any depth of awaits, tracked through
 * async context — uses that connection; everything else shares the pool.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { logger } from "../lib/logger.js";
import type { Param, Row, SqlDriver } from "./driver.js";
import { POSTGRES_MIGRATIONS } from "./schema/postgres.js";

// COUNT(*) and SUM() come back as BIGINT/NUMERIC, which node-postgres returns as strings; our counts fit a double.
pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1700, (value) => Number(value));

/** Arbitrary constant: the advisory lock that serialises migrations across instances. */
const MIGRATION_LOCK = 724_158_301;

export interface PostgresOptions {
	url: string;
	/** PEM CA certificate, used to verify the server for `sslmode=verify-ca|verify-full`. */
	caCert?: string;
	poolMax?: number;
}

/**
 * Turn a connection URL into pool settings. `sslmode` follows libpq's meaning (node-postgres has been changing it):
 * `disable` = plaintext; `require` (and prefer/allow) = encrypted without verifying the server's certificate, which is
 * what managed providers with private CAs expect; `verify-ca` / `verify-full` = encrypted and verified (give the
 * provider's CA via `caCert`). No `sslmode` means plaintext for localhost and encrypted for everything else.
 */
export function connectionSettings(options: PostgresOptions): pg.PoolConfig {
	const url = new URL(options.url);
	const mode = url.searchParams.get("sslmode") ?? undefined;
	url.searchParams.delete("sslmode");
	url.searchParams.delete("sslrootcert");

	const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
	let ssl: pg.PoolConfig["ssl"];
	switch (mode ?? (local ? "disable" : "require")) {
		case "disable":
			ssl = false;
			break;
		case "verify-ca":
		case "verify-full":
			ssl = { rejectUnauthorized: true, ...(options.caCert && { ca: options.caCert }) };
			break;
		default:
			ssl = { rejectUnauthorized: false };
	}
	return { connectionString: url.toString(), ssl, max: options.poolMax ?? 5, connectionTimeoutMillis: 15_000 };
}

/** `?` → `$1, $2, …`, leaving anything inside string literals, quoted identifiers and comments alone. */
export function toPositional(sql: string): string {
	let out = "";
	let n = 0;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i] as string;
		if (c === "'" || c === '"') {
			const end = sql.indexOf(c, i + 1);
			const stop = end === -1 ? sql.length : end + 1;
			out += sql.slice(i, stop);
			i = stop - 1;
		} else if (c === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i);
			const stop = end === -1 ? sql.length : end;
			out += sql.slice(i, stop);
			i = stop - 1;
		} else if (c === "?") {
			out += `$${++n}`;
		} else {
			out += c;
		}
	}
	return out;
}

export class PostgresDriver implements SqlDriver {
	readonly dialect = "postgres" as const;
	private readonly pool: pg.Pool;
	private readonly scope = new AsyncLocalStorage<pg.PoolClient>();

	constructor(options: PostgresOptions) {
		this.pool = new pg.Pool(connectionSettings(options));
		// An idle connection dropped by the server must not crash the process; the pool replaces it.
		this.pool.on("error", (err) => logger.warn("postgres: idle connection error", { error: err.message }));
	}

	private exec(sql: string, params?: Param[]) {
		return (this.scope.getStore() ?? this.pool).query(sql, params);
	}

	async all(sql: string, params: Param[] = []): Promise<Row[]> {
		return (await this.exec(toPositional(sql), params)).rows as Row[];
	}

	async get(sql: string, params: Param[] = []): Promise<Row | undefined> {
		return (await this.all(sql, params))[0];
	}

	async run(sql: string, params: Param[] = []): Promise<{ changes: number }> {
		return { changes: (await this.exec(toPositional(sql), params)).rowCount ?? 0 };
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		if (this.scope.getStore()) return fn(); // nested: join the outer one
		const client = await this.pool.connect();
		let broken = false;
		try {
			await client.query("BEGIN");
			try {
				const result = await this.scope.run(client, fn);
				await client.query("COMMIT");
				return result;
			} catch (err) {
				await client.query("ROLLBACK").catch(() => {
					broken = true; // the connection itself failed; don't hand it back to the pool
				});
				throw err;
			}
		} finally {
			client.release(broken);
		}
	}

	async lock(key: string): Promise<void> {
		if (!this.scope.getStore()) throw new Error("lock() must be called inside a transaction");
		await this.exec("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
	}

	async schemaVersion(): Promise<number> {
		try {
			const row = await this.get("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations");
			return Number(row?.v ?? 0);
		} catch {
			return 0; // no schema_migrations table yet
		}
	}

	async migrate(): Promise<number> {
		await this.transaction(async () => {
			await this.exec(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
			await this.exec(`
				CREATE TABLE IF NOT EXISTS schema_migrations (
					version    INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL DEFAULT (to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'))
				)`);
			const current = Number(
				((await this.exec("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")).rows[0] as Row).v,
			);
			for (let v = current; v < POSTGRES_MIGRATIONS.length; v++) {
				await this.exec(POSTGRES_MIGRATIONS[v] as string);
				await this.exec("INSERT INTO schema_migrations (version) VALUES ($1)", [v + 1]);
			}
		});
		return POSTGRES_MIGRATIONS.length;
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}
