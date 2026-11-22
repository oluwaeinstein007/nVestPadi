import { createHash } from "node:crypto";

/** Deterministic UUID-shaped ID: the same key always yields the same Qdrant point ID. */
export function deterministicId(key: string): string {
	const h = sha256(key);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Map with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i] as T, i);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Parse numbers like "1,234.50", "+0.55", "-9.99%"; returns null when not numeric. */
export function toNumber(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const cleaned = String(value).replace(/[,%\s]/g, "");
	if (cleaned === "" || cleaned === "-") return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

export function round(value: number, decimals = 2): number {
	const f = 10 ** decimals;
	return Math.round(value * f) / f;
}

export function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}
