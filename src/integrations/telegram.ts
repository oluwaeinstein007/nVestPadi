/**
 * Telegram Bot API client (raw HTTPS, no SDK). Supports both delivery modes:
 * a webhook (production, needs an https APP_URL and a secret) or long polling
 * (local/self-hosted). Only one of them can be active per bot token.
 */
import { postJson } from "../lib/http.js";
import { errorMessage, logger } from "../lib/logger.js";

export interface TelegramMessage {
	message_id: number;
	text?: string;
	chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
	from?: { id: number; first_name?: string; username?: string };
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	channel_post?: TelegramMessage;
}

/** Telegram rejects messages over 4096 characters. */
const MAX_MESSAGE = 4000;

export class TelegramClient {
	private username: string | null = null;

	constructor(private readonly token: string) {}

	private call<T>(
		method: string,
		body: Record<string, unknown> = {},
		timeoutMs = 20_000,
	): Promise<{ ok: boolean; result: T }> {
		return postJson(`https://api.telegram.org/bot${this.token}/${method}`, body, { timeoutMs });
	}

	async sendMessage(chatId: string | number, html: string) {
		await this.call("sendMessage", {
			chat_id: chatId,
			text: html.length > MAX_MESSAGE ? `${html.slice(0, MAX_MESSAGE)}…` : html,
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
	}

	/** The bot's @username, used for t.me deep links. Cached after the first call. */
	async botUsername(): Promise<string> {
		if (!this.username) this.username = (await this.call<{ username: string }>("getMe")).result.username;
		return this.username;
	}

	async setWebhook(url: string, secret: string) {
		await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "channel_post"] });
	}

	async deleteWebhook() {
		await this.call("deleteWebhook", { drop_pending_updates: false });
	}

	async setCommands(commands: { command: string; description: string }[]) {
		await this.call("setMyCommands", { commands });
	}

	/**
	 * Long-poll for updates until `signal` aborts. Each update is handed to
	 * `onUpdate`; errors back off instead of spinning.
	 */
	async poll(onUpdate: (update: TelegramUpdate) => Promise<void>, signal: AbortSignal) {
		let offset = 0;
		while (!signal.aborted) {
			try {
				const res = await this.call<TelegramUpdate[]>(
					"getUpdates",
					{ offset, timeout: 50, allowed_updates: ["message", "channel_post"] },
					60_000,
				);
				for (const update of res.result) {
					offset = update.update_id + 1;
					await onUpdate(update).catch((err) => logger.warn("telegram update failed", { error: errorMessage(err) }));
				}
			} catch (err) {
				if (signal.aborted) return;
				logger.warn("telegram polling error; retrying", { error: errorMessage(err) });
				await new Promise((r) => setTimeout(r, 5_000));
			}
		}
	}
}

export function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

/** Our light markup (**bold**, `code`) → Telegram HTML. */
export function toTelegramHtml(text: string): string {
	return escapeHtml(text)
		.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");
}
