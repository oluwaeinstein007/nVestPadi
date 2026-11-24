import { netReturnPct } from "../analysis/costs.js";
/**
 * The live track record: every signal the app shows is logged the first time it's seen, then scored as it plays
 * out, with the same exits as the backtest (`findExit`) and the same trading costs. Unlike the backtest, nothing here
 * can be fitted after the fact:
 *
 * - the stop, target and estimated chance of profit are stored as they were shown;
 * - the trade enters at the open of the session *after* the one it was seen in, so a signal noticed late (or
 *   mid-session, before the close confirmed it) is scored from when users could actually have acted on it;
 * - signals that later disappear (an intraday breakout that faded by the close) stay in the record;
 * - closed rows are never changed again.
 *
 * Scoring also checks the confidence estimates: a well-calibrated "60%" should come true about 60% of the time.
 */
import { signalIdeas, verdict } from "../analysis/ideas.js";
import { SIGNAL_RULE, type Side, breakoutStrategy, findExit, movePct } from "../analysis/signals.js";
import { isoDate, round } from "../lib/util.js";
import { isMarketOpen } from "../markets/hours.js";
import type { Exchange, PriceBar } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { LoggedSignal, SignalProgress } from "../storage/repositories/signalLog.js";

export interface LedgerUpdate {
	exchange: Exchange;
	logged: number;
	closed: number;
}

export interface LiveRecord {
	side: Side;
	/** Logged signals, including ones not yet entered or closed. */
	signals: number;
	open: number;
	/** Closed (scored) signals. */
	trades: number;
	/** Profitable after costs. */
	wins: number;
	winRate: number | null;
	avgNetReturnPct: number | null;
	grossWinRate: number | null;
	avgReturnPct: number | null;
	/** Average chance of profit a random entry had when these signals were logged (after costs). */
	baseRate: number | null;
	verdict: "better" | "worse" | "unclear";
}

export interface CalibrationBucket {
	label: string;
	/** Closed signals whose estimate fell in this range. */
	trades: number;
	/** Average estimated chance (%) at the time. */
	predicted: number | null;
	/** Share that actually made money after costs (%). */
	actual: number | null;
}

export interface TrackRecordReport {
	rule: string;
	since: string | null;
	exchanges: { exchange: Exchange; BUY: LiveRecord; SELL: LiveRecord }[];
	calibration: {
		buckets: CalibrationBucket[];
		/** Mean squared error of the estimates (0 = perfect, 0.25 = always saying 50%). */
		brier: number | null;
		/** Same score for always predicting the random-entry rate; the estimates should beat it. */
		baselineBrier: number | null;
	};
	recent: LoggedSignal[];
}

const BUCKETS: [number, number, string][] = [
	[0, 45, "under 45%"],
	[45, 55, "45–55%"],
	[55, 65, "55–65%"],
	[65, 101, "65% and up"],
];

export class SignalLedger {
	constructor(private readonly db: Database) {}

	/** After a sync: score what can be scored, then log any signal not seen before. */
	async update(exchange: Exchange, now = new Date()): Promise<LedgerUpdate> {
		const closed = await this.resolve(exchange, now);
		const logged = await this.record(exchange);
		return { exchange, logged, closed };
	}

	/** Log every current call that isn't in the ledger yet. Returns how many were new. */
	async record(exchange: Exchange): Promise<number> {
		const ideas = await signalIdeas(this.db, exchange, { limit: 1000 });
		let added = 0;
		for (const i of ideas) {
			const plan = i.call.plan;
			if (!plan) continue;
			const t = i.call.track;
			const isNew = await this.db.signals.insert({
				exchange,
				symbol: i.symbol,
				side: i.call.side,
				rule: SIGNAL_RULE,
				strength: i.call.strength,
				reason: i.call.reason,
				evidence: i.evidence,
				signalDate: i.call.date,
				seenDate: i.date,
				refPrice: plan.entry,
				stop: plan.stop,
				target: plan.target,
				horizon: plan.horizon,
				costPct: t.costPct,
				probability: i.confidence.probability,
				probLow: i.confidence.low,
				probHigh: i.confidence.high,
				confidence: i.confidence.level,
				baseRate: i.confidence.baseRate,
				pastTrades: t.trades,
				pastWinRate: t.winRate,
			});
			if (isNew) added++;
		}
		return added;
	}

	/**
	 * Bring every unscored signal up to date with the latest prices. Returns how many closed. While the market is open,
	 * today's bar is still forming, so only finished sessions are scored (a closed row can't be corrected later).
	 */
	async resolve(exchange: Exchange, now = new Date()): Promise<number> {
		let closed = 0;
		const today = isoDate(now);
		const open = isMarketOpen(exchange, now);
		for (const s of await this.db.signals.unresolved(exchange)) {
			const history = await this.db.market.history(exchange, s.symbol, 730);
			const bars = open && history.at(-1)?.date === today ? history.slice(0, -1) : history;
			const p = score(s, bars);
			if (!p) continue;
			await this.db.signals.progress(s.id, p);
			if (p.status === "closed") closed++;
		}
		return closed;
	}

