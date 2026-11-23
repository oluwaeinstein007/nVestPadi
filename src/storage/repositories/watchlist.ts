import type { Exchange } from "../../markets/types.js";
import type { Database } from "../database.js";

export interface WatchlistEntry {
	exchange: Exchange;
	symbol: string;
	addedAt: string;
}

/** Per-user watchlists. */
export class WatchlistRepository {
	constructor(private readonly db: Database) {}

	add(userId: number, exchange: Exchange, symbol: string): boolean {
		const r = this.db
			.prepare("INSERT OR IGNORE INTO watchlist (user_id, exchange, symbol) VALUES (?, ?, ?)")
			.run(userId, exchange, symbol.toUpperCase());
		return Number(r.changes) > 0;
	}

	remove(userId: number, exchange: Exchange, symbol: string): boolean {
		const r = this.db
			.prepare("DELETE FROM watchlist WHERE user_id = ? AND exchange = ? AND symbol = ?")
			.run(userId, exchange, symbol.toUpperCase());
		return Number(r.changes) > 0;
	}

	has(userId: number, exchange: Exchange, symbol: string): boolean {
		return Boolean(
			this.db
				.prepare("SELECT 1 FROM watchlist WHERE user_id = ? AND exchange = ? AND symbol = ?")
				.get(userId, exchange, symbol.toUpperCase()),
		);
	}

	count(userId: number): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?").get(userId) as { n: number }).n;
	}

	list(userId: number): WatchlistEntry[] {
		return this.db
			.prepare("SELECT exchange, symbol, added_at AS addedAt FROM watchlist WHERE user_id = ? ORDER BY id")
			.all(userId) as unknown as WatchlistEntry[];
	}
}
