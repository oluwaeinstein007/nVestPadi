import type { SQLInputValue } from "node:sqlite";
import type { Exchange, PriceBar, Quote, Security } from "../../markets/types.js";
import type { Database } from "../database.js";

type Row = Record<string, SQLInputValue>;

/** Securities and daily prices — shared, read-mostly market data. */
export class MarketRepository {
	constructor(private readonly db: Database) {}

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
		this.db.transaction(() => {
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
