/**
 * From indicator signals to something an investor can act on:
 *
 * - the **current call**: a moderate or strong BUY/SELL from the last few
 *   sessions that hasn't been contradicted since
 * - a **trade plan** for it: entry, stop and target sized from the stock's
 *   own volatility (ATR), and how long the idea is expected to take
 * - a **track record**: every past signal of the same kind on this security,
 *   replayed with the same rules, so the "success rate" is measured, not claimed
 *
 * Backtest rules (kept simple and stated in the UI):
 * - one position at a time per side; signals while in a position are ignored
 * - enter at the next session's open (its close if the source has no open)
 * - exit at the stop, the target, an opposite moderate+ signal (next open),
 *   or after `horizon` sessions at the close, whichever comes first
 * - if a session touches both stop and target, the stop is assumed to hit first
 * - sessions without an intraday range (close-only history) are checked on the close
 * - returns are before brokerage fees and taxes
 * A SELL is scored the same way, mirrored: it succeeds when the price falls.
 *
 * Which signal rules: `breakoutStrategy` (a new 50-session closing high above
 * the 200-day average). It was chosen by replaying four rule sets on ~10 years
 * of NGX, US and crypto history, picking on data before Nov 2023 and checking
 * on the three years after. Only NGX breakout BUYs beat a random entry in both
 * periods (~58–61% vs ~47–49% reaching a profit). The older indicator vote
 * (`compositeStrategy`) did no better than chance anywhere; US, crypto and
 * SELL signals showed no reliable edge with any rule set. That's why every
 * call carries its own measured record and the random baseline next to it.
 */
import { round } from "../lib/util.js";
import type { PriceBar } from "../markets/types.js";
import { type TradingSignal, atr, bollingerBands, generateSignals, macd, rsi, sma } from "./technicalAnalysis.js";

export type Side = "BUY" | "SELL";

export interface TradePlan {
	side: Side;
	entry: number;
	/** BUY: exit if the price falls here. SELL: the idea is wrong if the price rises here. */
	stop: number;
	/** BUY: take-profit level. SELL: where the expected decline would be completed. */
	target: number;
	riskPct: number;
	rewardPct: number;
	/** Sessions the idea is given before it's considered stale. */
	horizon: number;
}

export interface BacktestTrade {
	side: Side;
	signalDate: string;
	entryDate: string;
	entryPrice: number;
	exitDate: string | null;
	exitPrice: number;
	exitReason: "target" | "stop" | "signal" | "time" | "open";
	/** Positive = the signal was right (for a SELL, the price fell). */
	returnPct: number;
	sessions: number;
}

export interface TrackRecord {
	side: Side;
	/** Closed trades only; an open trade isn't scored yet. */
	trades: number;
	wins: number;
	/** % of closed trades that made money (null with no trades). */
	winRate: number | null;
	avgReturnPct: number | null;
	avgWinPct: number | null;
	avgLossPct: number | null;
	avgSessions: number | null;
	/** % of all `horizon`-session windows that moved the signal's way — the "coin flip" to beat. */
	baseRate: number | null;
	/** Average move of those windows, signed the signal's way (what a random entry earned). */
	baseAvgPct: number | null;
	from: string | null;
	to: string | null;
}

export interface SignalCall {
	side: Side;
	strength: "strong" | "moderate";
	date: string;
	reason: string;
	plan: TradePlan | null;
	track: TrackRecord;
}

export interface SignalAnalysis {
	call: SignalCall | null;
	track: { BUY: TrackRecord; SELL: TrackRecord };
	/** Most recent trades of both sides (newest last), for chart markers and the UI. */
	trades: BacktestTrade[];
	rules: { horizon: number; stopAtr: number; targetAtr: number; minTrades: number };
}

export interface SignalOptions {
	/** Sessions before an idea expires. */
	horizon?: number;
	/** Stop distance in ATRs. */
	stopAtr?: number;
	/** Target distance in ATRs. */
	targetAtr?: number;
	/** A call must have fired within this many sessions. */
	freshness?: number;
	/** How many of the most recent trades to return (default 40). */
	maxTrades?: number;
	/** Signal rules to replay (defaults to the app's strategy). */
	strategy?: (bars: PriceBar[]) => TradingSignal[];
}

export const SIGNAL_DEFAULTS = { horizon: 20, stopAtr: 2, targetAtr: 3, freshness: 3 } as const;
/** Below this many closed trades a success rate is shown but flagged as unreliable. */
export const MIN_TRADES = 5;
/** Sessions before the default strategy can fire (it needs the 200-day average). */
const WARMUP = 200;
/** Stops closer than this share of the price get swamped by ordinary daily noise. */
const MIN_STOP_PCT = 0.02;

