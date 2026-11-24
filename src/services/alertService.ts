/**
 * Price / momentum / volume alerts, checked after every sync and delivered to
 * each owner's channels. Alerts are one-shot: once triggered they stay in the
 * list (with the trigger value) until deleted or re-armed.
 */
import { MIN_TRADES, analyzeSignals } from "../analysis/signals.js";
import { rsi, sma } from "../analysis/technicalAnalysis.js";
import type { AppMode } from "../config.js";
import { NotFoundError, PlanLimitError, ValidationError } from "../lib/errors.js";
import { round } from "../lib/util.js";
import type { Exchange } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { AlertRow } from "../storage/repositories/alerts.js";
import type { User } from "../storage/repositories/users.js";
import type { DeliveryResult, Notifier } from "./notifier.js";
import { limitsFor } from "./plans.js";

export const ALERT_CONDITIONS = {
	above: "price rises to or above",
	below: "price falls to or below",
	"change-above": "daily change % is at least",
	"change-below": "daily change % is at most",
	"rsi-above": "RSI(14) rises above",
	"rsi-below": "RSI(14) falls below",
	"volume-spike": "volume is at least N× its 20-day average, N =",
	"signal-buy": "a BUY signal fires whose past success rate (%) is at least",
	"signal-sell": "a SELL signal fires whose past success rate (%) is at least",
} as const;
export type AlertCondition = keyof typeof ALERT_CONDITIONS;

export function isAlertCondition(value: string): value is AlertCondition {
	return value in ALERT_CONDITIONS;
}

export interface TriggeredAlert {
	alert: AlertRow;
	value: number;
	message: string;
}

export class AlertService {
	constructor(
		private readonly db: Database,
		private readonly notifier: Notifier,
		private readonly mode: AppMode,
	) {}

	add(
		user: User,
		input: { exchange: Exchange; symbol: string; condition: AlertCondition; threshold: number; note?: string },
	): AlertRow {
		if (!Number.isFinite(input.threshold)) throw new ValidationError("Alert threshold must be a number");
		if (input.condition === "volume-spike" && input.threshold <= 1)
			throw new ValidationError("volume-spike multiplier must be > 1 (e.g. 3)");
		if (input.condition.startsWith("signal-") && (input.threshold < 0 || input.threshold > 100))
			throw new ValidationError("Signal alerts take a minimum success rate from 0 to 100 (0 = any signal).");
		this.assertCapacity(user);
		return this.db.alerts.create({ ...input, userId: user.id });
	}

	list(user: User, activeOnly = false): AlertRow[] {
		return this.db.alerts.listForUser(user.id, { activeOnly });
	}

	remove(user: User, id: number): boolean {
		return this.db.alerts.delete(user.id, id);
	}

	rearm(user: User, id: number): AlertRow {
		this.assertCapacity(user);
		const alert = this.db.alerts.rearm(user.id, id);
		if (!alert) throw new NotFoundError("Alert not found");
		return alert;
	}

	private assertCapacity(user: User) {
		const { activeAlerts } = limitsFor(user, this.mode);
		if (this.db.alerts.countActive(user.id) >= activeAlerts) {
			throw new PlanLimitError(
				`Your plan allows ${activeAlerts} active alert${activeAlerts === 1 ? "" : "s"}. Delete one or upgrade to Pro.`,
			);
		}
	}

	/**
	 * Evaluate every armed alert against the latest stored data, mark the ones
	 * that fire, and send each owner one digest.
	 */
	async check(): Promise<(TriggeredAlert & { delivery?: DeliveryResult[] })[]> {
		const triggered: TriggeredAlert[] = [];
		for (const alert of this.db.alerts.listActive()) {
			const value = this.evaluate(alert);
			if (value === null) continue;
			this.db.alerts.markTriggered(alert.id, value);
			triggered.push({
				alert: { ...alert, triggeredAt: new Date().toISOString(), triggerValue: value },
				value,
				message: this.describe(alert, value),
			});
		}

		const byUser = new Map<number, TriggeredAlert[]>();
		for (const t of triggered) {
			const userId = t.alert.userId as number;
			byUser.set(userId, [...(byUser.get(userId) ?? []), t]);
		}
		const results: (TriggeredAlert & { delivery?: DeliveryResult[] })[] = [];
		for (const [userId, list] of byUser) {
			const user = this.db.users.byId(userId);
			const delivery = user
				? await this.notifier.deliver(
						user,
						list.map((t) => t.message),
					)
				: [];
			for (const t of list) results.push({ ...t, delivery });
		}
		return results;
	}

