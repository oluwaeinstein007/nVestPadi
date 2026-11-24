import type { Database } from "../database.js";

export type UsageMetric = "ai_questions";

const today = () => new Date().toISOString().slice(0, 10);

/** Daily usage counters for metered features (UTC days). */
export class UsageRepository {
	constructor(private readonly db: Database) {}

	async get(userId: number, metric: UsageMetric, day = today()): Promise<number> {
		const row = await this.db.get("SELECT count FROM usage WHERE user_id = ? AND day = ? AND metric = ?", [
			userId,
			day,
			metric,
		]);
		return Number(row?.count ?? 0);
	}

	/**
	 * Count one use if it stays within `limit`; false when the limit is reached. A single statement, so concurrent
	 * requests can't both slip past the limit.
	 */
	async consume(userId: number, metric: UsageMetric, limit: number, day = today()): Promise<boolean> {
		if (limit < 1) return false;
		const row = await this.db.get(
			`INSERT INTO usage (user_id, day, metric, count) VALUES (?, ?, ?, 1)
			 ON CONFLICT (user_id, day, metric) DO UPDATE SET count = usage.count + 1 WHERE usage.count < ?
			 RETURNING count`,
			[userId, day, metric, limit],
		);
		return row !== undefined;
	}

	/** Give a use back, e.g. when the metered call failed upstream. */
	async refund(userId: number, metric: UsageMetric, day = today()): Promise<void> {
		await this.db.run(
			"UPDATE usage SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE user_id = ? AND day = ? AND metric = ?",
			[userId, day, metric],
		);
	}
}
