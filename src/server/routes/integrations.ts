/** Inbound webhooks from chat platforms. Both are public but authenticated by the platform's secret/signature. */
import type { App } from "../../app.js";
import { type Interaction, verifyDiscordRequest } from "../../integrations/discord.js";
import { handleDiscordInteraction, handleTelegramUpdate } from "../../integrations/handlers.js";
import type { TelegramUpdate } from "../../integrations/telegram.js";
import { safeEqual } from "../../lib/crypto.js";
import { NotFoundError, UnauthorizedError } from "../../lib/errors.js";
import { errorMessage, logger } from "../../lib/logger.js";
import type { Router } from "../router.js";

export function integrationRoutes(r: Router, app: App) {
	r.post(
		"/api/integrations/telegram",
		(ctx) => {
			const secret = app.config.telegram?.webhookSecret;
			if (!secret) throw new NotFoundError();
			const given = ctx.req.headers["x-telegram-bot-api-secret-token"];
			if (typeof given !== "string" || !safeEqual(given, secret)) throw new UnauthorizedError("Invalid secret");
			// Acknowledge at once; Telegram retries slow webhooks, which would duplicate replies.
			void handleTelegramUpdate(app, ctx.body as TelegramUpdate).catch((err) =>
				logger.warn("telegram update failed", { error: errorMessage(err) }),
			);
			return { ok: true };
		},
		{ access: "public", csrf: false },
	);

	r.post(
		"/api/integrations/discord",
		(ctx) => {
			const discord = app.config.discord.app;
			if (!discord) throw new NotFoundError();
			const sig = ctx.req.headers["x-signature-ed25519"];
			const ts = ctx.req.headers["x-signature-timestamp"];
			if (!verifyDiscordRequest(discord.publicKey, sig as string | undefined, ts as string | undefined, ctx.rawBody)) {
				throw new UnauthorizedError("Invalid request signature");
			}
			return handleDiscordInteraction(app, ctx.body as Interaction);
		},
		{ access: "public", csrf: false },
	);
}
