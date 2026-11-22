/**
 * REST API + static dashboard on Node's built-in HTTP server.
 *
 * Security: binds to 127.0.0.1 by default; when API_KEY is set every /api route
 * except /api/health requires `Authorization: Bearer <key>`. Expensive routes
 * (ask, sync, search) are rate-limited per client IP.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SCREEN_SORTS, marketOverview, screen } from "../analysis/market.js";
import type { App } from "../app.js";
import { errorMessage, logger } from "../lib/logger.js";
import { onShutdown } from "../lib/shutdown.js";
import { EXCHANGES, type Exchange } from "../markets/types.js";
import { ALERT_CONDITIONS } from "../services/alertService.js";
import { FeatureUnavailableError } from "../services/knowledgeBase.js";
import { SymbolNotFoundError } from "../services/marketService.js";

class HttpProblem extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

type Params = Record<string, string>;
type Handler = (ctx: { req: IncomingMessage; params: Params; query: URLSearchParams; body: unknown }) =>
	| Promise<unknown>
	| unknown;

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
};
const MAX_BODY = 64 * 1024;

const exchangeSchema = z
	.string()
	.transform((s) => s.toUpperCase())
	.pipe(z.enum(EXCHANGES));
const optionalNumber = z.coerce.number().finite().optional();

function rateLimiter(limit: number, windowMs: number) {
	const hits = new Map<string, number[]>();
	return (key: string) => {
		const now = Date.now();
		const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
		if (recent.length >= limit) throw new HttpProblem(429, "Too many requests — please slow down.");
		recent.push(now);
		hits.set(key, recent);
	};
}

export function createRequestHandler(app: App) {
	const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; limit?: (key: string) => void }[] =
		[];
	const route = (method: string, pathPattern: string, handler: Handler, limit?: (key: string) => void) => {
		const keys: string[] = [];
		const pattern = new RegExp(
			`^${pathPattern.replace(/:(\w+)/g, (_, k) => {
				keys.push(k);
				return "([^/]+)";
			})}$`,
		);
		routes.push({ method, pattern, keys, handler, limit });
	};

	const heavy = rateLimiter(20, 60_000);
	let syncing: Promise<unknown> | null = null;

	const resolveTarget = (symbol: string, exchange?: string) =>
		app.market.resolve(symbol, exchange ? exchangeSchema.parse(exchange) : undefined);

	// -- System ----------------------------------------------------------------
	route("GET", "/api/health", () => ({ status: "ok" }));
	route("GET", "/api/status", () => ({
		version: "2.0.0",
		features: {
			ai: app.ai ? { provider: app.ai.name, chatModel: app.ai.chatModel } : null,
			search: app.kb.enabled,
			notifications: app.notifier.channels,
		},
		data: app.db.stats(),
		alertConditions: ALERT_CONDITIONS,
		screenSorts: SCREEN_SORTS,
	}));

	// -- Market ----------------------------------------------------------------
	route("GET", "/api/market", ({ query }) =>
		marketOverview(
			app.db,
			exchangeSchema.parse(query.get("exchange") ?? "NGX"),
			Math.min(50, Number(query.get("top")) || 8),
		),
	);

	route("GET", "/api/screen", ({ query }) => {
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
			.parse(Object.fromEntries([...query.entries()].filter(([, v]) => v !== "")));
		return screen(app.db, { ...q, query: q.search });
	});

	route("GET", "/api/securities", ({ query }) => {
		const ex = query.get("exchange");
		return app.db.searchSecurities(query.get("q") ?? "", ex ? exchangeSchema.parse(ex) : undefined, 12);
	});

	route("GET", "/api/securities/:exchange/:symbol", async ({ params }) => {
		const exchange = exchangeSchema.parse(params.exchange);
		const report = await app.market.report(params.symbol as string, exchange);
		const history = app.db.history(exchange, report.security.symbol, 260);
		const watched = app.db.watchlist().some((w) => w.exchange === exchange && w.symbol === report.security.symbol);
		return { report, history, watched };
	});

	// -- Watchlist -------------------------------------------------------------
	const watchlistView = () =>
		app.db.watchlist().map((w) => ({
			...w,
			quote: app.db.latestQuote(w.exchange, w.symbol),
			spark: app.db.history(w.exchange, w.symbol, 30).map((b) => b.close),
		}));
	route("GET", "/api/watchlist", watchlistView);
	route("POST", "/api/watchlist", async ({ body }) => {
		const b = z.object({ symbol: z.string().min(1), exchange: z.string().optional() }).parse(body);
		await app.market.watch(b.symbol, b.exchange ? exchangeSchema.parse(b.exchange) : undefined);
		return watchlistView();
	});
	route("DELETE", "/api/watchlist/:exchange/:symbol", ({ params }) => {
		app.db.removeFromWatchlist(exchangeSchema.parse(params.exchange), params.symbol as string);
		return watchlistView();
	});

	// -- Alerts ----------------------------------------------------------------
	route("GET", "/api/alerts", () => app.alerts.list());
	route("POST", "/api/alerts", ({ body }) => {
		const b = z
			.object({
				symbol: z.string().min(1),
				exchange: z.string().optional(),
				condition: z.enum(Object.keys(ALERT_CONDITIONS) as [keyof typeof ALERT_CONDITIONS]),
				threshold: z.coerce.number().finite(),
				note: z.string().max(200).optional(),
			})
			.parse(body);
		const t = resolveTarget(b.symbol, b.exchange);
		return app.alerts.add({ ...t, condition: b.condition, threshold: b.threshold, note: b.note });
	});
	route("DELETE", "/api/alerts/:id", ({ params }) => {
		if (!app.alerts.remove(Number(params.id))) throw new HttpProblem(404, "Alert not found");
		return { removed: Number(params.id) };
	});

	// -- Sync / AI ---------------------------------------------------------------
	route(
		"POST",
		"/api/sync",
		async ({ body }) => {
			if (syncing) throw new HttpProblem(409, "A sync is already running.");
			const b = z.object({ exchange: z.string().default("all") }).parse(body ?? {});
			const exchanges: Exchange[] =
				b.exchange.toLowerCase() === "all" ? [...EXCHANGES] : [exchangeSchema.parse(b.exchange)];
			syncing = app.syncAndAlert(exchanges);
			try {
				return await syncing;
			} finally {
				syncing = null;
			}
		},
		heavy,
	);
	route(
		"POST",
		"/api/ask",
		({ body }) => {
			const b = z.object({ question: z.string().trim().min(3).max(1000), exchange: z.string().optional() }).parse(body);
			return app.insights.ask(b.question, { exchange: b.exchange ? exchangeSchema.parse(b.exchange) : undefined });
		},
		heavy,
	);
	route(
		"GET",
		"/api/search",
		({ query }) => app.kb.search(z.string().min(2).parse(query.get("q")), { limit: 10 }),
		heavy,
	);

	// -- Static dashboard --------------------------------------------------------
	const assets = new Map<string, { type: string; data: Buffer }>();
	try {
		for (const file of readdirSync(PUBLIC_DIR)) {
			const type = MIME[path.extname(file)];
			if (type) assets.set(`/${file}`, { type, data: readFileSync(path.join(PUBLIC_DIR, file)) });
		}
	} catch {
		logger.warn("dashboard assets not found; serving API only", { dir: PUBLIC_DIR });
	}

	const apiKey = app.config.server.apiKey ? Buffer.from(app.config.server.apiKey) : null;
	const authorized = (req: IncomingMessage) => {
		if (!apiKey) return true;
		const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? String(req.headers["x-api-key"] ?? "");
		const given = Buffer.from(header);
		return given.length === apiKey.length && timingSafeEqual(given, apiKey);
	};

	return async (req: IncomingMessage, res: ServerResponse) => {
		const started = Date.now();
		const url = new URL(req.url ?? "/", "http://localhost");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Frame-Options", "DENY");

		try {
			if (!url.pathname.startsWith("/api/")) {
				const asset = assets.get(url.pathname === "/" ? "/index.html" : url.pathname);
				if (!asset || req.method !== "GET") throw new HttpProblem(404, "Not found");
				res.setHeader(
					"Content-Security-Policy",
					"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
				);
				res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
				res.end(asset.data);
				return;
			}

			if (url.pathname !== "/api/health" && !authorized(req)) throw new HttpProblem(401, "Missing or invalid API key");

			const match = routes
				.map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
				.filter((x) => x.m)
				.find((x) => x.r.method === req.method);
			if (!match?.m) throw new HttpProblem(404, `No route for ${req.method} ${url.pathname}`);

			match.r.limit?.(req.socket.remoteAddress ?? "unknown");
			const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m?.[i + 1] ?? "")]));
			const body = req.method === "POST" ? await readJson(req) : undefined;
			const result = await match.r.handler({ req, params, query: url.searchParams, body });
			sendJson(res, 200, result ?? null);
		} catch (err) {
			const { status, message } = toProblem(err, app.config.env === "production");
			if (status === 500) logger.error("request failed", { path: url.pathname, error: errorMessage(err) });
			sendJson(res, status, { error: message });
		} finally {
			if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
				logger.debug(`${req.method} ${url.pathname}`, { status: res.statusCode, ms: Date.now() - started });
			}
		}
	};
}

function toProblem(err: unknown, production: boolean): { status: number; message: string } {
	if (err instanceof HttpProblem) return { status: err.status, message: err.message };
	if (err instanceof z.ZodError) {
		return { status: 400, message: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
	}
	if (err instanceof SymbolNotFoundError) return { status: 404, message: err.message };
	if (err instanceof FeatureUnavailableError) return { status: 503, message: err.message };
	if (err instanceof SyntaxError) return { status: 400, message: "Request body must be valid JSON" };
	return { status: 500, message: production ? "Internal server error" : errorMessage(err) };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpProblem(413, "Request body too large");
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
	if (res.headersSent) return;
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(data));
}

export async function startServer(app: App, options: { port?: number; host?: string } = {}) {
	const port = options.port ?? app.config.server.port;
	const host = options.host ?? app.config.server.host;
	const server = createServer(createRequestHandler(app));
	server.requestTimeout = 120_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	logger.info(`dashboard ready at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
	if (host !== "127.0.0.1" && host !== "localhost" && !app.config.server.apiKey) {
		logger.warn("server is reachable from the network without API_KEY — set API_KEY to protect it");
	}
	onShutdown(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeIdleConnections();
			}),
	);
	return server;
}
