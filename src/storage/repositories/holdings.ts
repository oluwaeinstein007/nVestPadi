import type { Exchange } from "../../markets/types.js";
import type { Database, Row } from "../database.js";
import { timestamp } from "../driver.js";
import { str } from "../rows.js";

export interface Holding {
	id: number;
	exchange: Exchange;
	symbol: string;
	quantity: number;
	avgCost: number;
	note: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Per-user portfolio positions (one row per security; adding again averages the cost). */
export class HoldingsRepository {
	constructor(private readonly db: Database) {}

	async list(userId: number): Promise<Holding[]> {
		const rows = await this.db.all("SELECT * FROM holdings WHERE user_id = ? ORDER BY exchange, symbol", [userId]);
		return rows.map(toHolding);
	}

	async get(userId: number, id: number): Promise<Holding | null> {
		const row = await this.db.get("SELECT * FROM holdings WHERE user_id = ? AND id = ?", [userId, id]);
		return row ? toHolding(row) : null;
	}

	async find(userId: number, exchange: Exchange, symbol: string): Promise<Holding | null> {
		const row = await this.db.get("SELECT * FROM holdings WHERE user_id = ? AND exchange = ? AND symbol = ?", [
			userId,
			exchange,
			symbol.toUpperCase(),
		]);
		return row ? toHolding(row) : null;
	}

	count(userId: number): Promise<number> {
		return this.db.count("SELECT COUNT(*) AS n FROM holdings WHERE user_id = ?", [userId]);
	}

	async insert(
		userId: number,
		h: { exchange: Exchange; symbol: string; quantity: number; avgCost: number; note?: string },
	): Promise<Holding> {
		const row = await this.db.get(
			"INSERT INTO holdings (user_id, exchange, symbol, quantity, avg_cost, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
			[userId, h.exchange, h.symbol.toUpperCase(), h.quantity, h.avgCost, h.note ?? null],
		);
		return (await this.get(userId, Number(row?.id))) as Holding;
	}

	async update(
		userId: number,
		id: number,
		patch: { quantity: number; avgCost: number; note?: string | null },
	): Promise<Holding | null> {
		await this.db.run(
			"UPDATE holdings SET quantity = ?, avg_cost = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ? AND user_id = ?",
			[patch.quantity, patch.avgCost, patch.note ?? null, timestamp(), id, userId],
		);
		return this.get(userId, id);
	}

	async delete(userId: number, id: number): Promise<boolean> {
		return (await this.db.run("DELETE FROM holdings WHERE id = ? AND user_id = ?", [id, userId])).changes > 0;
	}
}

function toHolding(r: Row): Holding {
	return {
		id: Number(r.id),
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		quantity: Number(r.quantity),
		avgCost: Number(r.avg_cost),
		note: str(r.note),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	};
}
