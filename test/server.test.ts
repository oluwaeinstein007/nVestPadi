import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { type App, createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { hmacSha512Hex } from "../src/lib/crypto.js";
import { createRequestHandler } from "../src/server/server.js";
import { TestMailer, dropTestDatabases, security, seed, testEnv } from "./helpers.js";

const PAYSTACK_SECRET = "sk_test_secret";

describe("HTTP API (cloud mode)", () => {
	const mailer = new TestMailer();
	let app: App;
	let server: Server;
	let base = "";

	interface CallOptions {
		method?: string;
		body?: unknown;
		cookie?: string;
		token?: string;
		/** Origin header; defaults to the server's own origin. Pass null to omit it. */
		origin?: string | null;
		headers?: Record<string, string>;
	}
	const call = (path: string, o: CallOptions = {}) =>
		fetch(`${base}${path}`, {
			method: o.method ?? (o.body === undefined ? "GET" : "POST"),
			redirect: "manual",
			headers: {
				...(o.body === undefined ? {} : { "Content-Type": "application/json" }),
				...(o.cookie ? { Cookie: o.cookie } : {}),
				...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
				...(o.origin === null ? {} : { Origin: o.origin ?? base }),
				...o.headers,
			},
			body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
		});
	const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
	const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

	let owner = "";
	let member = "";

	before(async () => {
		app = await createApp(
			parseConfig(
				await testEnv({
					APP_MODE: "cloud",
					PAYSTACK_SECRET_KEY: PAYSTACK_SECRET,
					PAYSTACK_PLAN_CODE: "PLN_pro",
				}),
			),
			{ mailer },
		);
		await seed(app.db, [
			{
				s: security("GTCO", "Guaranty Trust", "Financial Services"),
				closes: Array.from({ length: 70 }, (_, i) => 100 + i),
			},
			{
				s: security("ZENITHBANK", "Zenith Bank", "Financial Services"),
				closes: Array.from({ length: 70 }, (_, i) => 50 - i / 2),
			},
		]);
		server = createServer(createRequestHandler(app));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	after(async () => {
		server.close();
		await app.close();
		await dropTestDatabases();
	});

	it("keeps health public and everything else behind sign-in", async () => {
		assert.equal((await call("/api/health")).status, 200);
		const res = await call("/api/market");
		assert.equal(res.status, 401);
		assert.equal((await json(res)).code, "unauthorized");
		const session = await json<{ user: null; signup: { open: boolean; needsOwner: boolean }; plans: unknown[] }>(
			await call("/api/auth/session"),
		);
		assert.equal(session.user, null);
		assert.deepEqual(session.signup, { open: true, needsOwner: true });
		assert.equal(session.plans.length, 2);
	});

	it("serves public pages and guards app pages", async () => {
		const landing = await call("/");
		assert.equal(landing.status, 200);
		assert.match(await landing.text(), /Start free/);
		assert.match(landing.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		assert.equal((await call("/terms")).status, 200);
		assert.equal((await call("/robots.txt")).status, 200);
		assert.equal((await call("/img/dashboard-dark.webp")).headers.get("content-type"), "image/webp");

		const appPage = await call("/app");
		assert.equal(appPage.status, 302);
		assert.equal(appPage.headers.get("location"), "/login?next=%2Fapp");
		assert.equal((await call("/login")).headers.get("location"), "/signup", "no accounts yet → create the owner");
		assert.equal((await call("/app.html")).status, 404, "HTML is only reachable through page routes");
		assert.equal((await call("/../package.json")).status, 404);
	});

	it("blocks cross-origin and origin-less form posts (CSRF)", async () => {
		const body = { name: "Mallory", email: "m@example.com", password: "s3cret-pass", acceptTerms: true };
		assert.equal((await call("/api/auth/signup", { body, origin: "https://evil.example" })).status, 403);
		assert.equal((await call("/api/auth/signup", { body, origin: null })).status, 403);
	});

	it("signs up the owner with an HttpOnly session cookie and requires accepting the terms", async () => {
		const noTerms = await call("/api/auth/signup", {
			body: { name: "Ada", email: "ada@example.com", password: "s3cret-pass" },
		});
		assert.equal(noTerms.status, 400);

		const res = await call("/api/auth/signup", {
			body: { name: "Ada Owner", email: "ada@example.com", password: "s3cret-pass", acceptTerms: true },
		});
		assert.equal(res.status, 200);
		const setCookie = res.headers.get("set-cookie") ?? "";
		assert.match(setCookie, /^nvp_session=/);
		assert.match(setCookie, /HttpOnly/);
		assert.match(setCookie, /SameSite=Lax/);
		owner = cookieOf(res);
		const { user } = await json<{ user: { role: string; emailVerified: boolean } }>(res);
		assert.equal(user.role, "admin");
		assert.equal(user.emailVerified, false);
		assert.match(mailer.sent.at(-1)?.subject ?? "", /Confirm your email/);
	});

	it("routes new users through onboarding before the dashboard", async () => {
		assert.equal((await call("/app", { cookie: owner })).headers.get("location"), "/welcome");
		assert.equal((await call("/login", { cookie: owner })).headers.get("location"), "/welcome");
		const done = await call("/api/account/onboarding", {
			cookie: owner,
			body: { defaultExchange: "NGX", symbols: ["GTCO", "NGX:ZENITHBANK"] },
		});
		assert.deepEqual((await json<{ added: string[] }>(done)).added, ["NGX:GTCO", "NGX:ZENITHBANK"]);
		assert.equal((await call("/app", { cookie: owner })).status, 200);
		assert.equal((await call("/app/settings", { cookie: owner })).status, 200);
	});

	it("serves market data and per-user watchlists", async () => {
		const market = await json<{ count: number; gainers: { symbol: string }[] }>(
			await call("/api/market?exchange=ngx", { cookie: owner }),
		);
		assert.equal(market.count, 2);
		assert.equal(market.gainers[0]?.symbol, "GTCO");
		const list = await json<{ symbol: string; spark: number[] }[]>(await call("/api/watchlist", { cookie: owner }));
		assert.deepEqual(
			list.map((w) => w.symbol),
			["GTCO", "ZENITHBANK"],
		);
		const detail = await json<{ watched: boolean }>(await call("/api/securities/NGX/GTCO", { cookie: owner }));
		assert.equal(detail.watched, true);
		const snapshot = await json<{ count: number; gainers: unknown[] }>(await call("/api/public/snapshot"));
		assert.equal(snapshot.count, 2);
	});

	it("validates input with 400s", async () => {
		assert.equal((await call("/api/market?exchange=LSE", { cookie: owner })).status, 400);
		const bad = await call("/api/alerts", { cookie: owner, body: { symbol: "GTCO", condition: "nope", threshold: 1 } });
		assert.equal(bad.status, 400);
		assert.equal((await call("/api/alerts", { cookie: owner, body: "{oops" })).status, 400);
		assert.equal((await call("/api/market", { cookie: owner, method: "DELETE" })).status, 405);
	});

	it("enforces Free plan limits with 402 plan_limit", async () => {
		for (let i = 0; i < 3; i++) {
			const res = await call("/api/alerts", {
				cookie: owner,
				body: { symbol: "gtco", condition: "above", threshold: 200 + i },
			});
			assert.equal(res.status, 200);
		}
		const over = await call("/api/alerts", {
			cookie: owner,
			body: { symbol: "gtco", condition: "above", threshold: 999 },
		});
		assert.equal(over.status, 402);
		assert.equal((await json(over)).code, "plan_limit");
		const account = await json<{ usage: { activeAlerts: number }; limits: { activeAlerts: number } }>(
			await call("/api/account", { cookie: owner }),
		);
		assert.deepEqual([account.usage.activeAlerts, account.limits.activeAlerts], [3, 3]);
	});

	it("refunds the AI quota when AI isn't configured (503)", async () => {
		const res = await call("/api/ask", { cookie: owner, body: { question: "How is GTCO doing?" } });
		assert.equal(res.status, 503);
		const account = await json<{ usage: { aiQuestionsToday: number } }>(await call("/api/account", { cookie: owner }));
		assert.equal(account.usage.aiQuestionsToday, 0);
	});

	it("accepts personal API tokens without an Origin header", async () => {
		const created = await json<{ token: string }>(
			await call("/api/account/tokens", { cookie: owner, body: { name: "script" } }),
		);
		const res = await call("/api/watchlist/NGX/ZENITHBANK", { token: created.token, method: "DELETE", origin: null });
		assert.equal(res.status, 200);
		assert.equal((await call("/api/account", { token: "nvp_wrong" })).status, 401);
	});

	it("keeps admin routes for admins and data private between users", async () => {
		const res = await call("/api/auth/signup", {
			body: { name: "Bo Member", email: "bo@example.com", password: "s3cret-pass", acceptTerms: true },
		});
		member = cookieOf(res);
		assert.equal((await call("/api/admin/sync", { cookie: member, body: {} })).status, 403);
		assert.equal((await call("/api/admin/overview", { cookie: owner })).status, 200);
		const theirs = await json<unknown[]>(await call("/api/alerts", { cookie: member }));
		assert.equal(theirs.length, 0);
		const ownerAlert = (await json<{ id: number }[]>(await call("/api/alerts", { cookie: owner })))[0];
		assert.equal((await call(`/api/alerts/${ownerAlert?.id}`, { cookie: member, method: "DELETE" })).status, 404);
	});

	it("upgrades a plan from a signed Paystack webhook only", async () => {
		const event = JSON.stringify({
			event: "subscription.create",
			data: {
				customer: { email: "bo@example.com", customer_code: "CUS_1" },
				plan: { plan_code: "PLN_pro" },
				subscription_code: "SUB_1",
				next_payment_date: "2099-01-01T00:00:00.000Z",
			},
		});
		const unsigned = await call("/api/billing/webhook", {
			body: event,
			origin: null,
			headers: { "x-paystack-signature": "bad" },
		});
		assert.equal(unsigned.status, 401);
		const signed = await call("/api/billing/webhook", {
			body: event,
			origin: null,
			headers: { "x-paystack-signature": hmacSha512Hex(PAYSTACK_SECRET, event) },
		});
		assert.equal(signed.status, 200);
		const account = await json<{ plan: { id: string; managed: boolean }; limits: { activeAlerts: number } }>(
			await call("/api/account", { cookie: member }),
		);
		assert.equal(account.plan.id, "pro");
		assert.equal(account.plan.managed, true);
		assert.equal(account.limits.activeAlerts, 50);

		const cancel = JSON.stringify({ event: "subscription.disable", data: { subscription_code: "SUB_1" } });
		await call("/api/billing/webhook", {
			body: cancel,
			origin: null,
			headers: { "x-paystack-signature": hmacSha512Hex(PAYSTACK_SECRET, cancel) },
		});
		assert.equal((await app.db.users.byEmail("bo@example.com"))?.plan, "free");
	});

	it("signs in and out", async () => {
		const wrong = await call("/api/auth/login", { body: { email: "bo@example.com", password: "nope-nope" } });
		assert.equal(wrong.status, 401);
		const ok = await call("/api/auth/login", { body: { email: "BO@example.com", password: "s3cret-pass" } });
		const cookie = cookieOf(ok);
		assert.equal((await call("/api/account", { cookie })).status, 200);
		const out = await call("/api/auth/logout", { cookie, body: {} });
		assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
		assert.equal((await call("/api/account", { cookie })).status, 401);
	});
});
