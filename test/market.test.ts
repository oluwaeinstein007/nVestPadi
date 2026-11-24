import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { marketOverview, screen } from "../src/analysis/market.js";
import { buildReport } from "../src/analysis/report.js";
import { fetchNgxSnapshot, titleCase } from "../src/markets/ngx.js";
import type { PriceBar } from "../src/markets/types.js";
import { AlertService } from "../src/services/alertService.js";
import { InsightService } from "../src/services/insightService.js";
import { KnowledgeBase } from "../src/services/knowledgeBase.js";
import { createMailer } from "../src/services/mailer.js";
import { MarketService } from "../src/services/marketService.js";
import { Notifier } from "../src/services/notifier.js";
import { dropTestDatabases, makeBars, marketOptions, memoryDb, security, seed, user } from "./helpers.js";

after(dropTestDatabases);

const up = Array.from({ length: 80 }, (_, i) => 100 + i);
const down = Array.from({ length: 80 }, (_, i) => 200 - i);
const flat = Array.from({ length: 80 }, () => 50);

async function fixture() {
	const db = await memoryDb();
	await seed(db, [
		{ s: security("GTCO", "Guaranty Trust Holding Company Plc", "Financial Services"), closes: up },
		{ s: security("ZENITHBANK", "Zenith Bank Plc", "Financial Services"), closes: down },
		{ s: security("DANGCEM", "Dangote Cement", "Industrial Goods"), closes: flat },
		{ s: security("AAPL", "Apple Inc.", null, "US"), closes: up },
	]);
	return db;
}

describe("database", () => {
	it("upserts idempotently and returns latest quotes per symbol", async () => {
		const db = await fixture();
		await db.market.upsertPrices(makeBars("GTCO", up)); // re-run is a no-op
		const quotes = await db.market.latestQuotes("NGX");
		assert.equal(quotes.length, 3);
		assert.equal(quotes.find((q) => q.symbol === "GTCO")?.close, 179);
		assert.equal((await db.market.history("NGX", "GTCO")).length, 80);
		assert.deepEqual(await db.market.findExchanges("aapl"), ["US"]);
	});

	it("keeps richer existing fields when a sparser source upserts the same day", async () => {
		const db = await fixture();
		const last = makeBars("GTCO", up).at(-1) as PriceBar;
		await db.market.upsertPrices([{ ...last, open: null, high: null, volume: null }]);
		const bar = (await db.market.history("NGX", "GTCO")).at(-1);
		assert.notEqual(bar?.open, null);
		assert.notEqual(bar?.volume, null);
	});
});

describe("market overview & screener", () => {
	it("computes breadth, movers and sectors for the latest session", async () => {
		const o = await marketOverview(await fixture(), "NGX");
		assert.equal(o.count, 3);
		assert.equal(o.advancers, 1);
		assert.equal(o.decliners, 1);
		assert.equal(o.unchanged, 1);
		assert.equal(o.gainers[0]?.symbol, "GTCO");
		assert.equal(o.losers[0]?.symbol, "ZENITHBANK");
		// Flat industrials (0%) rank above financials (one up ~0.6%, one down ~0.8%).
		assert.deepEqual(
			o.sectors.map((s) => s.sector),
			["Industrial Goods", "Financial Services"],
		);
	});

	it("filters by sector/price and RSI", async () => {
		const db = await fixture();
		assert.deepEqual(
			(await screen(db, { exchange: "NGX", sector: "financial", sort: "symbol" })).map((r) => r.symbol),
			["GTCO", "ZENITHBANK"],
		);
		assert.deepEqual(
			(await screen(db, { exchange: "NGX", minPrice: 150 })).map((r) => r.symbol),
			["GTCO"],
		);
		const oversold = await screen(db, { exchange: "NGX", rsiBelow: 30 });
		assert.deepEqual(
			oversold.map((r) => r.symbol),
			["ZENITHBANK"],
		);
		assert.equal(oversold[0]?.rsi14, 0);
	});
});

describe("security report", () => {
	it("classifies trend and computes performance", async () => {
		const r = buildReport(security("GTCO", "GTCO"), makeBars("GTCO", up));
		assert.equal(r.trend, "uptrend");
		assert.equal(r.performance["1W"], Math.round(((179 - 174) / 174) * 10000) / 100);
		// Range uses intraday highs (fixture high = close × 1.01), so the top close sits just under 100%.
		assert.ok((r.range52w?.positionPct ?? 0) > 95);
		assert.ok(r.highlights.length > 0);
	});

	it("degrades gracefully with little history", async () => {
		const r = buildReport(security("NEW", "New Listing"), makeBars("NEW", [10, 11]));
		assert.equal(r.trend, "insufficient data");
		assert.equal(r.indicators.rsi14, null);
		assert.ok(r.highlights.some((h) => h.includes("sessions of history")));
	});
});

const notifier = () => new Notifier(createMailer(null), null, "self-hosted", "http://localhost:3000");

