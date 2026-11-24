import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { estimateConfidence } from "../src/analysis/confidence.js";
import { DEFAULT_COSTS, NO_COSTS, netReturnPct, parseCosts, roundTripPct } from "../src/analysis/costs.js";
import { signalIdeas } from "../src/analysis/ideas.js";
import { analyzeSignals } from "../src/analysis/signals.js";
import { SignalLedger } from "../src/services/signalLedger.js";
import type { LoggedSignal } from "../src/storage/repositories/signalLog.js";
import { dropTestDatabases, makeBars, memoryDb, security } from "./helpers.js";

/** Same shape as in signals.test.ts: a steady climb, a tight range, then a breakout followed by `after`. */
function breakoutSeries(after: number[]): number[] {
	const closes = Array.from({ length: 150 }, (_, i) => 100 + i * 0.1);
	for (let i = 0; i < 130; i++) closes.push(115 + (i % 2 ? 0.5 : -0.5));
	closes.push(118);
	for (const m of after) closes.push((closes.at(-1) as number) * m);
	return closes;
}
const BREAKOUT = 280;

describe("trading costs", () => {
	it("charges NGX's round trip (≈3.3% at 1% brokerage) and turns small gains into losses", () => {
		const rt = roundTripPct(DEFAULT_COSTS.NGX);
		assert.ok(rt > 3.2 && rt < 3.4, `round trip ${rt}`);
		assert.ok(netReturnPct(2.5, DEFAULT_COSTS.NGX) < 0);
		assert.ok(Math.abs(netReturnPct(5, NO_COSTS) - 5) < 1e-9);
	});

	it("reads TRADING_COSTS and rejects nonsense", () => {
		const t = parseCosts("NGX=0.9/1.2, us=0/0");
		assert.deepEqual(t.NGX, { buyPct: 0.9, sellPct: 1.2 });
		assert.deepEqual(t.US, { buyPct: 0, sellPct: 0 });
		assert.deepEqual(t.CRYPTO, DEFAULT_COSTS.CRYPTO);
		assert.throws(() => parseCosts("NGX=1.5"));
		assert.throws(() => parseCosts("NGX=50/50"));
	});

	it("scores the backtest after costs, keeping the gross figures alongside", () => {
		const bars = makeBars("GTCO", breakoutSeries(Array(30).fill(1.015)));
		const net = analyzeSignals(bars, { maxTrades: 100 });
		const gross = analyzeSignals(bars, { maxTrades: 100, costs: NO_COSTS });
		const t = net.trades.find((x) => x.side === "BUY");
		assert.ok(t && t.netReturnPct < t.returnPct);
		assert.equal(gross.track.BUY.costPct, 0);
		assert.ok(net.track.BUY.costPct > 3);
		// A random entry has to clear the costs too, so its success rate can only fall.
		assert.ok((net.track.BUY.baseRate ?? 0) <= (gross.track.BUY.baseRate ?? 0));
	});
});

describe("confidence", () => {
	const market = { wins: 300, trades: 500 }; // 60%
	const none = { wins: 0, trades: 0 };

	it("doesn't take one lucky win at face value", () => {
		const c = estimateConfidence({ wins: 1, trades: 1 }, market, none, 45);
		assert.ok(c.probability > 55 && c.probability < 70, `p ${c.probability}`);
		assert.ok(c.low < 45, "one trade can't make the range clear a random entry");
		assert.equal(c.level, "medium");
	});

	it("is high only when the whole range beats a random entry", () => {
		const c = estimateConfidence({ wins: 30, trades: 40 }, market, none, 45);
		assert.ok(c.low > 45);
		assert.equal(c.level, "high");
		assert.equal(estimateConfidence({ wins: 4, trades: 10 }, { wins: 220, trades: 500 }, none, 45).level, "low");
	});

	it("learns from live outcomes", () => {
		const before = estimateConfidence(none, market, none, 45);
		const after = estimateConfidence(none, market, { wins: 20, trades: 100 }, 45);
		assert.equal(before.probability, 60);
		assert.ok(after.probability < 50, `live losses should pull the estimate down (${after.probability})`);
		assert.equal(after.basis.live, 100);
	});
});

