/**
 * "What should I look at buying or selling?" — every security in the latest
 * session with an actionable signal, its trade plan and its own track record,
 * ranked so the best-evidenced ideas come first; plus how the same rules have
 * done across the whole market, next to a random entry.
 *
 * Scanning a market replays a few hundred histories, so results are cached
 * until the session's prices change (i.e. until the next sync).
 */
import { isoDate, round } from "../lib/util.js";
import type { Exchange, Quote } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import { MIN_TRADES, type Side, type SignalCall, type TrackRecord, analyzeSignals } from "./signals.js";

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
	/** Win rate minus the base rate, in points (null when there's no track record). */
	edge: number | null;
	/**
	 * backed: enough past signals and better than a random entry.
	 * thin: too few past signals to judge. weak: enough, but no better than random.
	 */
	evidence: "backed" | "thin" | "weak";
}

/** The signal rules' record across every security in a market. */
export interface MarketTrack {
	side: Side;
	symbols: number;
	trades: number;
	wins: number;
	winRate: number | null;
	avgReturnPct: number | null;
	/** Share of random entries (any session) that moved the signal's way. */
	baseRate: number | null;
	baseAvgPct: number | null;
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
	const key = `${date}|${current.map((q) => `${q.symbol}:${q.close}`).join(",")}`;
	const hit = cache.get(exchange);
	if (hit?.key === key) return hit;

	const ideas: SignalIdea[] = [];
	const tracks: Record<Side, TrackRecord[]> = { BUY: [], SELL: [] };
	for (const q of current) {
		const bars = await db.market.history(q.exchange, q.symbol, 730);
		if (bars.length < MIN_BARS) continue;
		const a = analyzeSignals(bars);
		tracks.BUY.push(a.track.BUY);
		tracks.SELL.push(a.track.SELL);
		if (a.call) ideas.push(toIdea(q, a.call));
	}
	const result = {
		key,
		ideas: ideas.sort(rank),
		summary: { BUY: combine("BUY", tracks.BUY), SELL: combine("SELL", tracks.SELL) },
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

function toIdea(q: Quote, call: SignalCall): SignalIdea {
	const t = call.track;
	const edge = t.winRate !== null && t.baseRate !== null ? round(t.winRate - t.baseRate, 1) : null;
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
	};
}

/** Trade-weighted results; base rates averaged per security. */
function combine(side: Side, tracks: TrackRecord[]): MarketTrack {
	const trades = tracks.reduce((s, t) => s + t.trades, 0);
	const wins = tracks.reduce((s, t) => s + t.wins, 0);
	const returns = tracks.reduce((s, t) => s + (t.avgReturnPct ?? 0) * t.trades, 0);
	const base = tracks.filter((t) => t.baseRate !== null);
	const mean = (values: number[]) =>
		values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 1) : null;
	return {
		side,
		symbols: tracks.length,
		trades,
		wins,
		winRate: trades ? round((wins / trades) * 100, 1) : null,
		avgReturnPct: trades ? round(returns / trades, 2) : null,
		baseRate: mean(base.map((t) => t.baseRate as number)),
		baseAvgPct: mean(base.map((t) => t.baseAvgPct ?? 0)),
	};
}

/** Evidence first (enough past trades and better than chance), then strength, then win rate. */
function rank(a: SignalIdea, b: SignalIdea): number {
	const tier = (i: SignalIdea) => (i.evidence === "backed" ? 2 : 0) + (i.call.strength === "strong" ? 1 : 0);
	return (
		tier(b) - tier(a) ||
		(b.call.track.winRate ?? -1) - (a.call.track.winRate ?? -1) ||
		b.call.track.trades - a.call.track.trades
	);
}
