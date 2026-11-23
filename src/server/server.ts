/**
 * Web app + REST API on Node's built-in HTTP server.
 *
 * Security model:
 * - Browsers authenticate with an HttpOnly, SameSite=Lax session cookie;
 *   scripts and the CLI use personal API tokens (`Authorization: Bearer nvp_…`).
 * - Every state-changing request authenticated by cookie (and every public
 *   form post) must come from the same origin — a CSRF defence on top of SameSite.
 * - Routes are private unless they opt in to `access: "public"`.
 */
import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { z } from "zod";
import type { App } from "../app.js";
import { AppError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { errorMessage, logger } from "../lib/logger.js";
import { onShutdown } from "../lib/shutdown.js";
import {
	type Principal,
	SESSION_COOKIE,
	clientIp,
	createContext,
	parseCookies,
	parseJson,
	readBody,
	redirect,
	requestHost,
	sendJson,
} from "./http.js";
import { Router, authorize } from "./router.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { integrationRoutes } from "./routes/integrations.js";
import { marketRoutes } from "./routes/market.js";
import { platformRoutes } from "./routes/platform.js";
import { StaticSite } from "./static.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PAGE_CSP =
	"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'";

export function createRequestHandler(app: App) {
	const router = new Router();
	authRoutes(router, app);
	accountRoutes(router, app);
	marketRoutes(router, app);
	platformRoutes(router, app);
	integrationRoutes(router, app);
	const site = new StaticSite();
	const { trustProxy } = app.config.server;
	const appOrigin = new URL(app.config.appUrl).host;

	const resolvePrincipal = (req: IncomingMessage, cookieToken: string | null): Principal | null => {
		const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
		if (bearer) {
			const user = app.auth.authenticateApiToken(bearer);
			return user ? { user, sessionId: null, via: "token" } : null;
		}
		if (cookieToken) {
			const found = app.auth.authenticateSession(cookieToken);
			return found ? { user: found.user, sessionId: found.sessionId, via: "session" } : null;
		}
		return null;
	};

	/** Browsers always send Origin on cross-site POSTs; reject any that isn't us. */
	const assertSameOrigin = (req: IncomingMessage) => {
		const source = req.headers.origin ?? req.headers.referer;
		let host: string | undefined;
		try {
			host = source ? new URL(source).host : undefined;
		} catch {
			host = undefined;
		}
		if (!host || (host !== requestHost(req, trustProxy) && host !== appOrigin)) {
			throw new ForbiddenError("Cross-origin request blocked.");
		}
	};

	return async (req: IncomingMessage, res: ServerResponse) => {
		const started = Date.now();
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";
		// Correlates a client report or proxy log line with our logs.
		const incoming = req.headers["x-request-id"];
		const requestId = typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
		res.setHeader("X-Request-Id", requestId);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
		if (app.config.auth.secureCookies)
			res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

		try {
			const cookieToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
			const principal = resolvePrincipal(req, cookieToken);

			if (!url.pathname.startsWith("/api/")) {
				if (method !== "GET" && method !== "HEAD") throw new NotFoundError();
				const result = site.resolve(url.pathname, url.search, principal?.user ?? null, {
					needsOwner: app.db.users.count() === 0,
				});
				if (!result) throw new NotFoundError();
				if ("redirect" in result) return redirect(res, result.redirect);
				res.setHeader("Content-Security-Policy", PAGE_CSP);
				res.writeHead(200, { "Content-Type": result.asset.type, "Cache-Control": result.asset.cache });
				res.end(method === "HEAD" ? undefined : result.asset.data);
				return;
			}

			const match = router.match(method, url.pathname);
			if (match === "methodNotAllowed")
				throw new AppError(`${method} is not supported here`, 405, "method_not_allowed");
			if (!match) throw new NotFoundError(`No route for ${method} ${url.pathname}`);
			const { route, params } = match;

			if (!SAFE_METHODS.has(method) && route.csrf !== false && principal?.via !== "token") assertSameOrigin(req);

			const rawBody = SAFE_METHODS.has(method) ? Buffer.alloc(0) : await readBody(req);
			const ctx = createContext({
				req,
				res,
				url,
				params,
				query: url.searchParams,
				rawBody,
				body: rawBody.length ? parseJson(rawBody) : {},
				ip: clientIp(req, trustProxy),
				principal,
				sessionToken: cookieToken,
			});
			authorize(route, ctx);
			route.limit?.(route.limitKey?.(ctx) ?? ctx.ip);
			const result = await route.handler(ctx);
			sendJson(res, 200, result ?? null);
		} catch (err) {
			const { status, code, message } = toProblem(err, app.config.env === "production");
			if (status >= 500 && status !== 503) {
				logger.error("request failed", { requestId, method, path: url.pathname, error: errorMessage(err) });
			}
			sendJson(res, status, { error: message, code });
		} finally {
			if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
				logger.debug(`${method} ${url.pathname}`, { status: res.statusCode, ms: Date.now() - started });
			}
		}
	};
}

function toProblem(err: unknown, production: boolean): { status: number; code: string; message: string } {
	if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message };
	if (err instanceof z.ZodError) {
		return {
			status: 400,
			code: "invalid_input",
			message: err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "),
		};
	}
	return {
		status: 500,
		code: "internal",
		message: production ? "Something went wrong on our side." : errorMessage(err),
	};
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
	logger.info(`nVestPadi (${app.config.mode}) listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
	if (app.db.users.count() === 0)
		logger.info(`no accounts yet — create the owner account at ${app.config.appUrl}/signup`);
	onShutdown(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeIdleConnections();
			}),
	);
	return server;
}
