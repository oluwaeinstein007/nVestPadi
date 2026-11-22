export const EXCHANGES = ["NGX", "US"] as const;
export type Exchange = (typeof EXCHANGES)[number];

export function parseExchange(value: string | undefined): Exchange | undefined {
	if (!value) return undefined;
	const upper = value.toUpperCase();
	if ((EXCHANGES as readonly string[]).includes(upper)) return upper as Exchange;
	throw new Error(`Unknown exchange "${value}" (expected ${EXCHANGES.join(" or ")})`);
}

export const CURRENCY: Record<Exchange, string> = { NGX: "NGN", US: "USD" };

export interface Security {
	exchange: Exchange;
	symbol: string;
	name: string;
	sector: string | null;
	currency: string;
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
}

export interface MarketSnapshot {
	securities: Security[];
	bars: PriceBar[];
}
