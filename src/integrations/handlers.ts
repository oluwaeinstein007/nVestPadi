/** Glue between chat platforms and BotService: Telegram updates and Discord interactions. */
import type { App } from "../app.js";
import { errorMessage, logger } from "../lib/logger.js";
import { BOT_COMMANDS } from "../services/botService.js";
import { type Interaction, InteractionType, ResponseType, editInteractionResponse } from "./discord.js";
import { type TelegramUpdate, toTelegramHtml } from "./telegram.js";

export async function handleTelegramUpdate(app: App, update: TelegramUpdate): Promise<void> {
	const msg = update.message ?? update.channel_post;
	if (!msg?.text || !app.telegram) return;
	const chatId = String(msg.chat.id);
	const isPrivate = msg.chat.type === "private";
	// Personal data is only ever served in the private chat linked to the account.
	const user = isPrivate ? await app.db.users.byTelegramChat(chatId) : null;
	const reply = await app.bots.handleText(msg.text, { platform: "telegram", chatKey: chatId, isPrivate, user, chatId });
	if (reply) await app.telegram.sendMessage(chatId, toTelegramHtml(reply));
}

/** Commands that may take longer than Discord's 3-second reply window. */
const SLOW = new Set(["ask", "analyze", "quote"]);

/**
 * Returns the immediate interaction response. Slow commands are deferred
 * ("thinking…") and their answer is patched in when ready.
 */
export function handleDiscordInteraction(app: App, interaction: Interaction): unknown {
	if (interaction.type === InteractionType.Ping) return { type: ResponseType.Pong };
	if (interaction.type !== InteractionType.Command || !interaction.data) {
		return { type: ResponseType.Message, data: { content: "Unsupported interaction." } };
	}
	const command = interaction.data.name;
	const arg = String(interaction.data.options?.[0]?.value ?? "");
	const ctx = {
		platform: "discord" as const,
		chatKey: interaction.guild_id ?? interaction.channel_id ?? interaction.user?.id ?? "dm",
		isPrivate: false,
		user: null,
	};
	const run = app.bots.handle(command, arg, ctx);
	if (!SLOW.has(command)) {
		// Fast commands resolve synchronously from SQLite, well inside the window.
		return run.then((content) => ({ type: ResponseType.Message, data: { content, allowed_mentions: { parse: [] } } }));
	}
	void run
		.then((content) => editInteractionResponse(interaction.application_id, interaction.token, content))
		.catch((err) => logger.warn("discord follow-up failed", { command, error: errorMessage(err) }));
	return { type: ResponseType.Deferred };
}

/** Slash-command definitions for Discord (personal commands are Telegram-only). */
export function discordCommands() {
	return BOT_COMMANDS.filter((c) => !c.personal).map((c) => ({
		name: c.name,
		description: c.description,
		type: 1,
		options: c.arg ? [{ type: 3, name: c.arg.name, description: c.arg.description, required: c.arg.required }] : [],
	}));
}

/** Command menu shown by Telegram clients. */
export function telegramCommands() {
	return BOT_COMMANDS.map((c) => ({ command: c.name, description: c.description.slice(0, 256) }));
}
