/** System status, AI, billing and admin routes. */
import { z } from "zod";
import { SCREEN_SORTS } from "../../analysis/market.js";
import type { App } from "../../app.js";
import { ConflictError, UnauthorizedError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { rateLimiter } from "../../lib/rateLimit.js";
import { CURRENCY, EXCHANGES, type Exchange, MARKET_NAMES } from "../../markets/types.js";
import { ALERT_CONDITIONS } from "../../services/alertService.js";
import { VERSION } from "../../version.js";
import type { Router } from "../router.js";
import { exchangeSchema } from "./shared.js";

export function platformRoutes(r: Router, app: App) {
	const heavy = rateLimiter(20, 60_000);
	let syncing: Promise<unknown> | null = null;

	// -- System --------------------------------------------------------------------------
	const startedAt = Date.now();
	// Liveness + readiness: fails (500) if the database can't be queried.
	r.get(
		"/api/health",
		async () => {
			await app.db.ping();
			return { status: "ok", version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
		},
		{ access: "public" },
	);
	r.get("/api/status", async () => ({
		version: VERSION,
		mode: app.config.mode,
		features: {
			ai: app.ai ? { provider: app.ai.name, chatModel: app.ai.chatModel } : null,
			search: app.kb.enabled,
			billing: app.billing.enabled,
		},
		data: { lastPriceDate: (await app.db.stats()).lastPriceDate },
		markets: EXCHANGES.map((id) => ({ id, name: MARKET_NAMES[id], currency: CURRENCY[id] })),
		alertConditions: ALERT_CONDITIONS,
		screenSorts: SCREEN_SORTS,
	}));

	// -- AI ---------------------------------------------------------------------------------
	r.post(
		"/api/ask",
		async (ctx) => {
			const b = z
				.object({ question: z.string().trim().min(3).max(1000), exchange: z.string().optional() })
				.parse(ctx.body);
			const refund = await app.accounts.meterAiQuestion(ctx.user);
			try {
				return await app.insights.ask(b.question, {
					exchange: b.exchange ? exchangeSchema.parse(b.exchange) : undefined,
				});
			} catch (err) {
				await refund().catch(() => undefined); // don't charge a question for our own failure
				throw err;
			}
		},
		{ limit: heavy, limitKey: (ctx) => `user:${ctx.principal?.user.id}` },
	);
	r.get("/api/search", (ctx) => app.kb.search(z.string().min(2).parse(ctx.query.get("q")), { limit: 10 }), {
		limit: heavy,
		limitKey: (ctx) => `user:${ctx.principal?.user.id}`,
	});

	// -- Billing ----------------------------------------------------------------------------
	r.post("/api/billing/checkout", async (ctx) => ({ url: await app.billing.checkout(ctx.user) }));
	r.post("/api/billing/portal", async (ctx) => ({ url: await app.billing.manageUrl(ctx.user) }));
	r.post(
		"/api/billing/webhook",
		async (ctx) => {
			const signature = ctx.req.headers["x-paystack-signature"];
			if (!app.billing.verifySignature(ctx.rawBody, typeof signature === "string" ? signature : undefined)) {
				throw new UnauthorizedError("Invalid signature");
			}
			const result = await app.billing.handleEvent(ctx.body as Parameters<App["billing"]["handleEvent"]>[0]);
			if (result) logger.info("billing updated", result);
			return { received: true };
		},
		{ access: "public", csrf: false },
	);

	// -- Admin ------------------------------------------------------------------------------
	r.post(
		"/api/admin/sync",
		async (ctx) => {
			if (syncing) throw new ConflictError("A sync is already running.");
			const b = z.object({ exchange: z.string().default("all") }).parse(ctx.body ?? {});
			const exchanges: Exchange[] =
				b.exchange.toLowerCase() === "all" ? [...EXCHANGES] : [exchangeSchema.parse(b.exchange)];
			syncing = app.syncAndAlert(exchanges);
			try {
				const result = (await syncing) as Awaited<ReturnType<App["syncAndAlert"]>>;
				// Per-user alert details stay private; admins just see counts.
				return { results: result.results, errors: result.errors, triggered: result.triggered.length };
			} finally {
				syncing = null;
			}
		},
		{ access: "admin", limit: heavy },
	);
	r.get(
		"/api/admin/overview",
		async () => {
			const users = await app.db.users.list();
			return {
				stats: await app.db.stats(),
				users: {
					total: users.length,
					pro: users.filter((u) => u.plan === "pro").length,
					verified: users.filter((u) => u.emailVerifiedAt).length,
				},
			};
		},
		{ access: "admin" },
	);
}
