import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { PLANS } from "../src/services/plans.js";

const PUBLIC = path.resolve("public");
const read = (file: string) => readFileSync(path.join(PUBLIC, file), "utf8");

describe("static site", () => {
	it("prices on the landing page match the plan definitions", () => {
		const html = read("index.html");
		for (const plan of Object.values(PLANS)) {
			assert.ok(html.includes(`${plan.limits.watchlist} watchlist stocks`), `${plan.id} watchlist`);
			assert.ok(html.includes(`${plan.limits.activeAlerts} active alerts`), `${plan.id} alerts`);
			assert.ok(html.includes(`${plan.limits.holdings} portfolio positions`), `${plan.id} holdings`);
			assert.ok(html.includes(`${plan.limits.aiQuestionsPerDay} AI questions a day`), `${plan.id} AI`);
		}
		assert.ok(html.includes(PLANS.pro.priceLabel.split("/")[0] as string), "Pro price");
	});

	it("every local script, stylesheet and module import resolves to a file", () => {
		const files = readdirSync(PUBLIC, { recursive: true }) as string[];
		for (const file of files.filter((f) => f.endsWith(".html"))) {
			for (const [, ref] of read(file).matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css|svg|webp))"/g)) {
				assert.ok(existsSync(path.join(PUBLIC, ref as string)), `${file} → ${ref}`);
			}
		}
		for (const file of files.filter((f) => f.endsWith(".js"))) {
			for (const [, ref] of read(file).matchAll(/from "(\.[^"]+)"/g)) {
				assert.ok(existsSync(path.join(PUBLIC, path.dirname(file), ref as string)), `${file} → ${ref}`);
			}
		}
	});
});