const actionable = (s: TradingSignal) => s.strength !== "weak" && s.signal !== "HOLD";

const ok = (v: number | undefined): v is number => v !== undefined && !Number.isNaN(v);

function mk(bars: PriceBar[], i: number, side: Side, strong: boolean, reason: string): TradingSignal {
	return { index: i, date: bars[i]?.date, signal: side, strength: strong ? "strong" : "moderate", reason };
}

/**
 * Buy dips inside an established uptrend; sell rallies inside a downtrend.
 * Fires on the first session RSI(14) crosses into the zone, not on every session in it.
 */
export function pullbackStrategy(bars: PriceBar[]): TradingSignal[] {
	const closes = bars.map((b) => b.close);
	const r = rsi(closes, 14);
	const s50 = sma(closes, 50);
	const s200 = sma(closes, 200);
	const bb = bollingerBands(closes, 20, 2);
	const out: TradingSignal[] = [];
	for (let i = 200; i < bars.length; i++) {
		const [c, ri, rp, a, b] = [closes[i] as number, r[i], r[i - 1], s50[i], s200[i]];
		if (!ok(ri) || !ok(rp) || !ok(a) || !ok(b)) continue;
		if (c > b && a > b && ri < 35 && rp >= 35) {
			out.push(
				mk(
					bars,
					i,
					"BUY",
					ri < 30 || c <= (bb.lower[i] ?? 0),
					`Pullback in an uptrend (RSI ${ri.toFixed(0)}, above the 200-day average)`,
				),
			);
		} else if (c < b && a < b && ri > 65 && rp <= 65) {
			out.push(
				mk(
					bars,
					i,
					"SELL",
					ri > 70 || c >= (bb.upper[i] ?? Number.POSITIVE_INFINITY),
					`Rally in a downtrend (RSI ${ri.toFixed(0)}, below the 200-day average)`,
				),
			);
		}
	}
	return out;
}

/** New 50-session closing high above the 200-day average (BUY); new 50-session low below it (SELL). */
export function breakoutStrategy(bars: PriceBar[]): TradingSignal[] {
	const closes = bars.map((b) => b.close);
	const vols = bars.map((b) => b.volume ?? 0);
	const s200 = sma(closes, 200);
	const v20 = sma(vols, 20);
	const out: TradingSignal[] = [];
	const N = 50;
	let wasHigh = false;
	let wasLow = false;
	for (let i = Math.max(200, N); i < bars.length; i++) {
		const prior = closes.slice(i - N, i);
		const c = closes[i] as number;
		const b = s200[i];
		const isHigh = c > Math.max(...prior);
		const isLow = c < Math.min(...prior);
		const heavy = ok(v20[i - 1]) && (v20[i - 1] as number) > 0 && (vols[i] as number) > 1.5 * (v20[i - 1] as number);
		if (ok(b) && isHigh && !wasHigh && c > b) {
			out.push(
				mk(
					bars,
					i,
					"BUY",
					heavy,
					`Breakout to a ${N}-session high${heavy ? " on heavy volume" : ""}, above the 200-day average`,
				),
			);
		} else if (ok(b) && isLow && !wasLow && c < b) {
			out.push(
				mk(
					bars,
					i,
					"SELL",
					heavy,
					`Breakdown to a ${N}-session low${heavy ? " on heavy volume" : ""}, below the 200-day average`,
				),
			);
		}
		wasHigh = isHigh;
		wasLow = isLow;
	}
	return out;
}

/** MACD crossing its signal line in the direction of the 200-day trend. */
export function macdTrendStrategy(bars: PriceBar[]): TradingSignal[] {
	const closes = bars.map((b) => b.close);
	const { histogram: h } = macd(closes);
	const s50 = sma(closes, 50);
	const s200 = sma(closes, 200);
	const out: TradingSignal[] = [];
	for (let i = 200; i < bars.length; i++) {
		const [hi, hp, a, b, c] = [h[i], h[i - 1], s50[i], s200[i], closes[i] as number];
		if (!ok(hi) || !ok(hp) || !ok(b) || !ok(a)) continue;
		if (hi > 0 && hp <= 0 && c > b)
			out.push(mk(bars, i, "BUY", a > b, "MACD bullish crossover above the 200-day average"));
		else if (hi < 0 && hp >= 0 && c < b)
			out.push(mk(bars, i, "SELL", a < b, "MACD bearish crossover below the 200-day average"));
	}
	return out;
}