	private describe(alert: AlertRow, value: number): string {
		const quote = this.db.market.latestQuote(alert.exchange, alert.symbol);
		if (alert.condition === "signal-buy" || alert.condition === "signal-sell") {
			const call = analyzeSignals(this.db.market.history(alert.exchange, alert.symbol, 730)).call;
			const p = call?.plan;
			const levels = p
				? p.side === "BUY"
					? ` Plan: entry ~${p.entry}, stop ${p.stop}, target ${p.target}.`
					: ` Wrong above ${p.stop}; downside objective ${p.target}.`
				: "";
			const record = call?.track.trades
				? ` Past ${call.side} signals: ${call.track.wins}/${call.track.trades} worked (${value}%).`
				: "";
			return `📈 ${alert.exchange}:${alert.symbol} — ${call?.strength ?? ""} ${call?.side ?? alert.condition.slice(7).toUpperCase()} signal${quote ? ` at ${quote.currency} ${quote.close} (${quote.date})` : ""}.${call ? ` ${call.reason}.` : ""}${levels}${record}${alert.note ? `\n${alert.note}` : ""}`;
		}
		const label = ALERT_CONDITIONS[alert.condition as AlertCondition] ?? alert.condition;
		return `🔔 ${alert.exchange}:${alert.symbol} — ${label} ${alert.threshold} (now ${value}${quote ? `, close ${quote.currency} ${quote.close} on ${quote.date}` : ""})${alert.note ? `\n${alert.note}` : ""}`;
	}

	/** Returns the observed value if the alert condition is met, else null. */
	private evaluate(alert: AlertRow): number | null {
		const quote = this.db.market.latestQuote(alert.exchange, alert.symbol);
		if (!quote) return null;
		const t = alert.threshold;
		switch (alert.condition as AlertCondition) {
			case "above":
				return quote.close >= t ? quote.close : null;
			case "below":
				return quote.close <= t ? quote.close : null;
			case "change-above":
				return quote.changePct !== null && quote.changePct >= t ? quote.changePct : null;
			case "change-below":
				return quote.changePct !== null && quote.changePct <= t ? quote.changePct : null;
			case "rsi-above":
			case "rsi-below": {
				const value = rsi(
					this.db.market.history(alert.exchange, alert.symbol, 120).map((b) => b.close),
					14,
				).at(-1);
				if (value === undefined || Number.isNaN(value)) return null;
				const hit = alert.condition === "rsi-above" ? value > t : value < t;
				return hit ? round(value, 1) : null;
			}
			case "volume-spike": {
				const bars = this.db.market.history(alert.exchange, alert.symbol, 21);
				if (bars.length < 11 || quote.volume === null) return null;
				const avg =
					sma(
						bars.slice(0, -1).map((b) => b.volume ?? 0),
						bars.length - 1,
					).at(-1) ?? 0;
				if (avg <= 0) return null;
				const ratio = quote.volume / avg;
				return ratio >= t ? round(ratio, 1) : null;
			}
			case "signal-buy":
			case "signal-sell": {
				const call = analyzeSignals(this.db.market.history(alert.exchange, alert.symbol, 730)).call;
				if (!call || call.side !== (alert.condition === "signal-buy" ? "BUY" : "SELL")) return null;
				const rate = call.track.winRate ?? 0;
				// A minimum success rate only means something with enough past signals behind it.
				if (t > 0 && (call.track.trades < MIN_TRADES || rate < t)) return null;
				return rate;
			}
			default:
				return null;
		}
	}
}
