/** Low-level HTTP helpers: request context, body reading, JSON responses and cookies. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, UnauthorizedError } from "../lib/errors.js";
import type { User } from "../storage/repositories/users.js";

export const MAX_BODY_BYTES = 64 * 1024;
export const SESSION_COOKIE = "nvp_session";

export interface Principal {
	user: User;
	/** Hash of the session cookie, when signed in through the browser. */
	sessionId: string | null;
	via: "session" | "token";
}

export interface RequestContext {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
	params: Record<string, string>;
	query: URLSearchParams;
	body: unknown;
	rawBody: Buffer;
	ip: string;
	/** The signed-in principal, if any. */
	principal: Principal | null;
	/** The signed-in user; throws 401 on public routes when nobody is signed in. */
	readonly user: User;
	/** Raw session token from the cookie (for sign-out). */
	sessionToken: string | null;
}

export function createContext(init: Omit<RequestContext, "user">): RequestContext {
	return {
		...init,
		get user(): User {
			if (!this.principal) throw new UnauthorizedError();
			return this.principal.user;
		},
	};
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new AppError("Request body too large", 413, "too_large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

export function parseJson(raw: Buffer): unknown {
	const text = raw.toString("utf8");
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new AppError("Request body must be valid JSON", 400, "invalid_json");
	}
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
	if (res.headersSent) return;
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(data));
}

export function redirect(res: ServerResponse, location: string) {
	res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
	res.end();
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header?.split(";") ?? []) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		const key = part.slice(0, i).trim();
		try {
			out[key] = decodeURIComponent(part.slice(i + 1).trim());
		} catch {
			/* ignore malformed cookie */
		}
	}
	return out;
}

export function sessionCookie(token: string | null, options: { secure: boolean; maxAgeSeconds: number }): string {
	return [
		`${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ""}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${token ? options.maxAgeSeconds : 0}`,
		...(options.secure ? ["Secure"] : []),
	].join("; ");
}

/** Client IP; honours X-Forwarded-For only when the server sits behind a trusted proxy. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
	if (trustProxy) {
		const forwarded = String(req.headers["x-forwarded-for"] ?? "")
			.split(",")[0]
			?.trim();
		if (forwarded) return forwarded;
	}
	return req.socket.remoteAddress ?? "unknown";
}

export function requestHost(req: IncomingMessage, trustProxy: boolean): string {
	return String((trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "");
}