describe("alerts", () => {
	it("fires once when a condition is met, scoped to each owner", async () => {
		const db = await fixture();
		const alerts = new AlertService(db, notifier(), "self-hosted");
		const alice = await user(db);
		const bob = await user(db);
		await alerts.add(alice, { exchange: "NGX", symbol: "GTCO", condition: "above", threshold: 150 });
		await alerts.add(alice, { exchange: "NGX", symbol: "GTCO", condition: "below", threshold: 10 });
		await alerts.add(bob, { exchange: "NGX", symbol: "ZENITHBANK", condition: "rsi-below", threshold: 30 });

		const fired = await alerts.check();
		assert.deepEqual(
			fired.map((f) => `${f.alert.userId}:${f.alert.symbol}:${f.alert.condition}`),
			[`${alice.id}:GTCO:above`, `${bob.id}:ZENITHBANK:rsi-below`],
		);
		assert.equal((await alerts.check()).length, 0);
		assert.equal((await alerts.list(alice, true)).length, 1);
		assert.equal((await alerts.list(bob)).length, 1);
		assert.equal(
			await alerts.remove(bob, (await alerts.list(alice))[0]?.id as number),
			false,
			"can't delete someone else's alert",
		);
	});

	it("re-arms a fired alert", async () => {
		const db = await fixture();
		const alerts = new AlertService(db, notifier(), "self-hosted");
		const u = await user(db);
		const a = await alerts.add(u, { exchange: "NGX", symbol: "GTCO", condition: "above", threshold: 150 });
		await alerts.check();
		assert.equal((await alerts.rearm(u, a.id)).triggeredAt, null);
		assert.equal((await alerts.check()).length, 1);
	});

	it("validates thresholds", async () => {
		const db = await memoryDb();
		const alerts = new AlertService(db, notifier(), "self-hosted");
		const u = await user(db);
		await assert.rejects(alerts.add(u, { exchange: "NGX", symbol: "X", condition: "volume-spike", threshold: 0.5 }));
		await assert.rejects(alerts.add(u, { exchange: "NGX", symbol: "X", condition: "above", threshold: Number.NaN }));
	});

	it("enforces the plan's active-alert limit in cloud mode", async () => {
		const db = await fixture();
		const alerts = new AlertService(db, notifier(), "cloud");
		const free = await user(db);
		const pro = await user(db, { plan: "pro" });
		for (let i = 0; i < 3; i++)
			await alerts.add(free, { exchange: "NGX", symbol: "GTCO", condition: "above", threshold: 200 + i });
		await assert.rejects(
			alerts.add(free, { exchange: "NGX", symbol: "GTCO", condition: "above", threshold: 999 }),
			(e: Error & { status?: number }) => e.status === 402,
		);
		for (let i = 0; i < 4; i++)
			await alerts.add(pro, { exchange: "NGX", symbol: "GTCO", condition: "above", threshold: 200 + i });
	});
});

describe("symbol detection for AI answers", () => {
	it("finds tickers and company names but not English words", async () => {
		const db = await fixture();
		const kb = new KnowledgeBase(db, null, null);
		const insights = new InsightService(db, null, kb, new MarketService(db, kb, marketOptions));
		const found = async (q: string) => (await insights.detectSymbols(q)).map((s) => s.symbol).sort();
		assert.deepEqual(await found("How is GTCO doing vs zenith bank?"), ["GTCO", "ZENITHBANK"]);
		assert.deepEqual(await found("thoughts on dangote cement and apple"), ["AAPL", "DANGCEM"]);
		assert.deepEqual(await found("what is a good stock to buy"), []);
	});
});

describe("NGX helpers", () => {
	it("keeps stocks whose close is still blank mid-session, at the previous close", async (t) => {
		const row = (symbol: string, close: number | null) => ({
			Symbol: symbol,
			Sector: "FINANCIAL SERVICES",
			TradeDate: "2026-11-24T00:00:00",
			OpeningPrice: 6.9,
			HighPrice: close,
			LowPrice: close,
			ClosePrice: close,
			PrevClosingPrice: 6.9,
			Change: close === null ? null : close - 6.9,
			PercChange: null,
			Trades: 67,
			Volume: 505496,
			Value: 3214165.25,
		});
		// The board answers JSON; the afx name lookup gets nothing useful and falls back to tickers.
		t.mock.method(globalThis, "fetch", async (url: string) =>
			String(url).includes("ngxgroup")
				? new Response(JSON.stringify([row("ABBEYBANK", null), row("GTCO", 7.2)]))
				: new Response("<html></html>"),
		);
		const { bars } = await fetchNgxSnapshot();
		const abbey = bars.find((b) => b.symbol === "ABBEYBANK");
		assert.equal(bars.length, 2);
		assert.equal(abbey?.close, 6.9);
		assert.equal(abbey?.change, 0);
		assert.equal(abbey?.changePct, 0);
		assert.equal(abbey?.trades, 67);
		assert.equal(bars.find((b) => b.symbol === "GTCO")?.changePct, 4.35);
	});

	it("title-cases sectors sensibly", async () => {
		assert.equal(titleCase("OIL AND GAS"), "Oil and Gas");
		assert.equal(titleCase("ICT"), "ICT");
		assert.equal(titleCase("CONSTRUCTION/REAL ESTATE"), "Construction/Real Estate");
	});
});
