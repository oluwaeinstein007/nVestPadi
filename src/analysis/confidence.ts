/**
 * How likely a fresh signal is to end in profit after trading costs, and how sure we are of that.
 *
 * One stock rarely has more than a handful of past signals, so its own record alone swings wildly (1 of 1 = "100%").
 * The estimate starts from the rule's record across the whole market and lets the stock's own record pull it away
 * from there as evidence builds up (a beta-binomial estimate, with the market record worth `PRIOR_WEIGHT` trades).
 *
 * The market starting point learns from live results: every signal the app logs and later scores (see
 * `services/signalLedger.ts`) feeds back in, and the more live outcomes there are, the more they outweigh the
 * backtest. Nothing else adapts automatically: the signal rules themselves only change after a fresh out-of-sample
 * test, because re-tuning rules on a few dozen live trades would just fit noise.
 */
import { round } from "../lib/util.js";

export interface WinCount {
	wins: number;
	trades: number;
}

export interface Confidence {
	/** Estimated chance (%) that this signal ends in profit after costs. */
	probability: number;
	/** 90% range for that chance. */
	low: number;
	high: number;
	/** Chance (%) that a random entry made money after costs — the bar a signal has to clear. */
	baseRate: number | null;
	/**
	 * high: the whole range is above a random entry. medium: the estimate is above it but the range overlaps.
	 * low: no better than a random entry, as far as the evidence goes.
	 */
	level: "high" | "medium" | "low";
	/** Closed past signals behind the estimate. */
	basis: { own: number; market: number; live: number };
}

/** How many trades the market-wide record is worth when judging one security. */
export const PRIOR_WEIGHT = 10;
/** Live outcomes at which live results and the backtest weigh equally in the market starting point. */
export const LIVE_HALF_WEIGHT = 50;
/** z for a two-sided 90% range. */
const Z90 = 1.645;

export function estimateConfidence(
	own: WinCount,
	market: WinCount,
	live: WinCount,
	baseRatePct: number | null,
): Confidence {
	const base = baseRatePct === null ? null : baseRatePct / 100;
	const backtest = market.trades ? market.wins / market.trades : (base ?? 0.5);
	const w = live.trades / (live.trades + LIVE_HALF_WEIGHT);
	const prior = live.trades ? (1 - w) * backtest + w * (live.wins / live.trades) : backtest;
	// With no market-wide evidence at all, the prior is just the random-entry rate and barely counts.
	const k = market.trades + live.trades > 0 ? PRIOR_WEIGHT : 2;

	const n = own.trades + k;
	const p = (own.wins + k * prior) / n;
	const sd = Math.sqrt((p * (1 - p)) / (n + 1));
	const low = Math.max(0, p - Z90 * sd);
	const high = Math.min(1, p + Z90 * sd);

	const bar = base ?? 0.5;
	const level = low > bar ? "high" : p > bar + 0.02 ? "medium" : "low";
	return {
		probability: round(p * 100, 0),
		low: round(low * 100, 0),
		high: round(high * 100, 0),
		baseRate: baseRatePct === null ? null : round(baseRatePct, 0),
		level,
		basis: { own: own.trades, market: market.trades, live: live.trades },
	};
}

/** "58% chance of profit after costs (range 44–71%, medium confidence)". */
export function describeConfidence(c: Confidence): string {
	return `${c.probability}% chance of profit after costs (range ${c.low}–${c.high}%, ${c.level} confidence)`;
}
