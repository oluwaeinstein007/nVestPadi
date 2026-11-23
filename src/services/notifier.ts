/**
 * Per-user delivery of alerts and personal digests. Every account can get
 * email (once verified); Telegram works once the user links the server's bot
 * from Settings; Discord webhooks depend on the plan. Messages use light
 * markup (**bold**), converted per channel.
 */
import type { AppMode } from "../config.js";
import { postDiscordWebhook } from "../integrations/discord.js";
import { type TelegramClient, toTelegramHtml } from "../integrations/telegram.js";
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
		private readonly telegram: TelegramClient | null,
		private readonly mode: AppMode,
		private readonly appUrl: string,
	) {}

	get telegramAvailable(): boolean {
		return this.telegram !== null;
	}

	get emailDelivers(): boolean {
		return this.mailer.delivers;
	}

	channelsFor(user: User): Channel[] {
		const channels: Channel[] = [];
		if (user.emailAlerts && user.emailVerifiedAt && this.mailer.delivers) channels.push("email");
		if (this.telegram && user.telegramChatId) channels.push("telegram");
		if (user.discordWebhookUrl && limitsFor(user, this.mode).discordAlerts) channels.push("discord");
		return channels;
	}

	/**
	 * Send messages over every channel the user has enabled. `subject` switches the
	 * email from an alert digest to a general update. Failures are reported, never thrown.
	 */
	async deliver(
		user: User,
		messages: string[],
		options: { test?: boolean; subject?: string } = {},
	): Promise<DeliveryResult[]> {
		const text = messages.join("\n\n");
		const jobs = this.channelsFor(user).map(async (channel): Promise<DeliveryResult> => {
			try {
				if (channel === "email") {
					await this.mailer.send(
						options.test
							? emails.testNotification(user.email, user.name, `${this.appUrl}/app/settings`)
							: options.subject
								? emails.update(user.email, user.name, options.subject, messages, `${this.appUrl}/app`)
								: emails.alertDigest(user.email, user.name, messages, `${this.appUrl}/app`),
					);
				} else if (channel === "telegram") {
					await this.telegram?.sendMessage(user.telegramChatId as string, toTelegramHtml(text));
				} else {
					await postDiscordWebhook(user.discordWebhookUrl as string, text);
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
