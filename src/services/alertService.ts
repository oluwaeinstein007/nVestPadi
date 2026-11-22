/**
 * Price / momentum / volume alerts, checked after every sync and delivered to
 * Telegram and/or Discord. Alerts are one-shot: once triggered they stay in the
 * list (with the trigger value) but are no longer evaluated.
 */
import { rsi, sma } from "../analysis/technicalAnalysis.js";
import type { Config } from "../config.js";
import { postJson } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { round } from "../lib/util.js";
import type { Exchange } from "../markets/types.js";
import type { AlertRow, Database } from "../storage/database.js";

export const ALERT_CONDITIONS = {
	above: "price rises to or above",
	below: "price falls to or below",
	"change-above": "daily change % is at least",
	"change-below": "daily change % is at most",
	"rsi-above": "RSI(14) rises above",
	"rsi-below": "RSI(14) falls below",
	"volume-spike": "volume is at least N× its 20-day average, N =",
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

export class Notifier {
	constructor(private readonly config: Config["notifications"]) {}

	get channels(): string[] {
		return [this.config.telegram && "telegram", this.config.discordWebhookUrl && "discord"].filter(Boolean) as string[];
	}

	async send(text: string): Promise<void> {
		const { telegram, discordWebhookUrl } = this.config;
		const jobs: Promise<unknown>[] = [];
		if (telegram) {
			jobs.push(
				postJson(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
					chat_id: telegram.chatId,
					text,
					disable_web_page_preview: true,
				}),
			);
		}
		if (discordWebhookUrl) jobs.push(postJson(discordWebhookUrl, { content: text.slice(0, 2000) }));
		const results = await Promise.allSettled(jobs);
		for (const r of results) {
			if (r.status === "rejected") logger.warn("notification failed", { error: String(r.reason) });
		}
	}
}

export class AlertService {
	constructor(
		private readonly db: Database,
		private readonly notifier: Notifier,
	) {}

	add(input: {
		exchange: Exchange;
		symbol: string;
		condition: AlertCondition;
		threshold: number;
		note?: string;
	}): AlertRow {
		if (!Number.isFinite(input.threshold)) throw new Error("Alert threshold must be a number");
		if (input.condition === "volume-spike" && input.threshold <= 1)
			throw new Error("volume-spike multiplier must be > 1 (e.g. 3)");
		return this.db.createAlert(input);
	}

	list(activeOnly = false) {
		return this.db.listAlerts({ activeOnly });
	}

	remove(id: number): boolean {
		return this.db.deleteAlert(id);
	}

	/** Evaluate all active alerts against the latest stored data; notify and mark the ones that fire. */
	async check(): Promise<TriggeredAlert[]> {
		const triggered: TriggeredAlert[] = [];
		for (const alert of this.db.listAlerts({ activeOnly: true })) {
			const value = this.evaluate(alert);
			if (value === null) continue;
			this.db.markAlertTriggered(alert.id, value);
			const quote = this.db.latestQuote(alert.exchange, alert.symbol);
			const message = `🔔 ${alert.exchange}:${alert.symbol} — ${ALERT_CONDITIONS[alert.condition as AlertCondition]} ${alert.threshold} (now ${value}${quote ? `, close ${quote.currency} ${quote.close} on ${quote.date}` : ""})${alert.note ? `\n${alert.note}` : ""}`;
			triggered.push({
				alert: { ...alert, triggeredAt: new Date().toISOString(), triggerValue: value },
				value,
				message,
			});
		}
		if (triggered.length > 0 && this.notifier.channels.length > 0) {
			await this.notifier.send(triggered.map((t) => t.message).join("\n\n"));
		}
		return triggered;
	}

	/** Returns the observed value if the alert condition is met, else null. */
	private evaluate(alert: AlertRow): number | null {
		const quote = this.db.latestQuote(alert.exchange, alert.symbol);
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
					this.db.history(alert.exchange, alert.symbol, 120).map((b) => b.close),
					14,
				).at(-1);
				if (value === undefined || Number.isNaN(value)) return null;
				const hit = alert.condition === "rsi-above" ? value > t : value < t;
				return hit ? round(value, 1) : null;
			}
			case "volume-spike": {
				const bars = this.db.history(alert.exchange, alert.symbol, 21);
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
			default:
				return null;
		}
	}
}
