import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { signalIdeas, signalSummary, verdict } from "../src/analysis/ideas.js";
import { buildReport } from "../src/analysis/report.js";
import { analyzeSignals, breakoutStrategy, describeTrack } from "../src/analysis/signals.js";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { isMarketOpen } from "../src/markets/hours.js";
import type { PriceBar } from "../src/markets/types.js";
import { fetchCryptoHistory, fetchIntraday } from "../src/markets/yahoo.js";
import { AlertService } from "../src/services/alertService.js";
import type { Notifier } from "../src/services/notifier.js";
import { dropTestDatabases, makeBars, memoryDb, security, seed, testEnv, user } from "./helpers.js";

/**
 * 150 sessions of steady gains, 130 of tight sideways trading (no new highs),
 * then a breakout followed by `after` (one multiplier per session).
 */
function breakoutSeries(after: number[]): number[] {
	const closes = Array.from({ length: 150 }, (_, i) => 100 + i * 0.1);
	for (let i = 0; i < 130; i++) closes.push(115 + (i % 2 ? 0.5 : -0.5));
	closes.push(118);
	for (const m of after) closes.push((closes.at(-1) as number) * m);
	return closes;
}
const BREAKOUT = 280;

describe("breakout signals", () => {
	it("fires once, on the first new 50-session high above the 200-day average", () => {
		const bars = makeBars("GTCO", breakoutSeries(Array(10).fill(1.01)));
		const buys = breakoutStrategy(bars).filter((s) => s.signal === "BUY");
		assert.deepEqual(
			buys.map((s) => s.index),
			[BREAKOUT],
		);
		assert.match(buys[0]?.reason ?? "", /50-session high/);
	});

	it("scores a breakout that rallies as a win at the target", () => {
		const a = analyzeSignals(makeBars("GTCO", breakoutSeries(Array(30).fill(1.015))), { maxTrades: 100 });
		const trade = a.trades.find((t) => t.side === "BUY");
		assert.equal(trade?.exitReason, "target");
		assert.ok((trade?.returnPct ?? 0) > 0);
		assert.equal(a.track.BUY.trades, 1);
		assert.equal(a.track.BUY.winRate, 100);
		assert.ok(a.track.BUY.baseRate !== null && a.track.BUY.baseAvgPct !== null);
	});

	it("scores a breakout that collapses as a loss at the stop, filling a gap at the open", () => {
		const closes = breakoutSeries([1.002, 0.8, 1, 1, 1]);
		const bars = makeBars("GTCO", closes).map((b, i) => (i === BREAKOUT + 2 ? { ...b, open: b.close } : b));
		const trade = analyzeSignals(bars, { maxTrades: 100 }).trades.find((t) => t.side === "BUY");
		assert.equal(trade?.exitReason, "stop");
		// Gapped through the stop: filled at that session's open (≈ −20%), not at the stop level.
		assert.ok((trade?.returnPct ?? 0) < -15, `return ${trade?.returnPct}`);
	});

	it("checks close-only history on the close", () => {
		const bars: PriceBar[] = makeBars("NB", breakoutSeries([1.002, 0.9, 1, 1])).map((b) => ({
			...b,
			open: null,
			high: null,
			low: null,
		}));
		const trade = analyzeSignals(bars, { maxTrades: 100 }).trades.find((t) => t.side === "BUY");
		assert.equal(trade?.exitReason, "stop");
		assert.equal(trade?.exitPrice, bars[BREAKOUT + 2]?.close);
	});

	it("makes a fresh breakout the current call, with a stop below and a target above", () => {
		const r = buildReport(security("GTCO", "GTCO"), makeBars("GTCO", breakoutSeries([1.005])));
		assert.equal(r.call?.side, "BUY");
		const p = r.call?.plan;
		assert.ok(p && p.stop < p.entry && p.entry < p.target, JSON.stringify(p));
		assert.ok(p.riskPct >= 2, "stop is at least 2% away");
		assert.ok(r.highlights.some((h) => h.startsWith("Plan: buy near")));
		assert.ok(r.highlights.some((h) => h.startsWith("Track record:")));
	});

	it("has no call once the signal is stale or with too little history", () => {
		const stale = buildReport(security("GTCO", "GTCO"), makeBars("GTCO", breakoutSeries(Array(10).fill(1))));
		assert.equal(stale.call, null);
		const young = buildReport(
			security("NEW", "New"),
			makeBars(
				"NEW",
				Array.from({ length: 80 }, (_, i) => 10 + i),
			),
		);
		assert.equal(young.call, null);
	});

	it("describes a thin record as too few to rely on", () => {
		const a = analyzeSignals(makeBars("GTCO", breakoutSeries(Array(30).fill(1.015))));
		assert.match(describeTrack(a.track.BUY), /1 of 1 past BUY signals made money .*Too few signals to rely on/);
		assert.match(describeTrack(a.track.SELL), /No completed SELL signals/);
	});
});

