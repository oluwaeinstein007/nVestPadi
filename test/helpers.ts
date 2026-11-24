import pg from "pg";
import type { DatabaseConfig } from "../src/config.js";
import { CoinGecko } from "../src/markets/coingecko.js";
import type { Exchange, PriceBar, Security } from "../src/markets/types.js";
import type { EmailMessage, Mailer } from "../src/services/mailer.js";
import { Database } from "../src/storage/database.js";
import type { User } from "../src/storage/repositories/users.js";

const schemas: { admin: pg.Pool; name: string }[] = [];

/** A connection URL for a brand-new schema on the PostgreSQL server in TEST_DATABASE_URL, or null for SQLite runs. */
async function freshPostgresUrl(): Promise<string | null> {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) return null;
	const name = `t_${Math.random().toString(36).slice(2, 10)}`;
	const admin = new pg.Pool({ connectionString: url, max: 1 });
	await admin.query(`CREATE SCHEMA ${name}`);
	schemas.push({ admin, name });
	const target = new URL(url);
	target.searchParams.set("options", `-c search_path=${name}`);
	return target.toString();
}

/**
 * A fresh, empty database. In-memory SQLite by default; set TEST_DATABASE_URL to run the same tests against a real
 * PostgreSQL server (each call gets its own throwaway schema, dropped by `dropTestDatabases`).
 */
export async function memoryDb(): Promise<Database> {
	const url = await freshPostgresUrl();
	if (!url) return Database.memory();
	const config: DatabaseConfig = { kind: "postgres", url, poolMax: 3 };
	return Database.open(config);
}

/** Environment for `parseConfig` that points the app at a fresh database (see `memoryDb`). */
export async function testEnv(env: Record<string, string> = {}): Promise<Record<string, string>> {
	const url = await freshPostgresUrl();
	return { NODE_ENV: "test", ...(url ? { DATABASE_URL: url } : { DATABASE_PATH: ":memory:" }), ...env };
}

/** Drop the schemas created by `memoryDb` (a no-op for SQLite). Call from an `after` hook. */
export async function dropTestDatabases(): Promise<void> {
	for (const { admin, name } of schemas.splice(0)) {
		await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => undefined);
		await admin.end().catch(() => undefined);
	}
}

/** Deterministic synthetic daily bars for a symbol. */
export function makeBars(
	symbol: string,
	closes: number[],
	exchange: Exchange = "NGX",
	start = "2025-01-01",
): PriceBar[] {
	const day = new Date(`${start}T00:00:00Z`);
	return closes.map((close, i) => {
		const date = new Date(day.getTime() + i * 86_400_000).toISOString().slice(0, 10);
		const prev = closes[i - 1];
		return {
			exchange,
			symbol,
			date,
			open: close,
			high: close * 1.01,
			low: close * 0.99,
			close,
			volume: 1000 + i,
			change: prev === undefined ? null : close - prev,
			changePct: prev === undefined ? null : ((close - prev) / prev) * 100,
			trades: null,
			value: null,
		};
	});
}

export function security(
	symbol: string,
	name: string,
	sector: string | null = null,
	exchange: Exchange = "NGX",
): Security {
	return { exchange, symbol, name, sector, currency: exchange === "NGX" ? "NGN" : "USD" };
}

export async function seed(db: Database, entries: { s: Security; closes: number[] }[]) {
	await db.market.upsertSecurities(entries.map((e) => e.s));
	for (const e of entries) await db.market.upsertPrices(makeBars(e.s.symbol, e.closes, e.s.exchange));
}

/** Insert a user directly (no password hashing), for service-level tests. */
export async function user(
	db: Database,
	overrides: { email?: string; plan?: "free" | "pro"; role?: "admin" | "member" } = {},
): Promise<User> {
	return db.users.create({
		email: overrides.email ?? `u${(await db.users.count()) + 1}@example.com`,
		name: "Test User",
		passwordHash: "x",
		role: overrides.role,
		plan: overrides.plan,
		emailVerified: true,
	});
}

/** Captures outgoing email so tests can follow verification/reset links. */
export class TestMailer implements Mailer {
	readonly name = "test";
	readonly delivers = true;
	sent: EmailMessage[] = [];
	async send(message: EmailMessage) {
		this.sent.push(message);
	}
	/** The token from the most recent email's link. */
	lastToken(): string {
		const match = /token=([\w%-]+)/.exec(this.sent.at(-1)?.text ?? "");
		if (!match?.[1]) throw new Error("no token in last email");
		return decodeURIComponent(match[1]);
	}
}

/** MarketService options for tests that never touch the network. */
export const marketOptions = { usSymbols: [] as string[], coingecko: new CoinGecko() };
