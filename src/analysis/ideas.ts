/**
 * "What should I look at buying or selling?" — every security in the latest
 * session with an actionable signal, its trade plan and its own track record,
 * ranked so the best-evidenced ideas come first; plus how the same rules have
 * done across the whole market, next to a random entry.
 *
 * Scanning a market replays a few hundred histories, so results are cached
 * until the session's prices change (i.e. until the next sync) or a logged
 * signal is scored (which moves the confidence estimates).
 */
import { isoDate, round } from "../lib/util.js";
import type { Exchange, Quote } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import { type Confidence, type WinCount, estimateConfidence } from "./confidence.js";
import { MIN_TRADES, SIGNAL_RULE, type Side, type SignalCall, type TrackRecord, analyzeSignals } from "./signals.js";

export interface SignalIdea {
	exchange: Exchange;
	symbol: string;
	name: string;
	sector: string | null;
	currency: string;
	close: number;
	changePct: number | null;
	date: string;
	call: SignalCall;
	/** Win rate minus the base rate (the market's when the history is short), in points; null without a record. */
	edge: number | null;
	/**
	 * backed: enough past signals and better than a random entry.
	 * thin: too few past signals to judge. weak: enough, but no better than random.
	 */
	evidence: "backed" | "thin" | "weak";
	/** Estimated chance of profit after costs, from this security's record, the market's and live results. */
	confidence: Confidence;
}

/** The signal rules' record across every security in a market. */
export interface MarketTrack {
	side: Side;
	symbols: number;
	trades: number;
	wins: number;
	/** Profitable after costs. */
	winRate: number | null;
	avgReturnPct: number | null;
	grossWinRate: number | null;
	grossAvgReturnPct: number | null;
	costPct: number | null;
	/** Share of random entries (any session) that moved the signal's way by more than costs. */
	baseRate: number | null;
	baseAvgPct: number | null;
	/**
	 * Whether the win rate differs from the random-entry rate by more than chance
	 * would explain (one-sided binomial z-test at 95%): "better", "worse" or "unclear".
	 */
	verdict: "better" | "worse" | "unclear";
}

/** Histories shorter than this give too few past signals to say anything. */
const MIN_BARS = 60;
type Scan = { key: string; ideas: SignalIdea[]; summary: { BUY: MarketTrack; SELL: MarketTrack } };
/** Per database, so separate apps (and tests) never share results. */
const caches = new WeakMap<Database, Map<Exchange, Scan>>();

async function scan(db: Database, exchange: Exchange): Promise<Scan> {
	const cache = caches.get(db) ?? new Map<Exchange, Scan>();
	caches.set(db, cache);
	const quotes = await db.market.latestQuotes(exchange);
	const date = quotes.reduce<string | null>((max, q) => (max === null || q.date > max ? q.date : max), null);
	// Mid-session the NGX board lists only stocks that have traded so far today, so take
	// everything quoted in the last week; a stock that hasn't traded can't have a fresh signal.
	const since = date ? isoDate(new Date(new Date(`${date}T00:00:00Z`).getTime() - 7 * 86_400_000)) : "";
	const current = quotes.filter((q) => q.date >= since);
	const live = await db.signals.outcomes(exchange, SIGNAL_RULE);
	const key = `${date}|${JSON.stringify(live)}|${current.map((q) => `${q.symbol}:${q.close}`).join(",")}`;
	const hit = cache.get(exchange);
	if (hit?.key === key) return hit;

	const calls: { q: Quote; call: SignalCall }[] = [];
	const tracks: Record<Side, TrackRecord[]> = { BUY: [], SELL: [] };
	for (const q of current) {
		const bars = await db.market.history(q.exchange, q.symbol, 730);
		if (bars.length < MIN_BARS) continue;
		const a = analyzeSignals(bars);
		tracks.BUY.push(a.track.BUY);
		tracks.SELL.push(a.track.SELL);
		if (a.call) calls.push({ q, call: a.call });
	}
	const summary = { BUY: combine("BUY", tracks.BUY), SELL: combine("SELL", tracks.SELL) };
	const result = {
		key,
		ideas: calls.map(({ q, call }) => toIdea(q, call, summary[call.side], live[call.side])).sort(rank),
		summary,
	};
	cache.set(exchange, result);
	return result;
}