describe("signal ideas", () => {
	it("lists securities with a fresh call and summarises the market's record", async () => {
		const db = await memoryDb();
		await seed(db, [
			{ s: security("GTCO", "Guaranty Trust"), closes: breakoutSeries([1.005]) },
			// Same session dates as GTCO, so both are in the latest session.
			{ s: security("FLAT", "Flat Co"), closes: Array(breakoutSeries([1.005]).length).fill(10) },
		]);
		const ideas = await signalIdeas(db, "NGX");
		assert.deepEqual(
			ideas.map((i) => i.symbol),
			["GTCO"],
		);
		assert.equal((await signalIdeas(db, "NGX", { side: "SELL" })).length, 0);
		const summary = await signalSummary(db, "NGX");
		assert.equal(summary.BUY.symbols, 2);
		assert.equal(summary.BUY.side, "BUY");
	});
});

describe("market verdict", () => {
	it("only calls a record better or worse than chance when luck can't explain it", () => {
		assert.equal(verdict(100, 221, 42), "unclear"); // 45.2% vs 42%: within noise
		assert.equal(verdict(130, 221, 42), "better"); // 58.8% vs 42%
		assert.equal(verdict(60, 221, 42), "worse");
		assert.equal(verdict(4, 5, 49), "unclear"); // 80% of 5 is too few to tell
		assert.equal(verdict(0, 0, 50), "unclear");
	});
});

describe("crypto candle upgrades", () => {
	it("finds symbols whose stored history is mostly close-only", async () => {
		const db = await memoryDb();
		const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
		await db.market.upsertPrices([
			...makeBars("OLD", closes, "CRYPTO").map((b) => ({ ...b, high: null, low: null })),
			...makeBars("NEW", closes, "CRYPTO"),
		]);
		assert.deepEqual(await db.market.closeOnlyHistory("CRYPTO", 60), ["OLD"]);
		await db.close();
	});
});

describe("signal alerts", () => {
	const silent = { deliver: async () => [] } as unknown as Notifier;

	it("fires signal-buy on a fresh BUY and validates the success-rate threshold", async () => {
		const db = await memoryDb();
		await seed(db, [{ s: security("GTCO", "Guaranty Trust"), closes: breakoutSeries([1.005]) }]);
		const alerts = new AlertService(db, silent, "self-hosted");
		const owner = await user(db);
		await assert.rejects(
			alerts.add(owner, { exchange: "NGX", symbol: "GTCO", condition: "signal-buy", threshold: 150 }),
		);
		await alerts.add(owner, { exchange: "NGX", symbol: "GTCO", condition: "signal-buy", threshold: 0 });
		await alerts.add(owner, { exchange: "NGX", symbol: "GTCO", condition: "signal-sell", threshold: 0 });
		// Only one past BUY: a minimum success rate can't be met by so little evidence.
		await alerts.add(owner, { exchange: "NGX", symbol: "GTCO", condition: "signal-buy", threshold: 50 });
		const fired = await alerts.check();
		assert.deepEqual(
			fired.map((f) => f.alert.condition),
			["signal-buy"],
		);
		assert.match(fired[0]?.message ?? "", /BUY signal .*stop .*target/);
	});
});

