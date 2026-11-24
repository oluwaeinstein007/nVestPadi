import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildReport } from "../src/analysis/report.js";
import { normalizeUsSymbol } from "../src/markets/nasdaq.js";
import { parseAfxChart } from "../src/markets/ngx.js";
import { withChanges } from "../src/markets/types.js";
import { usVenue } from "../src/markets/yahoo.js";
import { makeBars, memoryDb, security, seed } from "./helpers.js";

describe("market data sources", () => {
	it("parses afx chart history into daily bars with changes", async () => {
		const script = `$(function(){...series:[{name:'GTCO',data:[[d("2026-11-18"),116],[d("2026-11-19"),116],[d("2026-11-20"),114],]}]});})`;
		const bars = parseAfxChart("GTCO", script);
		assert.deepEqual(
			bars.map((b) => [b.date, b.close, b.changePct]),
			[
				["2026-11-18", 116, null],
				["2026-11-19", 116, 0],
				["2026-11-20", 114, -1.72],
			],
		);
		assert.equal(bars[0]?.exchange, "NGX");
	});

	it("maps Yahoo exchange codes to venue names", async () => {
		assert.equal(usVenue("NMS", "NasdaqGS"), "Nasdaq");
		assert.equal(usVenue("NYQ", "NYSE"), "NYSE");
		assert.equal(usVenue(undefined, "NasdaqCM"), "Nasdaq");
		assert.equal(usVenue(undefined, undefined), null);
	});

	it("normalizes Nasdaq share-class symbols to Yahoo's format", async () => {
		assert.equal(normalizeUsSymbol("BRK/B"), "BRK-B");
		assert.equal(normalizeUsSymbol(" aapl "), "AAPL");
	});

	it("keeps changes a source already provided", async () => {
		const [a, b] = withChanges(makeBars("X", [10, 11]).map((bar) => ({ ...bar, change: null, changePct: null })));
		assert.equal(a?.changePct, null);
		assert.equal(b?.changePct, 10);
	});
});

describe("listing metadata", () => {
	it("enriches sectors and venues without overwriting names", async () => {
		const db = await memoryDb();
		await seed(db, [{ s: security("BRK-B", "Berkshire Hathaway", null, "US"), closes: [1, 2] }]);
		await db.market.enrichSecurities("US", new Map([["BRK-B", { sector: "Finance", venue: "NYSE", marketCap: 1e12 }]]));
		const s = await db.market.getSecurity("US", "BRK-B");
		assert.deepEqual([s?.name, s?.sector, s?.venue, s?.marketCap], ["Berkshire Hathaway", "Finance", "NYSE", 1e12]);
		// A later sparse upsert (e.g. a history fetch) keeps the metadata.
		await db.market.upsertSecurities([security("BRK-B", "Berkshire Hathaway Inc.", null, "US")]);
		assert.equal(await db.market.getSecurity("US", "BRK-B")?.sector, "Finance");
		assert.equal(await db.market.latestQuote("US", "BRK-B")?.venue, "NYSE");
	});

	it("never replaces a real company name with a bare ticker", async () => {
		const db = await memoryDb();
		await db.market.upsertSecurities([security("CORNERST", "Cornerstone Insurance Company")]);
		await db.market.upsertSecurities([security("CORNERST", "CORNERST")]); // e.g. the name lookup failed
		assert.equal(await db.market.getSecurity("NGX", "CORNERST")?.name, "Cornerstone Insurance Company");
		await db.market.upsertSecurities([security("CORNERST", "Cornerstone Insurance Plc")]);
		assert.equal(await db.market.getSecurity("NGX", "CORNERST")?.name, "Cornerstone Insurance Plc");
	});

	it("lists symbols that still need history", async () => {
		const db = await memoryDb();
		await seed(db, [
			{ s: security("THIN", "Thin"), closes: [1, 2, 3] },
			{ s: security("DEEP", "Deep"), closes: Array.from({ length: 70 }, (_, i) => i + 1) },
		]);
		assert.deepEqual(await db.market.thinHistory("NGX", 60), ["THIN"]);
	});
});

describe("crypto reports", () => {
	it("measures performance in calendar days", async () => {
		const closes = Array.from({ length: 400 }, (_, i) => 100 + i);
		const r = buildReport(security("BTC", "Bitcoin", "Bitcoin", "CRYPTO"), makeBars("BTC", closes, "CRYPTO"));
		// 1W = 7 days back for crypto (5 sessions for stocks).
		assert.equal(r.performance["1W"], Math.round(((499 - 492) / 492) * 10000) / 100);
		assert.ok(r.range52w);
	});
});
