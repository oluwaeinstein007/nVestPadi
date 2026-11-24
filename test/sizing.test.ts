import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { NO_COSTS } from "../src/analysis/costs.js";
import { sizePosition } from "../src/analysis/sizing.js";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { ValidationError } from "../src/lib/errors.js";
import { avgDailyValue } from "../src/services/sizingService.js";
import { dropTestDatabases, makeBars, security, testEnv } from "./helpers.js";

const NGX = { buyPct: 1.48, sellPct: 1.8 };

describe("position sizing", () => {
	it("sizes so a stop-out loses the risk budget", () => {
		// ₦1m, risk 1% = ₦10,000; ₦10 between entry and stop → 1,000 units (no fees).
		const z = sizePosition({ capital: 1_000_000, riskPct: 1, entry: 100, stop: 90, target: 120, costs: NO_COSTS });
		assert.equal(z.units, 1000);
		assert.equal(z.lossAtStop, 10_000);
		assert.equal(z.lossAtStopPct, 1);
		assert.equal(z.positionPct, 10);
		assert.equal(z.gainAtTarget, 20_000);
		assert.equal(z.rewardRisk, 2);
		assert.equal(z.limitedBy, "risk");
		assert.deepEqual(z.warnings, []);
	});

	it("counts fees in the loss, so it buys fewer units", () => {
		const z = sizePosition({ capital: 1_000_000, riskPct: 1, entry: 100, stop: 90, target: 120, costs: NGX });
		assert.ok(z.units < 1000 && z.units > 600, `units ${z.units}`);
		assert.ok(z.lossAtStop <= 10_000);
		assert.ok((z.gainAtTarget ?? 0) < z.units * 20);
	});

	it("caps one position at a share of capital when the stop is tight", () => {
		const z = sizePosition({ capital: 1_000_000, riskPct: 1, entry: 100, stop: 99.5, costs: NO_COSTS });
		assert.equal(z.limitedBy, "concentration");
		assert.equal(z.units, 2500);
		assert.equal(z.positionPct, 25);
		assert.match(z.warnings.join(" "), /Capped at 25%/);
	});

	it("says when the account is too small for even one unit", () => {
		const z = sizePosition({ capital: 1000, riskPct: 1, entry: 500, stop: 400, costs: NO_COSTS });
		assert.equal(z.units, 0);
		assert.equal(z.limitedBy, "too-small");
	});

	it("buys fractions only where the market allows them", () => {
		const z = sizePosition({
			capital: 1000,
			riskPct: 1,
			entry: 60_000,
			stop: 57_000,
			costs: NO_COSTS,
			fractional: true,
		});
		assert.ok(z.units > 0 && z.units < 1);
	});

	it("warns about thin trading, targets eaten by fees and high risk", () => {
		const z = sizePosition({
			capital: 10_000_000,
			riskPct: 3,
			entry: 10,
			stop: 9,
			target: 10.3,
			costs: NGX,
			maxPositionPct: 100,
			avgDailyValue: 500_000,
		});
		const text = z.warnings.join(" ");
		assert.match(text, /typical day's trading/);
		assert.match(text, /barely breaks even/);
		assert.match(text, /Risking 3%/);
		assert.ok((z.shareOfDailyValue ?? 0) > 100);
	});

	it("rejects levels that make no sense", () => {
		assert.throws(
			() => sizePosition({ capital: 1000, riskPct: 1, entry: 10, stop: 11, costs: NO_COSTS }),
			ValidationError,
		);
		assert.throws(() => sizePosition({ capital: 0, riskPct: 1, entry: 10, stop: 9, costs: NO_COSTS }), ValidationError);
		assert.throws(
			() => sizePosition({ capital: 100, riskPct: 0, entry: 10, stop: 9, costs: NO_COSTS }),
			ValidationError,
		);
	});

	it("averages recent turnover from value, or close × volume", () => {
		const bars = makeBars("X", [10, 10]).map((b, i) => ({ ...b, volume: 100, value: i === 0 ? 5000 : null }));
		assert.equal(avgDailyValue(bars), (5000 + 1000) / 2);
		assert.equal(avgDailyValue([]), null);
	});
});

describe("sizing service and bot", () => {
	/** A steady climb, a tight range, then a breakout on the last session: a fresh BUY with a stop. */
	const closes = [
		...Array.from({ length: 150 }, (_, i) => 100 + i * 0.1),
		...Array.from({ length: 130 }, (_, i) => 115 + (i % 2 ? 0.5 : -0.5)),
		118.6,
	];

	it("sizes from the current BUY signal, or from the user's own stop", async () => {
		const app = await createApp(parseConfig(await testEnv()));
		await app.db.market.upsertSecurities([security("GTCO", "Guaranty Trust"), security("FLAT", "Flat Co")]);
		await app.db.market.upsertPrices([...makeBars("GTCO", closes), ...makeBars("FLAT", Array(closes.length).fill(10))]);

		const r = await app.sizing.size({ symbol: "GTCO", exchange: "NGX", capital: 1_000_000 });
		assert.equal(r.levels.source, "signal");
		assert.ok(r.levels.stop < r.levels.entry);
		assert.ok(r.sizing.units > 0);
		assert.ok(r.sizing.lossAtStopPct <= 1);
		assert.ok(r.sizing.shareOfDailyValue !== null);

		await assert.rejects(app.sizing.size({ symbol: "FLAT", exchange: "NGX", capital: 1_000_000 }), /no BUY signal/);
		const own = await app.sizing.size({ symbol: "FLAT", exchange: "NGX", capital: 1_000_000, stop: 9 });
		assert.equal(own.levels.source, "custom");

		const reply = await app.bots.handle("size", "GTCO 1,000,000 1", {
			platform: "telegram",
			chatKey: "1",
			isPrivate: false,
			user: null,
		});
		assert.match(reply, /\*\*GTCO position size\*\*/);
		assert.match(reply, /Buy \*\*[\d,]+\*\* units/);
		assert.match(
			await app.bots.handle("size", "GTCO", { platform: "telegram", chatKey: "1", isPrivate: false, user: null }),
			/Usage/,
		);
		await app.close();
	});
});

after(dropTestDatabases);
