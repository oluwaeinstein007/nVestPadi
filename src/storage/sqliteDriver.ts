/**
 * SQLite via Node's built-in `node:sqlite` (no native addon). One connection, WAL mode.
 *
 * The connection is synchronous but the interface is async, so a transaction that awaits could otherwise let a
 * concurrent request's queries run inside it. A transaction therefore owns the connection: queries from outside it
 * wait their turn, while queries made within it (tracked through async context) go straight through.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { Param, Row, SqlDriver } from "./driver.js";
import { SQLITE_MIGRATIONS } from "./schema/sqlite.js";

export class SqliteDriver implements SqlDriver {
	readonly dialect = "sqlite" as const;
	private readonly conn: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();
	private readonly scope = new AsyncLocalStorage<symbol>();
	private active: { id: symbol; done: Promise<void> } | null = null;

	constructor(file: string) {
		if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
		this.conn = new DatabaseSync(file);
		this.conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	}

	/** Prepared statements are cached by SQL text. */
	private prepare(sql: string): StatementSync {
		let stmt = this.statements.get(sql);
		if (!stmt) {
			stmt = this.conn.prepare(sql);
			this.statements.set(sql, stmt);
		}
		return stmt;
	}

	/** Wait while another async context's transaction owns the connection. */
	private async turn(): Promise<void> {
		while (this.active && this.scope.getStore() !== this.active.id) await this.active.done;
	}

	async all(sql: string, params: Param[] = []): Promise<Row[]> {
		await this.turn();
		return this.prepare(sql).all(...(params as SQLInputValue[])) as Row[];
	}

	async get(sql: string, params: Param[] = []): Promise<Row | undefined> {
		await this.turn();
		return this.prepare(sql).get(...(params as SQLInputValue[])) as Row | undefined;
	}

	async run(sql: string, params: Param[] = []): Promise<{ changes: number }> {
		await this.turn();
		return { changes: Number(this.prepare(sql).run(...(params as SQLInputValue[])).changes) };
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active && this.scope.getStore() === this.active.id) return fn(); // nested: join the outer one
		while (this.active) await this.active.done;

		const id = Symbol("tx");
		let release: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.active = { id, done };
		try {
			this.conn.exec("BEGIN IMMEDIATE");
			try {
				const result = await this.scope.run(id, fn);
				this.conn.exec("COMMIT");
				return result;
			} catch (err) {
				this.conn.exec("ROLLBACK");
				throw err;
			}
		} finally {
			this.active = null;
			release();
		}
	}

	async lock(): Promise<void> {
		// BEGIN IMMEDIATE already makes every transaction exclusive.
	}

	async schemaVersion(): Promise<number> {
		return (this.conn.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	}

	async migrate(): Promise<number> {
		const current = await this.schemaVersion();
		for (let v = current; v < SQLITE_MIGRATIONS.length; v++) {
			await this.transaction(async () => {
				this.conn.exec(SQLITE_MIGRATIONS[v] as string);
				this.conn.exec(`PRAGMA user_version = ${v + 1}`);
			});
		}
		return SQLITE_MIGRATIONS.length;
	}

	async close(): Promise<void> {
		if (this.conn.isOpen) this.conn.close();
	}
}
