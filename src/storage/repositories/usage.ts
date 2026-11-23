import type { Database } from "../database.js";

export type UsageMetric = "ai_questions";

const today = () => new Date().toISOString().slice(0, 10);

/** Daily usage counters for metered features (UTC days). */
export class UsageRepository {
	constructor(private readonly db: Database) {}

	get(userId: number, metric: UsageMetric, day = today()): number {
		const row = this.db
			.prepare("SELECT count FROM usage WHERE user_id = ? AND day = ? AND metric = ?")
			.get(userId, day, metric) as { count: number } | undefined;
		return row?.count ?? 0;
	}

	/** Atomically count one use if it stays within `limit`; returns false when the limit is reached. */
	consume(userId: number, metric: UsageMetric, limit: number, day = today()): boolean {
		return this.db.transaction(() => {
			if (this.get(userId, metric, day) >= limit) return false;
			this.db
				.prepare(
					`INSERT INTO usage (user_id, day, metric, count) VALUES (?, ?, ?, 1)
					 ON CONFLICT (user_id, day, metric) DO UPDATE SET count = count + 1`,
				)
				.run(userId, day, metric);
			return true;
		});
	}

	/** Give a use back, e.g. when the metered call failed upstream. */
	refund(userId: number, metric: UsageMetric, day = today()) {
		this.db
			.prepare("UPDATE usage SET count = MAX(0, count - 1) WHERE user_id = ? AND day = ? AND metric = ?")
			.run(userId, day, metric);
	}
}
