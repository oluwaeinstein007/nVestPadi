/**
 * Per-user alert delivery. Every account can get email (once verified);
 * Telegram works when the server has a bot token and the user has set a chat
 * ID; Discord webhooks depend on the plan.
 */
import type { AppMode } from "../config.js";
import { postJson } from "../lib/http.js";
import { errorMessage, logger } from "../lib/logger.js";
import type { User } from "../storage/repositories/users.js";
import * as emails from "./emails.js";
import type { Mailer } from "./mailer.js";
import { limitsFor } from "./plans.js";

export type Channel = "email" | "telegram" | "discord";

export interface DeliveryResult {
	channel: Channel;
	ok: boolean;
	error?: string;
}

export class Notifier {
	constructor(
		private readonly mailer: Mailer,
		private readonly telegramBotToken: string | null,
		private readonly mode: AppMode,
		private readonly appUrl: string,
	) {}

	get telegramAvailable(): boolean {
		return this.telegramBotToken !== null;
	}

	get emailDelivers(): boolean {
		return this.mailer.delivers;
	}

	channelsFor(user: User): Channel[] {
		const channels: Channel[] = [];
		if (user.emailAlerts && user.emailVerifiedAt && this.mailer.delivers) channels.push("email");
		if (this.telegramBotToken && user.telegramChatId) channels.push("telegram");
		if (user.discordWebhookUrl && limitsFor(user, this.mode).discordAlerts) channels.push("discord");
		return channels;
	}

	/** Send alert messages over every channel the user has enabled. Failures are reported, never thrown. */
	async deliver(user: User, messages: string[], options: { test?: boolean } = {}): Promise<DeliveryResult[]> {
		const text = messages.join("\n\n");
		const jobs = this.channelsFor(user).map(async (channel): Promise<DeliveryResult> => {
			try {
				if (channel === "email") {
					await this.mailer.send(
						options.test
							? emails.testNotification(user.email, user.name, `${this.appUrl}/app/settings`)
							: emails.alertDigest(user.email, user.name, messages, `${this.appUrl}/app`),
					);
				} else if (channel === "telegram") {
					await postJson(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
						chat_id: user.telegramChatId,
						text,
						disable_web_page_preview: true,
					});
				} else {
					await postJson(user.discordWebhookUrl as string, { content: text.slice(0, 2000) });
				}
				return { channel, ok: true };
			} catch (err) {
				logger.warn("notification failed", { userId: user.id, channel, error: errorMessage(err) });
				return { channel, ok: false, error: errorMessage(err) };
			}
		});
		return Promise.all(jobs);
	}
}
