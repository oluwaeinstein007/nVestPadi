import type { Exchange } from "../../markets/types.js";
import type { Database, Row } from "../database.js";
import { timestamp } from "../driver.js";
import { num, str } from "../rows.js";

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

	async create(a: {
		userId: number;
		exchange: Exchange;
		symbol: string;
		condition: string;
		threshold: number;
		note?: string;
	}): Promise<AlertRow> {
		const row = await this.db.get(
			"INSERT INTO alerts (user_id, exchange, symbol, condition, threshold, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
			[a.userId, a.exchange, a.symbol.toUpperCase(), a.condition, a.threshold, a.note ?? null],
		);
		return (await this.get(Number(row?.id))) as AlertRow;
	}

	async get(id: number): Promise<AlertRow | null> {
		const row = await this.db.get("SELECT * FROM alerts WHERE id = ?", [id]);
		return row ? toAlert(row) : null;
	}

	async listForUser(userId: number, options: { activeOnly?: boolean } = {}): Promise<AlertRow[]> {
		const rows = await this.db.all(
			`SELECT * FROM alerts WHERE user_id = ? ${options.activeOnly ? "AND triggered_at IS NULL" : ""} ORDER BY id`,
			[userId],
		);
		return rows.map(toAlert);
	}

	/** Every armed alert that belongs to an account. */
	async listActive(): Promise<AlertRow[]> {
		const rows = await this.db.all(
			"SELECT * FROM alerts WHERE triggered_at IS NULL AND user_id IS NOT NULL ORDER BY id",
		);
		return rows.map(toAlert);
	}

	countActive(userId: number): Promise<number> {
		return this.db.count("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND triggered_at IS NULL", [userId]);
	}

	/** Mark an armed alert as fired. False if it already was — e.g. another instance's check got there first. */
	async markTriggered(id: number, value: number): Promise<boolean> {
		const r = await this.db.run(
			"UPDATE alerts SET triggered_at = ?, trigger_value = ? WHERE id = ? AND triggered_at IS NULL",
			[timestamp(), value, id],
		);
		return r.changes > 0;
	}

	/** Re-arm a fired alert so it is evaluated again. */
	async rearm(userId: number, id: number): Promise<AlertRow | null> {
		const r = await this.db.run(
			"UPDATE alerts SET triggered_at = NULL, trigger_value = NULL WHERE id = ? AND user_id = ?",
			[id, userId],
		);
		return r.changes > 0 ? this.get(id) : null;
	}

	async delete(userId: number, id: number): Promise<boolean> {
		return (await this.db.run("DELETE FROM alerts WHERE id = ? AND user_id = ?", [id, userId])).changes > 0;
	}
}

function toAlert(r: Row): AlertRow {
	return {
		id: Number(r.id),
		userId: num(r.user_id),
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		condition: String(r.condition),
		threshold: Number(r.threshold),
		note: str(r.note),
		createdAt: String(r.created_at),
		triggeredAt: str(r.triggered_at),
		triggerValue: num(r.trigger_value),
	};
}
