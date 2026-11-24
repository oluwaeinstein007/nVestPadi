/**
 * The seam between the repositories and a concrete database. Repositories are written once, in SQL that runs on
 * both engines (`?` placeholders, `RETURNING`, `ON CONFLICT`, explicit timestamps), against this async interface.
 * Anything engine-specific — placeholder syntax, transactions, schema — lives in a driver.
 */
export type Dialect = "sqlite" | "postgres";

export type Param = string | number | null;

/** A result row. Column names are exactly what the query selected (quote aliases to keep their case). */
export type Row = Record<string, unknown>;

export interface SqlDriver {
	readonly dialect: Dialect;
	/** All rows a query returns. */
	all(sql: string, params?: Param[]): Promise<Row[]>;
	/** The first row, if any. */
	get(sql: string, params?: Param[]): Promise<Row | undefined>;
	/** Rows changed by an INSERT/UPDATE/DELETE. */
	run(sql: string, params?: Param[]): Promise<{ changes: number }>;
	/**
	 * Run `fn` atomically. Queries made inside it (from any depth of awaits) join the transaction; a nested call joins
	 * the outer one. Throwing rolls back.
	 */
	transaction<T>(fn: () => Promise<T>): Promise<T>;
	/**
	 * Serialise a critical section across concurrent requests (and instances): inside a transaction, wait until no
	 * other transaction holds the same key; released when the transaction ends. SQLite transactions are already
	 * exclusive, so there it does nothing.
	 */
	lock(key: string): Promise<void>;
	/** Create or upgrade the schema; returns the resulting schema version. */
	migrate(): Promise<number>;
	schemaVersion(): Promise<number>;
	close(): Promise<void>;
}

/** UTC timestamp in the format stored in every TEXT timestamp column: `YYYY-MM-DD HH:MM:SS`. */
export function timestamp(date: Date = new Date()): string {
	return date.toISOString().slice(0, 19).replace("T", " ");
}

/** `timestamp()` for N seconds from now. */
export function inSeconds(seconds: number): string {
	return timestamp(new Date(Date.now() + Math.round(seconds) * 1000));
}

/** `(?, ?, ?), (?, ?, ?)` — a multi-row VALUES list. */
export function valuesList(rows: number, columns: number): string {
	const row = `(${Array(columns).fill("?").join(", ")})`;
	return Array(rows).fill(row).join(", ");
}

/** `?, ?, ?` for an IN (...) list. */
export function placeholders(count: number): string {
	return Array(count).fill("?").join(", ");
}

/** Split a list into slices so a single statement never exceeds a database's parameter limit. */
export function slices<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** True when `err` is a UNIQUE / primary-key violation from either engine. */
export function isUniqueViolation(err: unknown): boolean {
	const e = err as { code?: string; message?: string } | null;
	return e?.code === "23505" || /UNIQUE constraint failed/i.test(e?.message ?? "");
}
