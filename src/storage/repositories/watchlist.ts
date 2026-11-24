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

	async add(userId: number, exchange: Exchange, symbol: string): Promise<boolean> {
		const r = await this.db.run(
			"INSERT INTO watchlist (user_id, exchange, symbol) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
			[userId, exchange, symbol.toUpperCase()],
		);
		return r.changes > 0;
	}

	async remove(userId: number, exchange: Exchange, symbol: string): Promise<boolean> {
		const r = await this.db.run("DELETE FROM watchlist WHERE user_id = ? AND exchange = ? AND symbol = ?", [
			userId,
			exchange,
			symbol.toUpperCase(),
		]);
		return r.changes > 0;
	}

	async has(userId: number, exchange: Exchange, symbol: string): Promise<boolean> {
		const row = await this.db.get(
			"SELECT 1 AS present FROM watchlist WHERE user_id = ? AND exchange = ? AND symbol = ?",
			[userId, exchange, symbol.toUpperCase()],
		);
		return row !== undefined;
	}

	count(userId: number): Promise<number> {
		return this.db.count("SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?", [userId]);
	}

	async list(userId: number): Promise<WatchlistEntry[]> {
		const rows = await this.db.all("SELECT exchange, symbol, added_at FROM watchlist WHERE user_id = ? ORDER BY id", [
			userId,
		]);
		return rows.map((r) => ({
			exchange: r.exchange as Exchange,
			symbol: String(r.symbol),
			addedAt: String(r.added_at),
		}));
	}
}