	async report(options: { exchange?: Exchange; recent?: number } = {}): Promise<TrackRecordReport> {
		const all = await this.db.signals.list({ rule: SIGNAL_RULE, exchange: options.exchange });
		const exchanges = [...new Set(all.map((s) => s.exchange))].sort();
		const closed = all.filter((s) => s.status === "closed" && s.netReturnPct !== null);
		return {
			rule: SIGNAL_RULE,
			since: all.reduce<string | null>((min, s) => (min === null || s.loggedAt < min ? s.loggedAt : min), null),
			exchanges: exchanges.map((exchange) => {
				const mine = all.filter((s) => s.exchange === exchange);
				return { exchange, BUY: live("BUY", mine), SELL: live("SELL", mine) };
			}),
			calibration: calibrate(closed),
			recent: all.slice(0, options.recent ?? 50),
		};
	}
}

/**
 * Where a logged signal stands given the history now stored: still waiting for its entry session, open (marked to
 * the latest close) or closed. Null when nothing has changed that can be stored.
 */
export function score(s: LoggedSignal, bars: PriceBar[]): SignalProgress | null {
	const entryIdx = bars.findIndex((b) => b.date > s.seenDate);
	if (entryIdx < 0) return null;
	const entryBar = bars[entryIdx] as PriceBar;
	const entryPrice = entryBar.open ?? entryBar.close;
	if (!(entryPrice > 0)) return null;

	// The same rule's opposite signals close the trade, exactly as in the backtest.
	const opposite = new Set(
		breakoutStrategy(bars)
			.filter((g) => g.strength !== "weak" && g.signal !== "HOLD" && g.signal !== s.side)
			.map((g) => g.index),
	);
	const exit = findExit(s.side, bars, entryIdx, s, s.horizon, (j) => opposite.has(j));
	const at = exit ? exit.idx : bars.length - 1;
	const price = exit ? exit.price : (bars[at] as PriceBar).close;
	const gross = movePct(s.side, entryPrice, price);
	// Costs as a round trip, the way they were stated when the signal was logged.
	const net = netReturnPct(gross, { buyPct: s.costPct, sellPct: 0 });
	return {
		status: exit ? "closed" : "open",
		entryDate: entryBar.date,
		entryPrice: round(entryPrice, 6),
		exitDate: exit ? (bars[at] as PriceBar).date : null,
		exitPrice: exit ? round(price, 6) : null,
		exitReason: exit?.reason ?? null,
		lastDate: (bars[at] as PriceBar).date,
		lastPrice: round(price, 6),
		returnPct: round(gross, 2),
		netReturnPct: round(net, 2),
		sessions: at - entryIdx + 1,
	};
}

function live(side: Side, all: LoggedSignal[]): LiveRecord {
	const mine = all.filter((s) => s.side === side);
	const closed = mine.filter((s) => s.status === "closed" && s.netReturnPct !== null);
	const wins = closed.filter((s) => (s.netReturnPct as number) > 0).length;
	const grossWins = closed.filter((s) => (s.returnPct ?? 0) > 0).length;
	const mean = (values: number[], digits: number) =>
		values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, digits) : null;
	const bases = closed.filter((s) => s.baseRate !== null).map((s) => s.baseRate as number);
	const baseRate = mean(bases, 1);
	return {
		side,
		signals: mine.length,
		open: mine.filter((s) => s.status === "open").length,
		trades: closed.length,
		wins,
		winRate: closed.length ? round((wins / closed.length) * 100, 1) : null,
		avgNetReturnPct: mean(
			closed.map((s) => s.netReturnPct as number),
			2,
		),
		grossWinRate: closed.length ? round((grossWins / closed.length) * 100, 1) : null,
		avgReturnPct: mean(
			closed.map((s) => s.returnPct ?? 0),
			2,
		),
		baseRate,
		verdict: verdict(wins, closed.length, baseRate),
	};
}

function calibrate(closed: LoggedSignal[]): TrackRecordReport["calibration"] {
	const rated = closed.filter((s) => s.probability !== null);
	const won = (s: LoggedSignal) => ((s.netReturnPct as number) > 0 ? 1 : 0);
	const buckets = BUCKETS.map(([lo, hi, label]) => {
		const inside = rated.filter((s) => (s.probability as number) >= lo && (s.probability as number) < hi);
		const n = inside.length;
		return {
			label,
			trades: n,
			predicted: n ? round(inside.reduce((a, s) => a + (s.probability as number), 0) / n, 1) : null,
			actual: n ? round((inside.reduce((a, s) => a + won(s), 0) / n) * 100, 1) : null,
		};
	});
	const brier = (pick: (s: LoggedSignal) => number | null) => {
		const scored = rated.filter((s) => pick(s) !== null);
		if (!scored.length) return null;
		const sum = scored.reduce((a, s) => a + ((pick(s) as number) / 100 - won(s)) ** 2, 0);
		return round(sum / scored.length, 3);
	};
	return {
		buckets,
		brier: brier((s) => s.probability),
		baselineBrier: brier((s) => s.baseRate),
	};
}
