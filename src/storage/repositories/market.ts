import type { Exchange, PriceBar, Quote, Security } from "../../markets/types.js";
import type { Database, Row } from "../database.js";
import { slices, timestamp, valuesList } from "../driver.js";
import { num, str } from "../rows.js";

/** Securities and daily prices — shared, read-mostly market data. */
export class MarketRepository {
	constructor(private readonly db: Database) {}

	async upsertSecurities(securities: Security[]) {
		const rows = dedupe(securities, (s) => `${s.exchange}:${s.symbol}`, mergeSecurity);
		if (rows.length === 0) return;
		const now = timestamp();
		await this.db.transaction(async () => {
			for (const batch of slices(rows, 100)) {
				// Sparse sources (e.g. a history fetch without sector) never wipe richer metadata.
				await this.db.run(
					`INSERT INTO securities (exchange, symbol, name, sector, currency, venue, industry, market_cap, source_id)
					 VALUES ${valuesList(batch.length, 9)}
					 ON CONFLICT (exchange, symbol) DO UPDATE SET
						name = CASE WHEN excluded.name = excluded.symbol THEN securities.name ELSE excluded.name END,
						sector = COALESCE(excluded.sector, securities.sector),
						currency = excluded.currency,
						venue = COALESCE(excluded.venue, securities.venue),
						industry = COALESCE(excluded.industry, securities.industry),
						market_cap = COALESCE(excluded.market_cap, securities.market_cap),
						source_id = COALESCE(excluded.source_id, securities.source_id),
						updated_at = ?`,
					[
						...batch.flatMap((s) => [
							s.exchange,
							s.symbol,
							s.name,
							s.sector,
							s.currency,
							s.venue ?? null,
							s.industry ?? null,
							s.marketCap ?? null,
							s.sourceId ?? null,
						]),
						now,
					],
				);
			}
		});
	}

	/** Update listing metadata (sector, venue, …) without touching names or prices. */
	async enrichSecurities(
		exchange: Exchange,
		meta: Map<
			string,
			{ sector?: string | null; industry?: string | null; venue?: string | null; marketCap?: number | null }
		>,
	): Promise<number> {
		let updated = 0;
		await this.db.transaction(async () => {
			for (const [symbol, m] of meta) {
				const r = await this.db.run(
					`UPDATE securities SET
						sector = COALESCE(?, sector),
						industry = COALESCE(?, industry),
						venue = COALESCE(?, venue),
						market_cap = COALESCE(?, market_cap)
					 WHERE exchange = ? AND symbol = ?`,
					[m.sector ?? null, m.industry ?? null, m.venue ?? null, m.marketCap ?? null, exchange, symbol],
				);
				updated += r.changes;
			}
		});
		return updated;
	}

	/** Symbols on an exchange with fewer than `minBars` stored sessions — candidates for backfill. */
	async thinHistory(exchange: Exchange, minBars: number): Promise<string[]> {
		const rows = await this.db.all(
			`SELECT s.symbol FROM securities s
			 LEFT JOIN daily_prices p ON p.exchange = s.exchange AND p.symbol = s.symbol
			 WHERE s.exchange = ? GROUP BY s.symbol HAVING COUNT(p.date) < ? ORDER BY s.symbol`,
			[exchange, minBars],
		);
		return rows.map((r) => String(r.symbol));
	}

	async upsertPrices(bars: PriceBar[]) {
		const rows = dedupe(bars, (b) => `${b.exchange}:${b.symbol}:${b.date}`, mergeBar);
		if (rows.length === 0) return;
		await this.db.transaction(async () => {
			for (const batch of slices(rows, 200)) {
				await this.db.run(
					`INSERT INTO daily_prices
						(exchange, symbol, date, open, high, low, close, volume, change, change_pct, trades, value)
					 VALUES ${valuesList(batch.length, 12)}
					 ON CONFLICT (exchange, symbol, date) DO UPDATE SET
						open = COALESCE(excluded.open, daily_prices.open),
						high = COALESCE(excluded.high, daily_prices.high),
						low = COALESCE(excluded.low, daily_prices.low),
						close = excluded.close,
						volume = COALESCE(excluded.volume, daily_prices.volume),
						change = COALESCE(excluded.change, daily_prices.change),
						change_pct = COALESCE(excluded.change_pct, daily_prices.change_pct),
						trades = COALESCE(excluded.trades, daily_prices.trades),
						value = COALESCE(excluded.value, daily_prices.value)`,
					batch.flatMap((b) => [
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
					]),
				);
			}
		});
	}

	async getSecurity(exchange: Exchange, symbol: string): Promise<Security | null> {
		const row = await this.db.get("SELECT * FROM securities WHERE exchange = ? AND symbol = ?", [
			exchange,
			symbol.toUpperCase(),
		]);
		return row ? toSecurity(row) : null;
	}

