import type { Database } from "../database.js";
import { timestamp } from "../driver.js";
import { str } from "../rows.js";

/** Tiny key/value store that makes scheduled jobs idempotent across restarts. */
export class JobStateRepository {
	constructor(private readonly db: Database) {}

	async get(key: string): Promise<string | null> {
		return str((await this.db.get("SELECT value FROM job_state WHERE key = ?", [key]))?.value);
	}

	async set(key: string, value: string): Promise<void> {
		await this.db.run(
			`INSERT INTO job_state (key, value) VALUES (?, ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = ?`,
			[key, value, timestamp()],
		);
	}

	/** Atomically mark `key` as done; false if it already was (another run got there first). */
	async claim(key: string, value = "1"): Promise<boolean> {
		const r = await this.db.run("INSERT INTO job_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [
			key,
			value,
		]);
		return r.changes > 0;
	}

	async release(key: string): Promise<void> {
		await this.db.run("DELETE FROM job_state WHERE key = ?", [key]);
	}
}
