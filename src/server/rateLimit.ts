/** In-memory sliding-window rate limiter (per process; fine for a single instance). */
import { RateLimitError } from "../lib/errors.js";

export type Limiter = (key: string) => void;

export function rateLimiter(limit: number, windowMs: number, message?: string): Limiter {
	const hits = new Map<string, number[]>();
	let lastSweep = Date.now();
	return (key) => {
		const now = Date.now();
		if (now - lastSweep > windowMs) {
			// Drop idle keys so the map can't grow without bound.
			for (const [k, times] of hits) if (now - (times.at(-1) ?? 0) > windowMs) hits.delete(k);
			lastSweep = now;
		}
		const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
		if (recent.length >= limit) throw new RateLimitError(message);
		recent.push(now);
		hits.set(key, recent);
	};
}