	/** Exchanges on which a symbol is known, e.g. to resolve `nvest analyze GTCO`. */
	async findExchanges(symbol: string): Promise<Exchange[]> {
		const rows = await this.db.all("SELECT exchange FROM securities WHERE symbol = ? ORDER BY exchange", [
			symbol.toUpperCase(),
		]);
		return rows.map((r) => r.exchange as Exchange);
	}

	async searchSecurities(query: string, exchange?: Exchange, limit = 20): Promise<Security[]> {
		const upper = query.toUpperCase();
		const rows = await this.db.all(
			`SELECT * FROM securities
			 WHERE (UPPER(symbol) LIKE ? OR UPPER(name) LIKE ?) AND (CAST(? AS TEXT) IS NULL OR exchange = ?)
			 ORDER BY (UPPER(symbol) = ?) DESC, (UPPER(symbol) LIKE ?) DESC, symbol
			 LIMIT ?`,
			[`%${upper}%`, `%${upper}%`, exchange ?? null, exchange ?? null, upper, `${upper}%`, limit],
		);
		return rows.map(toSecurity);
	}

	async allSymbols(): Promise<{ exchange: Exchange; symbol: string; name: string }[]> {
		const rows = await this.db.all("SELECT exchange, symbol, name FROM securities");
		return rows.map((r) => ({ exchange: r.exchange as Exchange, symbol: String(r.symbol), name: String(r.name) }));
	}

	/** Most recent bar per security (optionally for one exchange), joined with security info. */
	async latestQuotes(exchange?: Exchange): Promise<Quote[]> {
		const rows = await this.db.all(
			`SELECT p.*, s.name, s.sector, s.currency, s.venue, s.market_cap
			 FROM daily_prices p
			 JOIN securities s ON s.exchange = p.exchange AND s.symbol = p.symbol
			 WHERE (CAST(? AS TEXT) IS NULL OR p.exchange = ?)
			   AND p.date = (
				SELECT MAX(date) FROM daily_prices p2
				WHERE p2.exchange = p.exchange AND p2.symbol = p.symbol
			   )
			 ORDER BY p.exchange, p.symbol`,
			[exchange ?? null, exchange ?? null],
		);
		return rows.map(toQuote);
	}

	async latestQuote(exchange: Exchange, symbol: string): Promise<Quote | null> {
		const row = await this.db.get(
			`SELECT p.*, s.name, s.sector, s.currency, s.venue, s.market_cap
			 FROM daily_prices p
			 JOIN securities s ON s.exchange = p.exchange AND s.symbol = p.symbol
			 WHERE p.exchange = ? AND p.symbol = ?
			 ORDER BY p.date DESC LIMIT 1`,
			[exchange, symbol.toUpperCase()],
		);
		return row ? toQuote(row) : null;
	}

	/** Daily bars ordered oldest → newest; `limit` keeps the most recent N. */
	async history(exchange: Exchange, symbol: string, limit = 400): Promise<PriceBar[]> {
		const rows = await this.db.all(
			`SELECT * FROM (
				SELECT * FROM daily_prices WHERE exchange = ? AND symbol = ?
				ORDER BY date DESC LIMIT ?
			 ) AS recent ORDER BY date ASC`,
			[exchange, symbol.toUpperCase(), limit],
		);
		return rows.map(toBar);
	}
}

// -- Batching ------------------------------------------------------------------------------------------------------

/**
 * One multi-row INSERT can't touch the same key twice (Postgres rejects it), so fold duplicates first — in input
 * order, which matches what row-by-row upserts would have produced.
 */
function dedupe<T>(items: T[], key: (item: T) => string, merge: (earlier: T, later: T) => T): T[] {
	const byKey = new Map<string, T>();
	for (const item of items) {
		const k = key(item);
		const earlier = byKey.get(k);
		byKey.set(k, earlier ? merge(earlier, item) : item);
	}
	return [...byKey.values()];
}

/** Later non-null values win, like the COALESCE in the upsert. */
function overlay<T extends object>(earlier: T, later: T): T {
	const out = { ...earlier } as Record<string, unknown>;
	for (const [k, v] of Object.entries(later)) if (v !== null && v !== undefined) out[k] = v;
	return out as T;
}

const mergeBar = (earlier: PriceBar, later: PriceBar): PriceBar => overlay(earlier, later);

function mergeSecurity(earlier: Security, later: Security): Security {
	const merged = overlay(earlier, later);
	// A source that only knows the ticker never replaces a real name.
	return later.name === later.symbol ? { ...merged, name: earlier.name } : merged;
}

// -- Row mappers -----------------------------------------------------------------------------------------------------

function toSecurity(r: Row): Security {
	return {
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		name: String(r.name),
		sector: str(r.sector),
		currency: String(r.currency),
		venue: str(r.venue),
		industry: str(r.industry),
		marketCap: num(r.market_cap),
		sourceId: str(r.source_id),
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
		sector: str(r.sector),
		currency: String(r.currency),
		venue: str(r.venue),
		marketCap: num(r.market_cap),
	};
}
