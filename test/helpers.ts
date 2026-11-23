import type { PriceBar, Security } from "../src/markets/types.js";
import type { EmailMessage, Mailer } from "../src/services/mailer.js";
import { Database } from "../src/storage/database.js";
import type { User } from "../src/storage/repositories/users.js";

export function memoryDb(): Database {
	return new Database(":memory:");
}

/** Deterministic synthetic daily bars for a symbol. */
export function makeBars(
	symbol: string,
	closes: number[],
	exchange: "NGX" | "US" = "NGX",
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
	exchange: "NGX" | "US" = "NGX",
): Security {
	return { exchange, symbol, name, sector, currency: exchange === "NGX" ? "NGN" : "USD" };
}

export function seed(db: Database, entries: { s: Security; closes: number[] }[]) {
	db.market.upsertSecurities(entries.map((e) => e.s));
	for (const e of entries) db.market.upsertPrices(makeBars(e.s.symbol, e.closes, e.s.exchange));
}

/** Insert a user directly (no password hashing), for service-level tests. */
export function user(
	db: Database,
	overrides: { email?: string; plan?: "free" | "pro"; role?: "admin" | "member" } = {},
): User {
	return db.users.create({
		email: overrides.email ?? `u${db.users.count() + 1}@example.com`,
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
