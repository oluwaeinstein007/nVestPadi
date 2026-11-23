import type { SQLInputValue } from "node:sqlite";
import type { Exchange } from "../../markets/types.js";
import type { Database } from "../database.js";

type Row = Record<string, SQLInputValue>;

export interface AlertRow {
	id: number;
	userId: number | null;
	exchange: Exchange;
	symbol: string;
	condition: string;
	threshold: number;
	note: string | null;
	createdAt: string;
	triggeredAt: string | null;
	triggerValue: number | null;
}

/** Per-user one-shot alerts. */
export class AlertRepository {
	constructor(private readonly db: Database) {}

	create(a: {
		userId: number;
		exchange: Exchange;
		symbol: string;
		condition: string;
		threshold: number;
		note?: string;
	}): AlertRow {
		const r = this.db
			.prepare("INSERT INTO alerts (user_id, exchange, symbol, condition, threshold, note) VALUES (?, ?, ?, ?, ?, ?)")
			.run(a.userId, a.exchange, a.symbol.toUpperCase(), a.condition, a.threshold, a.note ?? null);
		return this.get(Number(r.lastInsertRowid)) as AlertRow;
	}

	get(id: number): AlertRow | null {
		const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as Row | undefined;
		return row ? toAlert(row) : null;
	}

	listForUser(userId: number, options: { activeOnly?: boolean } = {}): AlertRow[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM alerts WHERE user_id = ? ${options.activeOnly ? "AND triggered_at IS NULL" : ""} ORDER BY id`,
			)
			.all(userId) as Row[];
		return rows.map(toAlert);
	}

	/** Every armed alert that belongs to an account. */
	listActive(): AlertRow[] {
		return (
			this.db
				.prepare("SELECT * FROM alerts WHERE triggered_at IS NULL AND user_id IS NOT NULL ORDER BY id")
				.all() as Row[]
		).map(toAlert);
	}

	countActive(userId: number): number {
		return (
			this.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND triggered_at IS NULL").get(userId) as {
				n: number;
			}
		).n;
	}

	markTriggered(id: number, value: number) {
		this.db.prepare("UPDATE alerts SET triggered_at = datetime('now'), trigger_value = ? WHERE id = ?").run(value, id);
	}

	/** Re-arm a fired alert so it is evaluated again. */
	rearm(userId: number, id: number): AlertRow | null {
		const r = this.db
			.prepare("UPDATE alerts SET triggered_at = NULL, trigger_value = NULL WHERE id = ? AND user_id = ?")
			.run(id, userId);
		return Number(r.changes) > 0 ? this.get(id) : null;
	}

	delete(userId: number, id: number): boolean {
		return Number(this.db.prepare("DELETE FROM alerts WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
	}
}

function toAlert(r: Row): AlertRow {
	return {
		id: Number(r.id),
		userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		condition: String(r.condition),
		threshold: Number(r.threshold),
		note: (r.note as string | null) ?? null,
		createdAt: String(r.created_at),
		triggeredAt: (r.triggered_at as string | null) ?? null,
		triggerValue: r.trigger_value === null || r.trigger_value === undefined ? null : Number(r.trigger_value),
	};
}
