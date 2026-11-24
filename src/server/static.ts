/**
 * Static site: landing, auth pages, the app and legal pages, plus their
 * assets. Files are read once from a fixed directory, so request paths can
 * never escape it. HTML is only reachable through PAGES, where each page
 * declares who may see it.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";
import type { User } from "../storage/repositories/users.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
};

/**
 * `guest`: signed-in users are sent to the app. `user`: visitors are sent to
 * sign in. `onboarded`: users who skipped onboarding are sent to /welcome.
 */
type Guard = "guest" | "user" | "onboarded";

const PAGES: Record<string, { file: string; guard?: Guard }> = {
	"/": { file: "index.html" },
	"/login": { file: "auth.html", guard: "guest" },
	"/signup": { file: "auth.html", guard: "guest" },
	"/forgot-password": { file: "auth.html" },
	"/reset-password": { file: "auth.html" },
	"/verify-email": { file: "auth.html" },
	"/welcome": { file: "welcome.html", guard: "user" },
	"/app": { file: "app.html", guard: "onboarded" },
	"/app/settings": { file: "settings.html", guard: "user" },
	"/track-record": { file: "track-record.html" },
	"/terms": { file: "terms.html" },
	"/privacy": { file: "privacy.html" },
};

export interface Asset {
	type: string;
	data: Buffer;
	cache: string;
}

export type PageResult = { asset: Asset } | { redirect: string } | null;

export class StaticSite {
	private readonly files = new Map<string, Asset>();

	constructor(dir = PUBLIC_DIR) {
		try {
			for (const file of readdirSync(dir, { recursive: true }) as string[]) {
				const type = MIME[path.extname(file)];
				if (!type) continue;
				const urlPath = `/${file.split(path.sep).join("/")}`;
				const cache = type.startsWith("image/") ? "public, max-age=86400" : "no-cache";
				this.files.set(urlPath, { type, data: readFileSync(path.join(dir, file)), cache });
			}
		} catch {
			logger.warn("web assets not found; serving API only", { dir });
		}
	}

	/** Resolve a GET for a non-API path. `user` is the signed-in user, if any. */
	resolve(pathname: string, search: string, user: User | null, options: { needsOwner: boolean }): PageResult {
		const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
		const page = PAGES[clean];
		if (page) {
			if (page.guard === "guest" && user) return { redirect: user.onboardedAt ? "/app" : "/welcome" };
			// A brand-new server has nobody to sign in as: go straight to creating the owner account.
			if (clean === "/login" && options.needsOwner) return { redirect: "/signup" };
			if ((page.guard === "user" || page.guard === "onboarded") && !user) {
				return { redirect: `/login?next=${encodeURIComponent(clean + search)}` };
			}
			if (page.guard === "onboarded" && user && !user.onboardedAt) return { redirect: "/welcome" };
			const asset = this.files.get(`/${page.file}`);
			return asset ? { asset } : null;
		}
		if (clean.endsWith(".html")) return null;
		const asset = this.files.get(clean);
		return asset ? { asset } : null;
	}
}
