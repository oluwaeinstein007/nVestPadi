import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as ta from "../src/analysis/technicalAnalysis.js";

const ramp = (n: number, start = 100, step = 1) => Array.from({ length: n }, (_, i) => start + i * step);

describe("technical analysis", () => {
	it("computes SMA with NaN warm-up", () => {
		const out = ta.sma([1, 2, 3, 4, 5], 3);
		assert.ok(Number.isNaN(out[1]));
		assert.deepEqual(out.slice(2), [2, 3, 4]);
	});

	it("seeds EMA with the SMA of the first period", () => {
		const out = ta.ema([2, 4, 6, 8], 3);
		assert.equal(out[2], 4);
		assert.equal(out[3], 8 * 0.5 + 4 * 0.5);
	});

	it("RSI is 100 when prices only rise and 50 when flat", () => {
		assert.equal(ta.rsi(ramp(30), 14).at(-1), 100);
		assert.equal(ta.rsi(new Array(30).fill(10), 14).at(-1), 50);
	});

	it("RSI stays within 0–100 on noisy data", () => {
		const prices = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 10 + (i % 7));
		for (const v of ta.rsi(prices).filter((x) => !Number.isNaN(x))) assert.ok(v >= 0 && v <= 100);
	});

	it("MACD signal line is undefined until the MACD line has `signal` values", () => {
		const { macd, signal } = ta.macd(ramp(60), 12, 26, 9);
		const firstMacd = macd.findIndex((v) => !Number.isNaN(v));
		const firstSignal = signal.findIndex((v) => !Number.isNaN(v));
		assert.equal(firstMacd, 25);
		assert.equal(firstSignal, firstMacd + 8);
	});

	it("stochastic %D averages only defined %K values", () => {
		const highs = ramp(20, 11);
		const lows = ramp(20, 9);
		const closes = ramp(20, 10);
		const { k, d } = ta.stochastic(highs, lows, closes, 14, 3);
		const firstK = k.findIndex((v) => !Number.isNaN(v));
		assert.ok(Number.isNaN(d[firstK + 1] as number));
		assert.ok(
			Math.abs(
				(d[firstK + 2] as number) - ((k[firstK] as number) + (k[firstK + 1] as number) + (k[firstK + 2] as number)) / 3,
			) < 1e-9,
		);
	});

	it("flags a persistent rally as overbought (SELL)", () => {
		const prices = ramp(40, 100, 2);
		const signals = ta.generateSignals(
			prices,
			prices.map((p) => p + 1),
			prices.map((p) => p - 1),
			prices.map(() => 1000),
		);
		assert.ok(signals.length > 0);
		assert.equal(signals.at(-1)?.signal, "SELL");
	});
});
