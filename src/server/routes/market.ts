/** Market data, screener, security detail, watchlist and alerts. */
import { z } from "zod";
import { costsFor, roundTripPct } from "../../analysis/costs.js";
import { callConfidence, signalIdeas, signalSummary } from "../../analysis/ideas.js";
import { SCREEN_SORTS, marketOverview, screen } from "../../analysis/market.js";
import { MIN_TRADES, SIGNAL_DEFAULTS } from "../../analysis/signals.js";
import type { App } from "../../app.js";
import { NotFoundError } from "../../lib/errors.js";
import { rateLimiter } from "../../lib/rateLimit.js";
import { EXCHANGES, type Exchange } from "../../markets/types.js";
import { ALERT_CONDITIONS } from "../../services/alertService.js";
import type { Router } from "../router.js";
import { exchangeSchema, optionalNumber, queryObject } from "./shared.js";

const SNAPSHOT_TTL_MS = 5 * 60_000;

export function marketRoutes(r: Router, app: App) {
	const resolveTarget = (symbol: string, exchange?: string) =>
		app.market.resolve(symbol, exchange ? exchangeSchema.parse(exchange) : undefined);

	// -- Public teaser for the landing page (cached, no per-user data) -------------
	const snapshots = new Map<Exchange, { at: number; data: unknown }>();
	r.get(
		"/api/public/snapshot",
		async (ctx) => {
			const exchange = exchangeSchema.parse(ctx.query.get("exchange") ?? "NGX");
			const cached = snapshots.get(exchange);
			if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;
			const o = await marketOverview(app.db, exchange, 5);
			const slim = (list: typeof o.gainers) =>
				list.map((q) => ({ symbol: q.symbol, name: q.name, close: q.close, changePct: q.changePct }));
			const data = {
				exchange,
				date: o.date,
				count: o.count,
				advancers: o.advancers,
				decliners: o.decliners,
				unchanged: o.unchanged,
				gainers: slim(o.gainers),
				losers: slim(o.losers),
			};
			snapshots.set(exchange, { at: Date.now(), data });
			return data;
		},
		{ access: "public", limit: rateLimiter(60, 60_000) },
	);

	// -- Public live track record: every logged signal and how it played out ---------------
	const records = new Map<string, { at: number; data: unknown }>();
	r.get(
		"/api/public/track-record",
		async (ctx) => {
			const ex = ctx.query.get("exchange");
			const exchange = ex ? exchangeSchema.parse(ex) : undefined;
			const key = exchange ?? "all";
			const cached = records.get(key);
			if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;
			const report = await app.ledger.report({ exchange, recent: 200 });
			const data = {
				...report,
				// Levels of signals still in play stay in the app; finished ones are shown in full.
				recent: report.recent.map((s) =>
					s.status === "closed" ? s : { ...s, stop: null, target: null, refPrice: null },
				),
				costs: Object.fromEntries(
					EXCHANGES.map((e) => [e, { ...costsFor(e), roundTripPct: Number(roundTripPct(costsFor(e)).toFixed(2)) }]),
				),
				rules: { ...SIGNAL_DEFAULTS, minTrades: MIN_TRADES },
			};
			records.set(key, { at: Date.now(), data });
			return data;
		},
		{ access: "public", limit: rateLimiter(60, 60_000) },
	);

	// -- Market ----------------------------------------------------------------------
	r.get("/api/market", ({ query }) =>
		marketOverview(
			app.db,
			exchangeSchema.parse(query.get("exchange") ?? "NGX"),
			Math.min(50, Number(query.get("top")) || 8),
		),
	);

	r.get("/api/screen", ({ query }) => {
		const q = z
			.object({
				exchange: exchangeSchema.default("NGX"),
				sector: z.string().optional(),
				search: z.string().optional(),
				sort: z.enum(SCREEN_SORTS).default("gainers"),
				minPrice: optionalNumber,
				maxPrice: optionalNumber,
				rsiBelow: optionalNumber,
				rsiAbove: optionalNumber,
				limit: z.coerce.number().int().min(1).max(500).default(100),
			})
			.parse(queryObject(query));
		return screen(app.db, { ...q, query: q.search });
	});

	r.get("/api/securities", ({ query }) => {
		const ex = query.get("exchange");
		return app.db.market.searchSecurities(query.get("q") ?? "", ex ? exchangeSchema.parse(ex) : undefined, 12);
	});

	r.get("/api/securities/:exchange/:symbol", async (ctx) => {
		const exchange = exchangeSchema.parse(ctx.params.exchange);
		const report = await app.market.report(ctx.params.symbol as string, exchange);
		const [history, watched, confidence] = await Promise.all([
			app.db.market.history(exchange, report.security.symbol, 730),
			app.watchlists.has(ctx.user, exchange, report.security.symbol),
			report.call ? callConfidence(app.db, exchange, report.call) : null,
		]);
		return { report, history, watched, confidence };
	});

	// Latest price plus today's intraday candles where the source has them.
	r.get(
		"/api/securities/:exchange/:symbol/live",
		(ctx) => app.live.quote(exchangeSchema.parse(ctx.params.exchange), ctx.params.symbol as string),
		{ limit: rateLimiter(240, 60_000) },
	);

	// -- Signals: what to look at buying or selling now, with each idea's track record --
	r.get("/api/signals", async ({ query }) => {
		const q = z
			.object({
				exchange: exchangeSchema.default("NGX"),
				side: z.enum(["BUY", "SELL"]).optional(),
				minWinRate: optionalNumber,
				limit: z.coerce.number().int().min(1).max(200).default(50),
			})
			.parse(queryObject(query));
		return {
			ideas: await signalIdeas(app.db, q.exchange, q),
			market: await signalSummary(app.db, q.exchange),
			rules: {
				...SIGNAL_DEFAULTS,
				minTrades: MIN_TRADES,
				costPct: Number(roundTripPct(costsFor(q.exchange)).toFixed(2)),
			},
		};
	});

	// -- Position sizing: how much to buy for the risk the user accepts -----------------
	r.get("/api/sizing", ({ query }) => {
		const q = z
			.object({
				symbol: z.string().min(1).max(24),
				exchange: exchangeSchema.optional(),
				capital: z.coerce.number().positive("Capital must be greater than 0."),
				riskPct: optionalNumber,
				maxPositionPct: optionalNumber,
				entry: optionalNumber,
				stop: optionalNumber,
				target: optionalNumber,
			})
			.parse(queryObject(query));
		return app.sizing.size(q);
	});

	// -- Watchlist ---------------------------------------------------------------------
	r.get("/api/watchlist", (ctx) => app.watchlists.list(ctx.user));
	r.post("/api/watchlist", async (ctx) => {
		const b = z.object({ symbol: z.string().min(1).max(24), exchange: z.string().optional() }).parse(ctx.body);
		await app.watchlists.add(ctx.user, b.symbol, b.exchange ? exchangeSchema.parse(b.exchange) : undefined);
		return app.watchlists.list(ctx.user);
	});
	r.delete("/api/watchlist/:exchange/:symbol", async (ctx) => {
		await app.watchlists.remove(ctx.user, ctx.params.symbol as string, exchangeSchema.parse(ctx.params.exchange));
		return app.watchlists.list(ctx.user);
	});

	// -- Portfolio ---------------------------------------------------------------------
	const holdingSchema = z.object({
		quantity: z.coerce.number().positive("Quantity must be greater than 0."),
		avgCost: z.coerce.number().min(0, "Cost per unit can't be negative."),
		note: z.string().max(200).optional(),
	});
	r.get("/api/portfolio", (ctx) => app.portfolio.get(ctx.user));
	r.post("/api/portfolio", async (ctx) => {
		const b = holdingSchema
			.extend({ symbol: z.string().min(1).max(24), exchange: z.string().optional() })
			.parse(ctx.body);
		await app.portfolio.add(ctx.user, { ...b, exchange: b.exchange ? exchangeSchema.parse(b.exchange) : undefined });
		return app.portfolio.get(ctx.user);
	});
	r.put("/api/portfolio/:id", async (ctx) => {
		await app.portfolio.update(ctx.user, Number(ctx.params.id), holdingSchema.parse(ctx.body));
		return app.portfolio.get(ctx.user);
	});
	r.delete("/api/portfolio/:id", async (ctx) => {
		await app.portfolio.remove(ctx.user, Number(ctx.params.id));
		return app.portfolio.get(ctx.user);
	});

	// -- Alerts ------------------------------------------------------------------------
	r.get("/api/alerts", (ctx) => app.alerts.list(ctx.user));
	r.post("/api/alerts", async (ctx) => {
		const b = z
			.object({
				symbol: z.string().min(1).max(24),
				exchange: z.string().optional(),
				condition: z.enum(Object.keys(ALERT_CONDITIONS) as [keyof typeof ALERT_CONDITIONS]),
				threshold: z.coerce.number().finite(),
				note: z.string().max(200).optional(),
			})
			.parse(ctx.body);
		const t = await resolveTarget(b.symbol, b.exchange);
		return app.alerts.add(ctx.user, { ...t, condition: b.condition, threshold: b.threshold, note: b.note });
	});
	r.post("/api/alerts/:id/rearm", (ctx) => app.alerts.rearm(ctx.user, Number(ctx.params.id)));
	r.delete("/api/alerts/:id", async (ctx) => {
		if (!(await app.alerts.remove(ctx.user, Number(ctx.params.id)))) throw new NotFoundError("Alert not found");
		return { removed: Number(ctx.params.id) };
	});
}
