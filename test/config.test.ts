import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, DEFAULT_US_SYMBOLS, parseConfig } from "../src/config.js";

describe("config", () => {
	it("works with an empty environment", () => {
		const c = parseConfig({});
		assert.equal(c.ai, null);
		assert.equal(c.qdrant, null);
		assert.equal(c.server.host, "127.0.0.1");
		assert.equal(c.server.port, 3000);
		assert.deepEqual(c.markets.usSymbols, DEFAULT_US_SYMBOLS);
	});

	it("treats blank values as unset", () => {
		const c = parseConfig({ AI_PROVIDER: "", QDRANT_URL: "  ", PORT: "" });
		assert.equal(c.ai, null);
		assert.equal(c.qdrant, null);
		assert.equal(c.server.port, 3000);
	});

	it("applies per-provider model defaults", () => {
		const c = parseConfig({ AI_PROVIDER: "gemini", AI_API_KEY: "k" });
		assert.equal(c.ai?.embeddingModel, "gemini-embedding-001");
		assert.ok(c.ai?.chatModel.startsWith("gemini"));
	});

	it("rejects inconsistent settings with readable errors", () => {
		assert.throws(
			() => parseConfig({ AI_PROVIDER: "openai" }),
			(e: ConfigError) => e.issues[0]?.startsWith("AI_API_KEY") ?? false,
		);
		assert.throws(() => parseConfig({ TELEGRAM_BOT_TOKEN: "x" }), ConfigError);
		assert.throws(() => parseConfig({ AI_PROVIDER: "claude", AI_API_KEY: "k" }), ConfigError);
		assert.throws(() => parseConfig({ QDRANT_URL: "not a url" }), ConfigError);
	});

	it("parses US_SYMBOLS", () => {
		assert.deepEqual(parseConfig({ US_SYMBOLS: "aapl, msft,,tsla " }).markets.usSymbols, ["AAPL", "MSFT", "TSLA"]);
	});

	it("keeps :memory: database paths as-is", () => {
		assert.equal(parseConfig({ DATABASE_PATH: ":memory:" }).databasePath, ":memory:");
	});
});