/** The original indicator vote (RSI, MACD, Bollinger, SMA, stochastic, OBV). */
export function compositeStrategy(bars: PriceBar[]): TradingSignal[] {
	return generateSignals(
		bars.map((b) => b.close),
		bars.map((b) => b.high ?? b.close),
		bars.map((b) => b.low ?? b.close),
		bars.map((b) => b.volume ?? 0),
		bars.map((b) => b.date),
	);
}

export function analyzeSignals(bars: PriceBar[], options: SignalOptions = {}): SignalAnalysis {
	const horizon = options.horizon ?? SIGNAL_DEFAULTS.horizon;
	const stopAtr = options.stopAtr ?? SIGNAL_DEFAULTS.stopAtr;
	const targetAtr = options.targetAtr ?? SIGNAL_DEFAULTS.targetAtr;
	const freshness = options.freshness ?? SIGNAL_DEFAULTS.freshness;

	const closes = bars.map((b) => b.close);
	const highs = bars.map((b) => b.high ?? b.close);
	const lows = bars.map((b) => b.low ?? b.close);
	const atrLine = atr(highs, lows, closes, 14);
	const signals = (options.strategy ?? breakoutStrategy)(bars).filter(actionable);

	const rules = { horizon, stopAtr, targetAtr, minTrades: MIN_TRADES };
	const levels = (side: Side, entry: number, i: number) => {
		const a = atrLine[i];
		const unit = a !== undefined && !Number.isNaN(a) && a > 0 ? a : null;
		if (unit === null) return null;
		const risk = Math.max(unit * stopAtr, entry * MIN_STOP_PCT);
		const reward = Math.max(unit * targetAtr, risk * (targetAtr / stopAtr));
		return side === "BUY"
			? { stop: entry - risk, target: entry + reward }
			: { stop: entry + risk, target: Math.max(entry - reward, entry * 0.01) };
	};

	const buy = simulate("BUY", bars, signals, levels, horizon);
	const sell = simulate("SELL", bars, signals, levels, horizon);
	const track = {
		BUY: summarize("BUY", buy, bars, horizon),
		SELL: summarize("SELL", sell, bars, horizon),
	};

	// Current call: the latest actionable signal in the last `freshness` sessions.
	let call: SignalCall | null = null;
	const latest = signals.at(-1);
	if (latest && latest.index >= bars.length - freshness) {
		const side = latest.signal as Side;
		const entry = closes.at(-1) as number;
		const lv = levels(side, entry, bars.length - 1);
		call = {
			side,
			strength: latest.strength as "strong" | "moderate",
			date: latest.date ?? (bars[latest.index] as PriceBar).date,
			reason: latest.reason,
			plan: lv ? plan(side, entry, lv, horizon) : null,
			track: track[side],
		};
	}

	const trades = [...buy, ...sell]
		.sort((a, b) => a.entryDate.localeCompare(b.entryDate))
		.slice(-(options.maxTrades ?? 40));
	return { call, track, trades, rules };
}

function plan(side: Side, entry: number, lv: { stop: number; target: number }, horizon: number): TradePlan {
	const p = (v: number) => round(v, v < 1 ? 6 : 4);
	return {
		side,
		entry: p(entry),
		stop: p(lv.stop),
		target: p(lv.target),
		riskPct: round((Math.abs(entry - lv.stop) / entry) * 100, 1),
		rewardPct: round((Math.abs(lv.target - entry) / entry) * 100, 1),
		horizon,
	};
}

