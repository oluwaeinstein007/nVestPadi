export const EXCHANGES = ["NGX", "US", "CRYPTO"] as const;
export type Exchange = (typeof EXCHANGES)[number];

export function parseExchange(value: string | undefined): Exchange | undefined {
	if (!value) return undefined;
	const upper = value.toUpperCase();
	if ((EXCHANGES as readonly string[]).includes(upper)) return upper as Exchange;
	throw new Error(`Unknown market "${value}" (expected ${EXCHANGES.join(", ")})`);
}

export const CURRENCY: Record<Exchange, string> = { NGX: "NGN", US: "USD", CRYPTO: "USD" };

/** Human names for each market, used in the UI, bots and digests. */
export const MARKET_NAMES: Record<Exchange, string> = {
	NGX: "Nigerian Exchange",
	US: "US stocks",
	CRYPTO: "Crypto",
};

/** Markets that trade on weekdays only (crypto trades every day). */
export const WEEKDAY_MARKETS: ReadonlySet<Exchange> = new Set(["NGX", "US"]);

export interface Security {
	exchange: Exchange;
	symbol: string;
	name: string;
	sector: string | null;
	currency: string;
	/** Listing venue, e.g. "NYSE", "Nasdaq", "NGX". */
	venue?: string | null;
	industry?: string | null;
	marketCap?: number | null;
	/** Source-specific identifier, e.g. the CoinGecko coin id. */
	sourceId?: string | null;
}

/** One trading day for one security. Fields a source doesn't provide are null. */
export interface PriceBar {
	exchange: Exchange;
	symbol: string;
	date: string; // YYYY-MM-DD
	open: number | null;
	high: number | null;
	low: number | null;
	close: number;
	volume: number | null;
	change: number | null;
	changePct: number | null;
	trades: number | null;
	value: number | null;
}

/** Latest bar joined with security details. */
export interface Quote extends PriceBar {
	name: string;
	sector: string | null;
	currency: string;
	venue: string | null;
	marketCap: number | null;
}

export interface MarketSnapshot {
	securities: Security[];
	bars: PriceBar[];
}

/** Fill change/changePct from the previous close where a source only gives closes. */
export function withChanges(bars: PriceBar[]): PriceBar[] {
	return bars.map((b, i) => {
		const prev = bars[i - 1]?.close;
		if (prev === undefined || (b.change !== null && b.changePct !== null)) return b;
		const change = b.close - prev;
		return {
			...b,
			change: b.change ?? Math.round(change * 10_000) / 10_000,
			changePct: b.changePct ?? (prev ? Math.round((change / prev) * 10_000) / 100 : null),
		};
	});
}
