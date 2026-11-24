import type { SQLInputValue } from "node:sqlite";
import type { Exchange, PriceBar, Quote, Security } from "../../markets/types.js";
import type { Database } from "../database.js";

type Row = Record<string, SQLInputValue>;

/** Securities and daily prices — shared, read-mostly market data. */
export class MarketRepository {
	constructor(private readonly db: Database) {}

	upsertSecurities(securities: Security[]) {
		// Sparse sources (e.g. a history fetch without sector) never wipe richer metadata.
		const stmt = this.db.prepare(`
			INSERT INTO securities (exchange, symbol, name, sector, currency, venue, industry, market_cap, source_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (exchange, symbol) DO UPDATE SET
				-- A source that only knows the ticker (e.g. a failed name lookup) never replaces a real name.
				name = CASE WHEN excluded.name = excluded.symbol THEN securities.name ELSE excluded.name END,
				sector = COALESCE(excluded.sector, securities.sector),
				currency = excluded.currency,
				venue = COALESCE(excluded.venue, securities.venue),
				industry = COALESCE(excluded.industry, securities.industry),
				market_cap = COALESCE(excluded.market_cap, securities.market_cap),
				source_id = COALESCE(excluded.source_id, securities.source_id),
				updated_at = datetime('now')
		`);
		this.db.transaction(() => {
			for (const s of securities) {
				stmt.run(
					s.exchange,
					s.symbol,
					s.name,
					s.sector,
					s.currency,
					s.venue ?? null,
					s.industry ?? null,
					s.marketCap ?? null,
					s.sourceId ?? null,
				);
			}
		});
	}

	/** Update listing metadata (sector, venue, …) without touching names or prices. */
	enrichSecurities(
		exchange: Exchange,
		meta: Map<
			string,
			{ sector?: string | null; industry?: string | null; venue?: string | null; marketCap?: number | null }
		>,
	): number {
		const stmt = this.db.prepare(`
			UPDATE securities SET
				sector = COALESCE(?, sector),
				industry = COALESCE(?, industry),
				venue = COALESCE(?, venue),
				market_cap = COALESCE(?, market_cap)
			WHERE exchange = ? AND symbol = ?
		`);
		let updated = 0;
		this.db.transaction(() => {
			for (const [symbol, m] of meta) {
				updated += Number(
					stmt.run(m.sector ?? null, m.industry ?? null, m.venue ?? null, m.marketCap ?? null, exchange, symbol)
						.changes,
				);
			}
		});
		return updated;
	}

	/** Symbols on an exchange with fewer than `minBars` stored sessions — candidates for backfill. */
	thinHistory(exchange: Exchange, minBars: number): string[] {
		return (
			this.db
				.prepare(
					`SELECT s.symbol FROM securities s
					 LEFT JOIN daily_prices p ON p.exchange = s.exchange AND p.symbol = s.symbol
					 WHERE s.exchange = ? GROUP BY s.symbol HAVING COUNT(p.date) < ? ORDER BY s.symbol`,
				)
				.all(exchange, minBars) as { symbol: string }[]
		).map((r) => r.symbol);
	}

	/** Symbols whose stored history is mostly close-only (no intraday range). */
	closeOnlyHistory(exchange: Exchange, minBars: number): string[] {
		return (
			this.db
				.prepare(
					`SELECT symbol FROM daily_prices WHERE exchange = ?
					 GROUP BY symbol HAVING COUNT(*) >= ? AND SUM(high IS NOT NULL) * 2 < COUNT(*) ORDER BY symbol`,
				)
				.all(exchange, minBars) as { symbol: string }[]
		).map((r) => r.symbol);
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
		this.db.transaction(() => {
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
				SELECT p.*, s.name, s.sector, s.currency, s.venue, s.market_cap
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
				SELECT p.*, s.name, s.sector, s.currency, s.venue, s.market_cap
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
}

// Row mappers

const num = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : Number(v));

function toSecurity(r: Row): Security {
	return {
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		name: String(r.name),
		sector: (r.sector as string | null) ?? null,
		currency: String(r.currency),
		venue: (r.venue as string | null) ?? null,
		industry: (r.industry as string | null) ?? null,
		marketCap: num(r.market_cap),
		sourceId: (r.source_id as string | null) ?? null,
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
		venue: (r.venue as string | null) ?? null,
		marketCap: num(r.market_cap),
	};
}
