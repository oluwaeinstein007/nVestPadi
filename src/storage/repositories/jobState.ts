import type { Database } from "../database.js";

/** Tiny key/value store that makes scheduled jobs idempotent across restarts. */
export class JobStateRepository {
	constructor(private readonly db: Database) {}

	get(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM job_state WHERE key = ?").get(key) as
			| { value: string | null }
			| undefined;
		return row?.value ?? null;
	}

	set(key: string, value: string) {
		this.db
			.prepare(
				`INSERT INTO job_state (key, value) VALUES (?, ?)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
			)
			.run(key, value);
	}

	/** Atomically mark `key` as done; false if it already was (another run got there first). */
	claim(key: string, value = "1"): boolean {
		return (
			Number(this.db.prepare("INSERT OR IGNORE INTO job_state (key, value) VALUES (?, ?)").run(key, value).changes) > 0
		);
	}

	release(key: string) {
		this.db.prepare("DELETE FROM job_state WHERE key = ?").run(key);
	}
}
