/**
 * Trading costs per market, so success rates can be shown after fees — on NGX they can eat most of a 2–3% gain.
 *
 * NGX defaults (Bamboo and Hisa broker schedules, 2026; CSCS 2026 tariff), at a 1% brokerage rate:
 *   buy:  brokerage 1% + SEC 0.3% (+7.5% VAT on both) + stamp duty 0.08%            ≈ 1.48%
 *   sell: brokerage 1% + NGX 0.3% + CSCS 0.3% (+7.5% VAT on all three) + stamp 0.08% ≈ 1.80%
 * Brokers charge 0.75–1.35%, so set TRADING_COSTS to your broker's rates. Flat alert fees (₦4) are ignored.
 * US and crypto defaults are rough allowances for commission and spread; naira↔dollar FX costs are not included.
 */
import type { Exchange } from "../markets/types.js";

export interface TradingCosts {
	/** % of the trade value paid when buying. */
	buyPct: number;
	/** % of the trade value paid when selling. */
	sellPct: number;
}

export type CostTable = Record<Exchange, TradingCosts>;

export const DEFAULT_COSTS: CostTable = {
	NGX: { buyPct: 1.48, sellPct: 1.8 },
	US: { buyPct: 0.25, sellPct: 0.25 },
	CRYPTO: { buyPct: 0.5, sellPct: 0.5 },
};

export const NO_COSTS: TradingCosts = { buyPct: 0, sellPct: 0 };

/** Cost of a round trip as a % of the money put in (what a trade must gain just to break even). */
export function roundTripPct(c: TradingCosts): number {
	return ((1 + c.buyPct / 100) / (1 - c.sellPct / 100) - 1) * 100;
}

/**
 * A gross move (%) after paying to get in and out. A SELL signal is scored the same way: a holder who sells and buys
 * back after the fall pays the same round trip.
 */
export function netReturnPct(grossPct: number, c: TradingCosts): number {
	return (((1 + grossPct / 100) * (1 - c.sellPct / 100)) / (1 + c.buyPct / 100) - 1) * 100;
}

/** Parse `TRADING_COSTS`, e.g. "NGX=1.48/1.8,US=0.1/0.1" (buy/sell %). Unlisted markets keep their defaults. */
export function parseCosts(value: string | undefined): CostTable {
	const table: CostTable = { ...DEFAULT_COSTS };
	if (!value?.trim()) return table;
	for (const part of value.split(",")) {
		const m = /^\s*(NGX|US|CRYPTO)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/i.exec(part);
		if (!m) throw new Error(`TRADING_COSTS: can't read "${part.trim()}" (expected e.g. NGX=1.48/1.8)`);
		const [buyPct, sellPct] = [Number(m[2]), Number(m[3])];
		if (!(buyPct < 20 && sellPct < 20)) throw new Error(`TRADING_COSTS: "${part.trim()}" looks too high`);
		table[(m[1] as string).toUpperCase() as Exchange] = { buyPct, sellPct };
	}
	return table;
}

let active: CostTable = DEFAULT_COSTS;

/** Set the costs every success rate is measured with (from config, at startup). */
export function configureCosts(table: CostTable) {
	active = table;
}

export function costsFor(exchange: Exchange): TradingCosts {
	return active[exchange];
}
