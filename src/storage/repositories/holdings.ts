import type { Exchange } from "../../markets/types.js";
import type { Database } from "../database.js";

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

const COLUMNS =
	"id, exchange, symbol, quantity, avg_cost AS avgCost, note, created_at AS createdAt, updated_at AS updatedAt";

/** Per-user portfolio positions (one row per security; adding again averages the cost). */
export class HoldingsRepository {
	constructor(private readonly db: Database) {}

	list(userId: number): Holding[] {
		return this.db
			.prepare(`SELECT ${COLUMNS} FROM holdings WHERE user_id = ? ORDER BY exchange, symbol`)
			.all(userId) as unknown as Holding[];
	}

	get(userId: number, id: number): Holding | null {
		return (
			(this.db.prepare(`SELECT ${COLUMNS} FROM holdings WHERE user_id = ? AND id = ?`).get(userId, id) as unknown as
				| Holding
				| undefined) ?? null
		);
	}

	find(userId: number, exchange: Exchange, symbol: string): Holding | null {
		return (
			(this.db
				.prepare(`SELECT ${COLUMNS} FROM holdings WHERE user_id = ? AND exchange = ? AND symbol = ?`)
				.get(userId, exchange, symbol.toUpperCase()) as unknown as Holding | undefined) ?? null
		);
	}

	count(userId: number): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM holdings WHERE user_id = ?").get(userId) as { n: number }).n;
	}

	insert(
		userId: number,
		h: { exchange: Exchange; symbol: string; quantity: number; avgCost: number; note?: string },
	): Holding {
		const r = this.db
			.prepare("INSERT INTO holdings (user_id, exchange, symbol, quantity, avg_cost, note) VALUES (?, ?, ?, ?, ?, ?)")
			.run(userId, h.exchange, h.symbol.toUpperCase(), h.quantity, h.avgCost, h.note ?? null);
		return this.get(userId, Number(r.lastInsertRowid)) as Holding;
	}

	update(
		userId: number,
		id: number,
		patch: { quantity: number; avgCost: number; note?: string | null },
	): Holding | null {
		this.db
			.prepare(
				"UPDATE holdings SET quantity = ?, avg_cost = ?, note = COALESCE(?, note), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
			)
			.run(patch.quantity, patch.avgCost, patch.note ?? null, id, userId);
		return this.get(userId, id);
	}

	delete(userId: number, id: number): boolean {
		return Number(this.db.prepare("DELETE FROM holdings WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
	}
}