describe("signal ledger", () => {
	async function setup(closes: number[]) {
		const db = await memoryDb();
		await db.market.upsertSecurities([security("GTCO", "Guaranty Trust")]);
		await db.market.upsertPrices(makeBars("GTCO", closes));
		return { db, ledger: new SignalLedger(db) };
	}

	it("logs a signal once, enters on the next session and scores it after costs", async () => {
		const { db, ledger } = await setup(breakoutSeries([]));
		const [idea] = await signalIdeas(db, "NGX");
		assert.equal(idea?.symbol, "GTCO");
		assert.ok(idea?.confidence.probability !== undefined);

		assert.deepEqual(await ledger.update("NGX"), { exchange: "NGX", logged: 1, closed: 0 });
		assert.deepEqual(await ledger.update("NGX"), { exchange: "NGX", logged: 0, closed: 0 });
		const [pending] = await db.signals.list();
		assert.equal(pending?.status, "pending");
		assert.equal(pending?.seenDate, makeBars("GTCO", breakoutSeries([]))[BREAKOUT]?.date);
		assert.ok(pending?.probability !== null && pending?.confidence);

		// The rally: the stored stop/target are what get tested, from the session after the signal was seen.
		await db.market.upsertPrices(makeBars("GTCO", breakoutSeries(Array(25).fill(1.015))));
		const { closed } = await ledger.update("NGX");
		assert.equal(closed, 1);
		const [s] = await db.signals.list();
		assert.equal(s?.status, "closed");
		assert.equal(s?.exitReason, "target");
		assert.equal(s?.entryDate, makeBars("GTCO", breakoutSeries([1]))[BREAKOUT + 1]?.date);
		assert.ok((s?.netReturnPct ?? 0) > 0 && (s?.netReturnPct ?? 0) < (s?.returnPct ?? 0));

		const report = await ledger.report();
		const ngx = report.exchanges.find((e) => e.exchange === "NGX");
		assert.equal(ngx?.BUY.trades, 1);
		assert.equal(ngx?.BUY.wins, 1);
		assert.equal(
			report.calibration.buckets.reduce((n, b) => n + b.trades, 0),
			1,
		);
		assert.ok(report.calibration.brier !== null);
		// The live outcome now feeds the confidence of future signals.
		assert.deepEqual((await db.signals.outcomes("NGX", report.rule)).BUY, { wins: 1, trades: 1 });
		await db.close();
	});

	it("scores a signal seen late from when it was seen, not from when it fired", async () => {
		// The app first sees the breakout two sessions after it fired (still fresh enough to show).
		const { db, ledger } = await setup(breakoutSeries([1.001, 1.001]));
		await ledger.update("NGX");
		const [s] = await db.signals.list();
		const dates = makeBars("GTCO", breakoutSeries([1.001, 1.001, 1]));
		assert.equal(s?.signalDate, dates[BREAKOUT]?.date);
		assert.equal(s?.seenDate, dates[BREAKOUT + 2]?.date);

		await db.market.upsertPrices(makeBars("GTCO", breakoutSeries([1.001, 1.001, 0.97])));
		await ledger.update("NGX");
		const [open] = await db.signals.list();
		assert.equal(open?.entryDate, dates[BREAKOUT + 3]?.date);
		assert.equal(open?.status, "open");
		await db.close();
	});

	it("waits for the session to finish before scoring today's bar", async () => {
		// Crypto never closes, so its latest (today's) bar is always still forming.
		const closes = breakoutSeries([]);
		const start = new Date(Date.now() - closes.length * 86_400_000).toISOString().slice(0, 10);
		const db = await memoryDb();
		await db.market.upsertSecurities([security("BTC", "Bitcoin", null, "CRYPTO")]);
		await db.market.upsertPrices(makeBars("BTC", closes, "CRYPTO", start));
		const ledger = new SignalLedger(db);
		await ledger.update("CRYPTO");
		// The next bar is dated today: no entry yet.
		await db.market.upsertPrices(makeBars("BTC", breakoutSeries([1.03]), "CRYPTO", start));
		await ledger.update("CRYPTO");
		assert.equal((await db.signals.list())[0]?.status, "pending");
		await db.close();
	});

	it("never rewrites a closed signal", async () => {
		const { db, ledger } = await setup(breakoutSeries([]));
		await ledger.update("NGX");
		await db.market.upsertPrices(makeBars("GTCO", breakoutSeries([1.002, 0.8])));
		await ledger.update("NGX");
		// The collapse is also a fresh breakdown, so a SELL gets logged alongside.
		const [lost] = await db.signals.list({ side: "BUY" });
		assert.equal(lost?.exitReason, "stop");
		assert.ok((lost?.netReturnPct ?? 0) < -15);
		await db.signals.progress(lost?.id as number, { ...(lost as LoggedSignal), status: "open", netReturnPct: 99 });
		assert.equal((await db.signals.list({ side: "BUY" }))[0]?.netReturnPct, lost?.netReturnPct);
		assert.equal((await db.signals.list({ side: "SELL" })).length, 1);
		await db.close();
	});
});

after(dropTestDatabases);
