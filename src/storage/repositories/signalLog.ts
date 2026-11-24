import type { Side } from "../../analysis/signals.js";
import type { Exchange } from "../../markets/types.js";
import type { Database, Param, Row } from "../database.js";
import { timestamp } from "../driver.js";
import { num, str } from "../rows.js";

export type LoggedStatus = "pending" | "open" | "closed";

/** A signal as it was shown, plus how it has played out since. */
export interface LoggedSignal {
	id: number;
	exchange: Exchange;
	symbol: string;
	side: Side;
	rule: string;
	strength: string;
	reason: string;
	evidence: string;
	/** Session the signal fired on. */
	signalDate: string;
	/** Latest session when it was first logged; the trade enters on the session after this one. */
	seenDate: string;
	loggedAt: string;
	refPrice: number;
	stop: number;
	target: number;
	horizon: number;
	costPct: number;
	/** The estimated chance of profit after costs (%) shown with the signal. */
	probability: number | null;
	probLow: number | null;
	probHigh: number | null;
	confidence: string | null;
	baseRate: number | null;
	pastTrades: number;
	pastWinRate: number | null;
	/** pending: waiting for the entry session. open: entered, not exited. closed: scored. */
	status: LoggedStatus;
	entryDate: string | null;
	entryPrice: number | null;
	exitDate: string | null;
	exitPrice: number | null;
	exitReason: string | null;
	lastDate: string | null;
	lastPrice: number | null;
	/** Before costs (for an open trade: so far). */
	returnPct: number | null;
	netReturnPct: number | null;
	sessions: number | null;
}

export type NewLoggedSignal = Omit<
	LoggedSignal,
	| "id"
	| "loggedAt"
	| "status"
	| "entryDate"
	| "entryPrice"
	| "exitDate"
	| "exitPrice"
	| "exitReason"
	| "lastDate"
	| "lastPrice"
	| "returnPct"
	| "netReturnPct"
	| "sessions"
>;

export type SignalProgress = Pick<
	LoggedSignal,
	| "status"
	| "entryDate"
	| "entryPrice"
	| "exitDate"
	| "exitPrice"
	| "exitReason"
	| "lastDate"
	| "lastPrice"
	| "returnPct"
	| "netReturnPct"
	| "sessions"
>;

const COLUMNS: [keyof NewLoggedSignal, string][] = [
	["exchange", "exchange"],
	["symbol", "symbol"],
	["side", "side"],
	["rule", "rule"],
	["strength", "strength"],
	["reason", "reason"],
	["evidence", "evidence"],
	["signalDate", "signal_date"],
	["seenDate", "seen_date"],
	["refPrice", "ref_price"],
	["stop", "stop"],
	["target", "target"],
	["horizon", "horizon"],
	["costPct", "cost_pct"],
	["probability", "probability"],
	["probLow", "prob_low"],
	["probHigh", "prob_high"],
	["confidence", "confidence"],
	["baseRate", "base_rate"],
	["pastTrades", "past_trades"],
	["pastWinRate", "past_win_rate"],
];

/** The live signal ledger: append-only while pending/open, frozen once closed. */
export class SignalLogRepository {
	constructor(private readonly db: Database) {}

	/** Log a signal unless it already is (same security, side, rules and firing session). True if it was new. */
	async insert(s: NewLoggedSignal): Promise<boolean> {
		const r = await this.db.run(
			`INSERT INTO signal_log (${COLUMNS.map(([, c]) => c).join(", ")}, logged_at)
			 VALUES (${COLUMNS.map(() => "?").join(", ")}, ?)
			 ON CONFLICT (exchange, symbol, side, rule, signal_date) DO NOTHING`,
			[...COLUMNS.map(([k]) => s[k] as Param), timestamp()],
		);
		return r.changes > 0;
	}

	/** Signals not yet scored, oldest first. */
	async unresolved(exchange: Exchange): Promise<LoggedSignal[]> {
		const rows = await this.db.all(
			"SELECT * FROM signal_log WHERE exchange = ? AND status <> 'closed' ORDER BY signal_date, id",
			[exchange],
		);
		return rows.map(toLogged);
	}

	/** Record progress. A closed row is never changed again. */
	async progress(id: number, p: SignalProgress): Promise<void> {
		await this.db.run(
			`UPDATE signal_log SET status = ?, entry_date = ?, entry_price = ?, exit_date = ?, exit_price = ?,
				exit_reason = ?, last_date = ?, last_price = ?, return_pct = ?, net_return_pct = ?, sessions = ?
			 WHERE id = ? AND status <> 'closed'`,
			[
				p.status,
				p.entryDate,
				p.entryPrice,
				p.exitDate,
				p.exitPrice,
				p.exitReason,
				p.lastDate,
				p.lastPrice,
				p.returnPct,
				p.netReturnPct,
				p.sessions,
				id,
			],
		);
	}

	async list(filter: { exchange?: Exchange; side?: Side; rule?: string; status?: LoggedStatus } = {}) {
		const where: string[] = [];
		const params: Param[] = [];
		for (const [col, value] of [
			["exchange", filter.exchange],
			["side", filter.side],
			["rule", filter.rule],
			["status", filter.status],
		] as const) {
			if (value === undefined) continue;
			where.push(`${col} = ?`);
			params.push(value);
		}
		const rows = await this.db.all(
			`SELECT * FROM signal_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY logged_at DESC, id DESC`,
			params,
		);
		return rows.map(toLogged);
	}

	/** Closed live outcomes per side for one market and rule set: wins are profits after costs. */
	async outcomes(exchange: Exchange, rule: string): Promise<Record<Side, { wins: number; trades: number }>> {
		const rows = await this.db.all(
			`SELECT side, COUNT(*) AS trades, SUM(CASE WHEN net_return_pct > 0 THEN 1 ELSE 0 END) AS wins
			 FROM signal_log WHERE exchange = ? AND rule = ? AND status = 'closed' GROUP BY side`,
			[exchange, rule],
		);
		const out = { BUY: { wins: 0, trades: 0 }, SELL: { wins: 0, trades: 0 } };
		for (const r of rows) out[r.side as Side] = { wins: Number(r.wins ?? 0), trades: Number(r.trades ?? 0) };
		return out;
	}
}

function toLogged(r: Row): LoggedSignal {
	return {
		id: Number(r.id),
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		side: r.side as Side,
		rule: String(r.rule),
		strength: String(r.strength),
		reason: String(r.reason),
		evidence: String(r.evidence),
		signalDate: String(r.signal_date),
		seenDate: String(r.seen_date),
		loggedAt: String(r.logged_at),
		refPrice: Number(r.ref_price),
		stop: Number(r.stop),
		target: Number(r.target),
		horizon: Number(r.horizon),
		costPct: Number(r.cost_pct),
		probability: num(r.probability),
		probLow: num(r.prob_low),
		probHigh: num(r.prob_high),
		confidence: str(r.confidence),
		baseRate: num(r.base_rate),
		pastTrades: Number(r.past_trades),
		pastWinRate: num(r.past_win_rate),
		status: r.status as LoggedStatus,
		entryDate: str(r.entry_date),
		entryPrice: num(r.entry_price),
		exitDate: str(r.exit_date),
		exitPrice: num(r.exit_price),
		exitReason: str(r.exit_reason),
		lastDate: str(r.last_date),
		lastPrice: num(r.last_price),
		returnPct: num(r.return_pct),
		netReturnPct: num(r.net_return_pct),
		sessions: num(r.sessions),
	};
}
