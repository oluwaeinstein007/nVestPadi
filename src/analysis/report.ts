import { round } from "../lib/util.js";
/**
 * Turns raw daily bars into a decision-ready snapshot: performance over common
 * horizons, 52-week range, key indicators, trend and a plain-English summary.
 */
import type { PriceBar, Security } from "../markets/types.js";
import * as ta from "./technicalAnalysis.js";

export type Trend = "uptrend" | "downtrend" | "sideways" | "insufficient data";

export interface SecurityReport {
	security: Security;
	latest: PriceBar;
	bars: number;
	performance: Partial<Record<"1W" | "1M" | "3M" | "6M" | "1Y", number>>;
	range52w: { high: number; low: number; positionPct: number } | null;
	indicators: {
		rsi14: number | null;
		macd: { line: number; signal: number; histogram: number } | null;
		sma20: number | null;
		sma50: number | null;
		sma200: number | null;
		bollinger: { upper: number; lower: number } | null;
		atr14: number | null;
		volatilityPct: number | null;
	};
	trend: Trend;
	signal: ta.TradingSignal | null;
	highlights: string[];
}

const HORIZONS = { "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252 } as const;

const last = (series: number[]): number | null => {
	const v = series[series.length - 1];
	return v === undefined || Number.isNaN(v) ? null : v;
};
const r2 = (v: number | null) => (v === null ? null : round(v, 2));

export function buildReport(security: Security, bars: PriceBar[]): SecurityReport {
	if (bars.length === 0) throw new Error(`No price history for ${security.symbol}`);

	const closes = bars.map((b) => b.close);
	// Sources without intraday range (afx history) fall back to the close.
	const highs = bars.map((b) => b.high ?? b.close);
	const lows = bars.map((b) => b.low ?? b.close);
	const volumes = bars.map((b) => b.volume ?? 0);
	const latest = bars[bars.length - 1] as PriceBar;
	const price = latest.close;

	const performance: SecurityReport["performance"] = {};
	for (const [label, offset] of Object.entries(HORIZONS)) {
		// A "1y" range from data providers is ~250 sessions, so accept a slightly short window.
		const idx = closes.length - 1 - offset;
		const base = idx >= 0 ? closes[idx] : closes.length - 1 >= offset * 0.95 ? closes[0] : undefined;
		if (base) performance[label as keyof typeof HORIZONS] = round(((price - base) / base) * 100, 2);
	}

	const yearCloses = closes.slice(-252);
	const yearHighs = highs.slice(-252);
	const yearLows = lows.slice(-252);
	const high = Math.max(...yearHighs, ...yearCloses);
	const low = Math.min(...yearLows, ...yearCloses);
	const range52w =
		bars.length >= 20
			? { high, low, positionPct: high === low ? 50 : round(((price - low) / (high - low)) * 100, 1) }
			: null;

	const rsi14 = last(ta.rsi(closes, 14));
	const macd = ta.macd(closes);
	const macdLine = last(macd.macd);
	const macdSignal = last(macd.signal);
	const macdHist = last(macd.histogram);
	const sma20 = last(ta.sma(closes, 20));
	const sma50 = last(ta.sma(closes, 50));
	const sma200 = last(ta.sma(closes, 200));
	const bb = ta.bollingerBands(closes, 20, 2);
	const bbUpper = last(bb.upper);
	const bbLower = last(bb.lower);
	const atr14 = last(ta.atr(highs, lows, closes, 14));

	const dailyReturns = closes.slice(1).map((c, i) => (c - (closes[i] as number)) / (closes[i] as number));
	const recent = dailyReturns.slice(-21);
	const volatilityPct =
		recent.length >= 10
			? round(Math.sqrt(recent.reduce((s, r) => s + r * r, 0) / recent.length) * Math.sqrt(252) * 100, 1)
			: null;

	const trend = classifyTrend(price, sma20, sma50);
	const signals = ta.generateSignals(
		closes,
		highs,
		lows,
		volumes,
		bars.map((b) => b.date),
	);
	const lastSignal = signals[signals.length - 1];
	// Only surface a signal if it fired in the last 5 sessions.
	const signal = lastSignal && lastSignal.index >= bars.length - 5 ? lastSignal : null;

	const report: SecurityReport = {
		security,
		latest,
		bars: bars.length,
		performance,
		range52w,
		indicators: {
			rsi14: r2(rsi14),
			macd:
				macdLine !== null && macdSignal !== null && macdHist !== null
					? { line: round(macdLine, 4), signal: round(macdSignal, 4), histogram: round(macdHist, 4) }
					: null,
			sma20: r2(sma20),
			sma50: r2(sma50),
			sma200: r2(sma200),
			bollinger: bbUpper !== null && bbLower !== null ? { upper: round(bbUpper, 2), lower: round(bbLower, 2) } : null,
			atr14: r2(atr14),
			volatilityPct,
		},
		trend,
		signal,
		highlights: [],
	};
	report.highlights = describe(report);
	return report;
}

function classifyTrend(price: number, sma20: number | null, sma50: number | null): Trend {
	if (sma20 === null) return "insufficient data";
	if (sma50 === null) return price > sma20 * 1.01 ? "uptrend" : price < sma20 * 0.99 ? "downtrend" : "sideways";
	if (price > sma20 && sma20 > sma50) return "uptrend";
	if (price < sma20 && sma20 < sma50) return "downtrend";
	return "sideways";
}

function describe(r: SecurityReport): string[] {
	const out: string[] = [];
	const { indicators: i, latest } = r;

	if (latest.changePct !== null) {
		out.push(
			latest.changePct === 0
				? `Unchanged in the latest session (${latest.date}).`
				: `${latest.changePct > 0 ? "Up" : "Down"} ${Math.abs(latest.changePct).toFixed(2)}% in the latest session (${latest.date}).`,
		);
	}
	if (r.trend !== "insufficient data") out.push(`Trend: ${r.trend} based on 20/50-day moving averages.`);
	if (i.rsi14 !== null) {
		const zone = i.rsi14 >= 70 ? "overbought" : i.rsi14 <= 30 ? "oversold" : "neutral";
		out.push(`RSI(14) is ${i.rsi14.toFixed(1)} — ${zone}.`);
	}
	if (i.macd) out.push(`MACD momentum is ${i.macd.histogram >= 0 ? "positive" : "negative"}.`);
	if (r.range52w) {
		out.push(`Trading at ${r.range52w.positionPct}% of its ${r.bars >= 252 ? "52-week" : `${r.bars}-session`} range.`);
	}
	if (i.sma200 !== null) out.push(`Price is ${latest.close >= i.sma200 ? "above" : "below"} the 200-day average.`);
	if (r.signal)
		out.push(`Recent ${r.signal.strength} ${r.signal.signal} signal on ${r.signal.date}: ${r.signal.reason}.`);
	if (r.bars < 26) out.push(`Only ${r.bars} sessions of history — run \`nvest sync\` daily to build more.`);
	return out;
}

/** Compact one-paragraph context used when grounding AI answers. */
export function reportToText(r: SecurityReport): string {
	const perf = Object.entries(r.performance)
		.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}%`)
		.join(", ");
	return [
		`${r.security.name} (${r.security.exchange}:${r.security.symbol})${r.security.sector ? `, sector ${r.security.sector}` : ""}.`,
		`Last close ${r.security.currency} ${r.latest.close} on ${r.latest.date}.`,
		perf && `Performance: ${perf}.`,
		r.range52w && `Range high ${r.range52w.high}, low ${r.range52w.low}.`,
		...r.highlights,
	]
		.filter(Boolean)
		.join(" ");
}