function simulate(
	side: Side,
	bars: PriceBar[],
	signals: TradingSignal[],
	levels: (side: Side, entry: number, i: number) => { stop: number; target: number } | null,
	horizon: number,
): BacktestTrade[] {
	const bySide = new Map<number, Side>();
	for (const s of signals) bySide.set(s.index, s.signal as Side);
	const dir = side === "BUY" ? 1 : -1;
	const trades: BacktestTrade[] = [];

	let i = 0;
	while (i < bars.length - 1) {
		if (bySide.get(i) !== side) {
			i++;
			continue;
		}
		const signalBar = bars[i] as PriceBar;
		const entryIdx = i + 1;
		const entryBar = bars[entryIdx] as PriceBar;
		const entryPrice = entryBar.open ?? signalBar.close;
		const lv = levels(side, entryPrice, i);
		if (!lv || entryPrice <= 0) {
			i++;
			continue;
		}

		let exit: { idx: number; price: number; reason: BacktestTrade["exitReason"] } | null = null;
		for (let j = entryIdx; j < bars.length && !exit; j++) {
			const b = bars[j] as PriceBar;
			const ranged = b.high !== null && b.low !== null;
			const hi = ranged ? (b.high as number) : b.close;
			const lo = ranged ? (b.low as number) : b.close;
			const open = b.open ?? b.close;
			const stopHit = side === "BUY" ? lo <= lv.stop : hi >= lv.stop;
			const targetHit = side === "BUY" ? hi >= lv.target : lo <= lv.target;
			if (j > entryIdx && bySide.has(j - 1) && bySide.get(j - 1) !== side) {
				// An opposite signal yesterday: act on it at today's open, before anything else happens.
				exit = { idx: j, price: open, reason: "signal" };
			} else if (stopHit) {
				// A gap through the stop fills at the open, not at the stop.
				const gapped = side === "BUY" ? open < lv.stop : open > lv.stop;
				exit = { idx: j, price: ranged ? (gapped ? open : lv.stop) : b.close, reason: "stop" };
			} else if (targetHit) {
				const gapped = side === "BUY" ? open > lv.target : open < lv.target;
				exit = { idx: j, price: ranged ? (gapped ? open : lv.target) : b.close, reason: "target" };
			} else if (j - entryIdx + 1 >= horizon) {
				exit = { idx: j, price: b.close, reason: "time" };
			}
		}

		const last = bars.length - 1;
		const exitIdx = exit?.idx ?? last;
		const exitPrice = exit?.price ?? (bars[last] as PriceBar).close;
		trades.push({
			side,
			signalDate: signalBar.date,
			entryDate: entryBar.date,
			entryPrice: round(entryPrice, 6),
			exitDate: exit ? (bars[exitIdx] as PriceBar).date : null,
			exitPrice: round(exitPrice, 6),
			exitReason: exit?.reason ?? "open",
			returnPct: round(((exitPrice - entryPrice) / entryPrice) * 100 * dir, 2),
			sessions: exitIdx - entryIdx + 1,
		});
		// The next trade can start the session after this one closes.
		i = exitIdx + 1;
	}
	return trades;
}

function summarize(side: Side, all: BacktestTrade[], bars: PriceBar[], horizon: number): TrackRecord {
	const closed = all.filter((t) => t.exitReason !== "open");
	const wins = closed.filter((t) => t.returnPct > 0);
	const losses = closed.filter((t) => t.returnPct <= 0);
	const avg = (list: number[]) => (list.length ? round(list.reduce((a, b) => a + b, 0) / list.length, 2) : null);

	// Base rate over the stretch signals could fire in: breakouts need the 200-day average.
	const start = bars.length > WARMUP + horizon ? WARMUP : 26;
	let windows = 0;
	let favourable = 0;
	let moveSum = 0;
	const dir = side === "BUY" ? 1 : -1;
	for (let i = start; i + horizon < bars.length; i++) {
		const from = (bars[i] as PriceBar).close;
		const move = (bars[i + horizon] as PriceBar).close - from;
		windows++;
		moveSum += (move / from) * 100 * dir;
		if (side === "BUY" ? move > 0 : move < 0) favourable++;
	}

	return {
		side,
		trades: closed.length,
		wins: wins.length,
		winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
		avgReturnPct: avg(closed.map((t) => t.returnPct)),
		avgWinPct: avg(wins.map((t) => t.returnPct)),
		avgLossPct: avg(losses.map((t) => t.returnPct)),
		avgSessions: avg(closed.map((t) => t.sessions)),
		baseRate: windows ? round((favourable / windows) * 100, 1) : null,
		baseAvgPct: windows ? round(moveSum / windows, 2) : null,
		from: bars[start]?.date ?? null,
		to: bars.at(-1)?.date ?? null,
	};
}

/** "Won 14 of 22 past BUY signals (64%), avg +3.1% in 9 sessions" — or why there's no rate yet. */
export function describeTrack(t: TrackRecord): string {
	if (t.trades === 0) return `No completed ${t.side} signals in this history yet, so there's no success rate.`;
	const avg = t.avgReturnPct === null ? "" : `, avg ${t.avgReturnPct >= 0 ? "+" : ""}${t.avgReturnPct}%`;
	const days = t.avgSessions === null ? "" : ` over ${Math.round(t.avgSessions)} sessions`;
	const base = t.baseRate === null ? "" : ` (any random ${t.side === "BUY" ? "entry" : "exit"}: ${t.baseRate}%)`;
	const caution = t.trades < MIN_TRADES ? " Too few signals to rely on." : "";
	const verb = t.side === "BUY" ? "made money" : "saw the price fall";
	return `${t.wins} of ${t.trades} past ${t.side} signals ${verb} (${t.winRate}%${avg}${days})${base}.${caution}`;
}