describe("signals on holdings", () => {
	it("flags a holding's signal in the portfolio and the personal digest", async () => {
		const app = await createApp(parseConfig(await testEnv()));
		const closes = breakoutSeries([]);
		const day = new Date().toISOString().slice(0, 10);
		const start = new Date(Date.now() - (closes.length - 1) * 86_400_000).toISOString().slice(0, 10);
		await app.db.market.upsertSecurities([security("GTCO", "Guaranty Trust")]);
		await app.db.market.upsertPrices(makeBars("GTCO", closes, "NGX", start));
		const u = await user(app.db);
		await app.portfolio.add(u, { symbol: "GTCO", quantity: 10, avgCost: 100 });

		const position = (await app.portfolio.get(u)).positions[0];
		assert.equal(position?.signal?.side, "BUY");
		assert.equal(position?.signal?.date, day);
		const body = (await app.digests.userDigest(u, day))?.paragraphs.join("\n") ?? "";
		assert.match(body, /\*\*New signals\*\*\n🟢 BUY GTCO — you hold it/);
		await app.close();
	});
});

describe("market hours", () => {
	it("knows NGX's session in Lagos time", () => {
		assert.equal(isMarketOpen("NGX", new Date("2026-11-23T09:30:00Z")), true); // Mon 10:30 WAT
		assert.equal(isMarketOpen("NGX", new Date("2026-11-23T08:30:00Z")), false); // 09:30 WAT
		assert.equal(isMarketOpen("NGX", new Date("2026-11-23T13:45:00Z")), false); // 14:45 WAT
		assert.equal(isMarketOpen("NGX", new Date("2026-11-21T10:00:00Z")), false); // Saturday
	});

	it("follows New York daylight saving for US stocks", () => {
		assert.equal(isMarketOpen("US", new Date("2026-07-01T14:00:00Z")), true); // 10:00 EDT
		assert.equal(isMarketOpen("US", new Date("2026-12-01T14:00:00Z")), false); // 09:00 EST
		assert.equal(isMarketOpen("US", new Date("2026-12-01T20:59:00Z")), true); // 15:59 EST
		assert.equal(isMarketOpen("CRYPTO", new Date("2026-11-21T03:00:00Z")), true);
	});
});

describe("Yahoo parsing", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const respond = (body: unknown) => {
		globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
	};

	it("stores crypto volume as units and the USD amount as value", async () => {
		respond({
			chart: {
				result: [
					{
						meta: { symbol: "BTC-USD", shortName: "Bitcoin USD", currency: "USD", chartPreviousClose: 100 },
						timestamp: [1795392000],
						indicators: { quote: [{ open: [100], high: [110], low: [95], close: [105], volume: [2100] }] },
					},
				],
			},
		});
		const { securities, bars } = await fetchCryptoHistory("btc");
		assert.equal(securities[0]?.name, "Bitcoin");
		assert.equal(bars[0]?.exchange, "CRYPTO");
		assert.equal(bars[0]?.symbol, "BTC");
		assert.equal(bars[0]?.volume, 20);
		assert.equal(bars[0]?.value, 2100);
		assert.equal(bars[0]?.high, 110);
		assert.equal(bars[0]?.changePct, 5);
	});

	it("reads the live price, session state and 5-minute candles", async () => {
		const now = Math.floor(Date.now() / 1000);
		respond({
			chart: {
				result: [
					{
						meta: {
							symbol: "AAPL",
							regularMarketPrice: 201,
							regularMarketTime: now,
							previousClose: 200,
							currentTradingPeriod: { regular: { start: now - 600, end: now + 600 } },
						},
						timestamp: [now - 600, now - 300],
						indicators: {
							quote: [{ open: [200, null], high: [202, 203], low: [199, 200], close: [201, 202], volume: [10, 20] }],
						},
					},
				],
			},
		});
		const q = await fetchIntraday("AAPL");
		assert.equal(q.price, 201);
		assert.equal(q.previousClose, 200);
		assert.equal(q.open, true);
		// The candle with a missing open is skipped rather than drawn wrong.
		assert.equal(q.candles.length, 1);
	});
});

after(dropTestDatabases);
