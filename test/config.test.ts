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
		assert.equal(c.mode, "self-hosted");
		assert.equal(c.appUrl, "http://localhost:3000");
		assert.equal(c.email, null);
		assert.equal(c.billing, null);
		assert.equal(c.auth.secureCookies, false);
	});

	it("derives secure cookies from an https APP_URL and strips trailing slashes", () => {
		const c = parseConfig({ APP_MODE: "cloud", APP_URL: "https://nvestpadi.com/" });
		assert.equal(c.mode, "cloud");
		assert.equal(c.appUrl, "https://nvestpadi.com");
		assert.equal(c.auth.secureCookies, true);
	});

	it("warns about variables that v3 no longer reads", () => {
		const c = parseConfig({ API_KEY: "old", TELEGRAM_CHAT_ID: "1" });
		assert.equal(c.warnings.length, 2);
		assert.match(c.warnings[0] ?? "", /API_KEY is no longer used/);
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
		assert.throws(() => parseConfig({ PAYSTACK_SECRET_KEY: "sk_test" }), ConfigError);
		assert.throws(() => parseConfig({ RESEND_API_KEY: "re_x" }), ConfigError);
		assert.throws(() => parseConfig({ APP_MODE: "cloud", NODE_ENV: "production" }), ConfigError);
		assert.throws(() => parseConfig({ ALLOW_SIGNUP: "maybe" }), ConfigError);
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
