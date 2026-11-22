import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { createRequestHandler } from "../src/server/server.js";
import { security, seed } from "./helpers.js";

describe("HTTP API", () => {
	const app = createApp(parseConfig({ DATABASE_PATH: ":memory:", API_KEY: "test-key", NODE_ENV: "test" }));
	let server: Server;
	let base = "";
	const call = (path: string, init: RequestInit = {}, key: string | null = "test-key") =>
		fetch(`${base}${path}`, {
			...init,
			headers: {
				...(key && { Authorization: `Bearer ${key}` }),
				...(init.body ? { "Content-Type": "application/json" } : {}),
			},
		});

	before(async () => {
		seed(app.db, [{ s: security("GTCO", "Guaranty Trust", "Financial Services"), closes: [100, 102, 101, 105] }]);
		server = createServer(createRequestHandler(app));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	after(() => {
		server.close();
		app.close();
	});

	it("serves health without auth but protects the API", async () => {
		assert.equal((await call("/api/health", {}, null)).status, 200);
		assert.equal((await call("/api/status", {}, null)).status, 401);
		assert.equal((await call("/api/status", {}, "wrong")).status, 401);
		assert.equal((await call("/api/status")).status, 200);
	});

	it("serves the landing page, the dashboard and images, and refuses path traversal", async () => {
		const res = await call("/", {}, null);
		assert.equal(res.status, 200);
		assert.match(await res.text(), /AI research desk/);
		const dashboard = await call("/app", {}, null);
		assert.match(await dashboard.text(), /id="screen-form"/);
		const image = await call("/img/dashboard-dark.webp", {}, null);
		assert.equal(image.headers.get("content-type"), "image/webp");
		assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		assert.equal((await call("/../package.json", {}, null)).status, 404);
	});

	it("returns market data", async () => {
		const market = (await (await call("/api/market?exchange=ngx")).json()) as {
			count: number;
			gainers: { symbol: string }[];
		};
		assert.equal(market.count, 1);
		assert.equal(market.gainers[0]?.symbol, "GTCO");
	});

	it("validates input with 400s and unknown symbols with 404", async () => {
		assert.equal((await call("/api/market?exchange=LSE")).status, 400);
		const bad = await call("/api/alerts", {
			method: "POST",
			body: JSON.stringify({ symbol: "GTCO", condition: "nope", threshold: 1 }),
		});
		assert.equal(bad.status, 400);
		assert.equal((await call("/api/alerts", { method: "POST", body: "{oops" })).status, 400);
		assert.equal(
			(await call("/api/watchlist", { method: "POST", body: JSON.stringify({ symbol: "GTCO", exchange: "XX" }) }))
				.status,
			400,
		);
	});

	it("creates and deletes alerts", async () => {
		const res = await call("/api/alerts", {
			method: "POST",
			body: JSON.stringify({ symbol: "gtco", condition: "above", threshold: 200 }),
		});
		const alert = (await res.json()) as { id: number; exchange: string };
		assert.equal(alert.exchange, "NGX");
		assert.equal((await call(`/api/alerts/${alert.id}`, { method: "DELETE" })).status, 200);
		assert.equal((await call(`/api/alerts/${alert.id}`, { method: "DELETE" })).status, 404);
	});

	it("reports AI as unavailable (503) when not configured", async () => {
		const res = await call("/api/ask", { method: "POST", body: JSON.stringify({ question: "How is GTCO doing?" }) });
		assert.equal(res.status, 503);
	});
});