export async function signalIdeas(
	db: Database,
	exchange: Exchange,
	options: { side?: Side; limit?: number; minWinRate?: number } = {},
): Promise<SignalIdea[]> {
	return (await scan(db, exchange)).ideas
		.filter((i) => !options.side || i.call.side === options.side)
		.filter((i) => options.minWinRate === undefined || (i.call.track.winRate ?? 0) >= options.minWinRate)
		.slice(0, options.limit ?? 50);
}

export async function signalSummary(
	db: Database,
	exchange: Exchange,
): Promise<{ BUY: MarketTrack; SELL: MarketTrack }> {
	return (await scan(db, exchange)).summary;
}

function toIdea(q: Quote, call: SignalCall, market: MarketTrack, live: WinCount): SignalIdea {
	const t = call.track;
	// A short history has no baseline of its own; judge it against the market's.
	const base = t.baseRate ?? market.baseRate;
	const edge = t.winRate !== null && base !== null ? round(t.winRate - base, 1) : null;
	const confidence = confidenceFor(t, market, live);
	return {
		exchange: q.exchange,
		symbol: q.symbol,
		name: q.name,
		sector: q.sector,
		currency: q.currency,
		close: q.close,
		changePct: q.changePct,
		date: q.date,
		call,
		edge,
		evidence: t.trades < MIN_TRADES ? "thin" : (edge ?? 0) > 0 ? "backed" : "weak",
		confidence,
	};
}

/** Confidence for one security's call, given its market's record and the live outcomes so far. */
export function confidenceFor(own: TrackRecord, market: MarketTrack, live: WinCount): Confidence {
	return estimateConfidence(
		{ wins: own.wins, trades: own.trades },
		{ wins: market.wins, trades: market.trades },
		live,
		own.baseRate ?? market.baseRate,
	);
}

/** The confidence for a security's current call (for the security page). */
export async function callConfidence(db: Database, exchange: Exchange, call: SignalCall): Promise<Confidence> {
	const [summary, live] = await Promise.all([signalSummary(db, exchange), db.signals.outcomes(exchange, SIGNAL_RULE)]);
	return confidenceFor(call.track, summary[call.side], live[call.side]);
}

/** Trade-weighted results; base rates averaged per security. */
function combine(side: Side, tracks: TrackRecord[]): MarketTrack {
	const trades = tracks.reduce((s, t) => s + t.trades, 0);
	const wins = tracks.reduce((s, t) => s + t.wins, 0);
	const returns = tracks.reduce((s, t) => s + (t.avgReturnPct ?? 0) * t.trades, 0);
	const grossWins = tracks.reduce((s, t) => s + t.grossWins, 0);
	const grossReturns = tracks.reduce((s, t) => s + (t.grossAvgReturnPct ?? 0) * t.trades, 0);
	const base = tracks.filter((t) => t.baseRate !== null);
	const mean = (values: number[]) =>
		values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 1) : null;
	const baseRate = mean(base.map((t) => t.baseRate as number));
	return {
		side,
		symbols: tracks.length,
		trades,
		wins,
		winRate: trades ? round((wins / trades) * 100, 1) : null,
		avgReturnPct: trades ? round(returns / trades, 2) : null,
		grossWinRate: trades ? round((grossWins / trades) * 100, 1) : null,
		grossAvgReturnPct: trades ? round(grossReturns / trades, 2) : null,
		costPct: tracks[0]?.costPct ?? null,
		baseRate,
		baseAvgPct: mean(base.map((t) => t.baseAvgPct ?? 0)),
		verdict: verdict(wins, trades, baseRate),
	};
}

/** One-sided z-test of `wins / trades` against the random-entry rate (in %). */
export function verdict(wins: number, trades: number, baseRatePct: number | null): MarketTrack["verdict"] {
	if (!trades || baseRatePct === null) return "unclear";
	const p0 = Math.min(0.99, Math.max(0.01, baseRatePct / 100));
	const z = (wins / trades - p0) / Math.sqrt((p0 * (1 - p0)) / trades);
	return z >= 1.645 ? "better" : z <= -1.645 ? "worse" : "unclear";
}

/** Evidence first (enough past trades and better than chance), then strength, then estimated chance of profit. */
function rank(a: SignalIdea, b: SignalIdea): number {
	const tier = (i: SignalIdea) => (i.evidence === "backed" ? 2 : 0) + (i.call.strength === "strong" ? 1 : 0);
	return (
		tier(b) - tier(a) ||
		b.confidence.probability - a.confidence.probability ||
		(b.call.track.winRate ?? -1) - (a.call.track.winRate ?? -1) ||
		b.call.track.trades - a.call.track.trades
	);
}
