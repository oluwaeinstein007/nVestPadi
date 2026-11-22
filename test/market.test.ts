import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marketOverview, screen } from "../src/analysis/market.js";
import { buildReport } from "../src/analysis/report.js";
import { titleCase } from "../src/markets/ngx.js";
import type { PriceBar } from "../src/markets/types.js";
import { AlertService, Notifier } from "../src/services/alertService.js";
import { InsightService } from "../src/services/insightService.js";
import { KnowledgeBase } from "../src/services/knowledgeBase.js";
import { MarketService } from "../src/services/marketService.js";
import { makeBars, memoryDb, security, seed } from "./helpers.js";

const up = Array.from({ length: 80 }, (_, i) => 100 + i);
const down = Array.from({ length: 80 }, (_, i) => 200 - i);
const flat = Array.from({ length: 80 }, () => 50);

function fixture() {
	const db = memoryDb();
	seed(db, [
		{ s: security("GTCO", "Guaranty Trust Holding Company Plc", "Financial Services"), closes: up },
		{ s: security("ZENITHBANK", "Zenith Bank Plc", "Financial Services"), closes: down },
		{ s: security("DANGCEM", "Dangote Cement", "Industrial Goods"), closes: flat },
		{ s: security("AAPL", "Apple Inc.", null, "US"), closes: up },
	]);
	return db;
}

describe("database", () => {
	it("upserts idempotently and returns latest quotes per symbol", () => {
		const db = fixture();
		db.upsertPrices(makeBars("GTCO", up)); // re-run is a no-op
		const quotes = db.latestQuotes("NGX");
		assert.equal(quotes.length, 3);
		assert.equal(quotes.find((q) => q.symbol === "GTCO")?.close, 179);
		assert.equal(db.history("NGX", "GTCO").length, 80);
		assert.deepEqual(db.findExchanges("aapl"), ["US"]);
	});

	it("keeps richer existing fields when a sparser source upserts the same day", () => {
		const db = fixture();
		const last = makeBars("GTCO", up).at(-1) as PriceBar;
		db.upsertPrices([{ ...last, open: null, high: null, volume: null }]);
		const bar = db.history("NGX", "GTCO").at(-1);
		assert.notEqual(bar?.open, null);
		assert.notEqual(bar?.volume, null);
	});
});

describe("market overview & screener", () => {
	it("computes breadth, movers and sectors for the latest session", () => {
		const o = marketOverview(fixture(), "NGX");
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

	it("filters by sector/price and RSI", () => {
		const db = fixture();
		assert.deepEqual(
			screen(db, { exchange: "NGX", sector: "financial", sort: "symbol" }).map((r) => r.symbol),
			["GTCO", "ZENITHBANK"],
		);
		assert.deepEqual(
			screen(db, { exchange: "NGX", minPrice: 150 }).map((r) => r.symbol),
			["GTCO"],
		);
		const oversold = screen(db, { exchange: "NGX", rsiBelow: 30 });
		assert.deepEqual(
			oversold.map((r) => r.symbol),
			["ZENITHBANK"],
		);
		assert.equal(oversold[0]?.rsi14, 0);
	});
});

describe("security report", () => {
	it("classifies trend and computes performance", () => {
		const r = buildReport(security("GTCO", "GTCO"), makeBars("GTCO", up));
		assert.equal(r.trend, "uptrend");
		assert.equal(r.performance["1W"], Math.round(((179 - 174) / 174) * 10000) / 100);
		// Range uses intraday highs (fixture high = close × 1.01), so the top close sits just under 100%.
		assert.ok((r.range52w?.positionPct ?? 0) > 95);
		assert.ok(r.highlights.length > 0);
	});

	it("degrades gracefully with little history", () => {
		const r = buildReport(security("NEW", "New Listing"), makeBars("NEW", [10, 11]));
		assert.equal(r.trend, "insufficient data");
		assert.equal(r.indicators.rsi14, null);
		assert.ok(r.highlights.some((h) => h.includes("sessions of history")));
	});
});

describe("alerts", () => {
	it("fires once when a condition is met", async () => {
		const db = fixture();
		const alerts = new AlertService(db, new Notifier({ telegram: null, discordWebhookUrl: null }));
		alerts.add({ exchange: "NGX", symbol: "GTCO", condition: "above", threshold: 150 });
		alerts.add({ exchange: "NGX", symbol: "GTCO", condition: "below", threshold: 10 });
		alerts.add({ exchange: "NGX", symbol: "ZENITHBANK", condition: "rsi-below", threshold: 30 });

		const fired = await alerts.check();
		assert.deepEqual(
			fired.map((f) => `${f.alert.symbol}:${f.alert.condition}`),
			["GTCO:above", "ZENITHBANK:rsi-below"],
		);
		assert.equal((await alerts.check()).length, 0);
		assert.equal(alerts.list(true).length, 1);
	});

	it("validates thresholds", () => {
		const alerts = new AlertService(memoryDb(), new Notifier({ telegram: null, discordWebhookUrl: null }));
		assert.throws(() => alerts.add({ exchange: "NGX", symbol: "X", condition: "volume-spike", threshold: 0.5 }));
		assert.throws(() => alerts.add({ exchange: "NGX", symbol: "X", condition: "above", threshold: Number.NaN }));
	});
});

describe("symbol detection for AI answers", () => {
	it("finds tickers and company names but not English words", () => {
		const db = fixture();
		const kb = new KnowledgeBase(db, null, null);
		const insights = new InsightService(db, null, kb, new MarketService(db, kb, []));
		const found = (q: string) =>
			insights
				.detectSymbols(q)
				.map((s) => s.symbol)
				.sort();
		assert.deepEqual(found("How is GTCO doing vs zenith bank?"), ["GTCO", "ZENITHBANK"]);
		assert.deepEqual(found("thoughts on dangote cement and apple"), ["AAPL", "DANGCEM"]);
		assert.deepEqual(found("what is a good stock to buy"), []);
	});
});

describe("NGX helpers", () => {
	it("title-cases sectors sensibly", () => {
		assert.equal(titleCase("OIL AND GAS"), "Oil and Gas");
		assert.equal(titleCase("ICT"), "ICT");
		assert.equal(titleCase("CONSTRUCTION/REAL ESTATE"), "Construction/Real Estate");
	});
});
