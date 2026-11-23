/**
 * Minimal router. Routes are private by default: a route must opt in to
 * `access: "public"` to be reachable without signing in.
 */
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";
import type { RequestContext } from "./http.js";
import type { Limiter } from "./rateLimit.js";

export type Access = "public" | "user" | "admin";
export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteOptions {
	access?: Access;
	/** Rate limit, keyed by client IP (or by whatever `key` returns). */
	limit?: Limiter;
	limitKey?: (ctx: RequestContext) => string;
	/** Skip the same-origin check (only for server-to-server callbacks that verify a signature). */
	csrf?: boolean;
}

interface Route extends RouteOptions {
	method: Method;
	pattern: RegExp;
	keys: string[];
	handler: Handler;
}

export class Router {
	private readonly routes: Route[] = [];

	private add(method: Method, path: string, handler: Handler, options: RouteOptions = {}) {
		const keys: string[] = [];
		const pattern = new RegExp(
			`^${path.replace(/:(\w+)/g, (_, k) => {
				keys.push(k);
				return "([^/]+)";
			})}$`,
		);
		this.routes.push({ method, pattern, keys, handler, ...options });
	}

	get = (path: string, handler: Handler, options?: RouteOptions) => this.add("GET", path, handler, options);
	post = (path: string, handler: Handler, options?: RouteOptions) => this.add("POST", path, handler, options);
	put = (path: string, handler: Handler, options?: RouteOptions) => this.add("PUT", path, handler, options);
	patch = (path: string, handler: Handler, options?: RouteOptions) => this.add("PATCH", path, handler, options);
	delete = (path: string, handler: Handler, options?: RouteOptions) => this.add("DELETE", path, handler, options);

	/** Find the route for a request; `methodNotAllowed` when the path exists under another method. */
	match(
		method: string,
		pathname: string,
	): { route: Route; params: Record<string, string> } | "methodNotAllowed" | null {
		let pathExists = false;
		for (const route of this.routes) {
			const m = route.pattern.exec(pathname);
			if (!m) continue;
			pathExists = true;
			if (route.method !== method) continue;
			const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? "")]));
			return { route, params };
		}
		return pathExists ? "methodNotAllowed" : null;
	}
}

export function authorize(route: RouteOptions, ctx: RequestContext) {
	const access = route.access ?? "user";
	if (access === "public") return;
	if (!ctx.principal) throw new UnauthorizedError();
	if (access === "admin" && ctx.principal.user.role !== "admin") throw new ForbiddenError("Admins only.");
}
