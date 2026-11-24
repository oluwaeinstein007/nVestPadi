/** The signed-in user's own account: profile, notifications, onboarding, security and API tokens. */
import { z } from "zod";
import type { App } from "../../app.js";
import { rateLimiter } from "../../lib/rateLimit.js";
import { toPublicUser } from "../../services/accountService.js";
import { SESSION_TTL_SECONDS } from "../../services/authService.js";
import { sessionCookie } from "../http.js";
import type { Router } from "../router.js";
import { exchangeSchema } from "./shared.js";

export function accountRoutes(r: Router, app: App) {
	const sensitive = rateLimiter(10, 15 * 60_000, "Too many attempts. Wait a few minutes and try again.");
	const tests = rateLimiter(5, 10 * 60_000, "Test notifications are limited to 5 every 10 minutes.");

	r.get("/api/account", (ctx) => app.accounts.overview(ctx.user));

	r.patch("/api/account", async (ctx) => {
		const b = z
			.object({ name: z.string().max(80).optional(), defaultExchange: exchangeSchema.optional() })
			.parse(ctx.body);
		return { user: toPublicUser(await app.accounts.updateProfile(ctx.user, b)) };
	});

	r.put("/api/account/notifications", async (ctx) => {
		const b = z
			.object({
				emailAlerts: z.boolean().optional(),
				dailyDigest: z.boolean().optional(),
				discordWebhookUrl: z.string().max(300).nullable().optional(),
			})
			.parse(ctx.body);
		const updated = await app.accounts.updateNotifications(ctx.user, b);
		return (await app.accounts.overview(updated)).notifications;
	});

	r.post(
		"/api/account/notifications/test",
		async (ctx) => ({ results: await app.accounts.testNotifications(ctx.user) }),
		{
			limit: tests,
		},
	);

	// Telegram is linked by opening a one-time t.me deep link, never by typing a chat id.
	r.post("/api/account/telegram/link", async (ctx) => ({ url: await app.bots.telegramLink(ctx.user) }));
	r.delete("/api/account/telegram", async (ctx) => {
		await app.db.users.update(ctx.user.id, { telegramChatId: null });
		return { linked: false };
	});

	r.post("/api/account/onboarding", (ctx) => {
		const b = z
			.object({ defaultExchange: exchangeSchema, symbols: z.array(z.string().min(1).max(24)).max(20).default([]) })
			.parse(ctx.body);
		return app.accounts.completeOnboarding(ctx.user, b);
	});

	r.post(
		"/api/account/password",
		async (ctx) => {
			const b = z.object({ currentPassword: z.string().min(1), newPassword: z.string() }).parse(ctx.body);
			await app.auth.changePassword(ctx.user, b.currentPassword, b.newPassword, ctx.principal?.sessionId ?? undefined);
			return { ok: true };
		},
		{ limit: sensitive },
	);

	r.get("/api/account/sessions", (ctx) => app.accounts.sessions(ctx.user, ctx.principal?.sessionId ?? undefined));
	r.delete("/api/account/sessions", async (ctx) => ({
		signedOut: await app.accounts.signOutOtherSessions(ctx.user, ctx.principal?.sessionId ?? undefined),
	}));

	r.get("/api/account/tokens", (ctx) => app.accounts.apiTokens(ctx.user));
	r.post("/api/account/tokens", (ctx) => {
		const { name } = z.object({ name: z.string().max(60) }).parse(ctx.body);
		return app.accounts.createApiToken(ctx.user, name);
	});
	r.delete("/api/account/tokens/:id", async (ctx) => {
		await app.accounts.revokeApiToken(ctx.user, Number(ctx.params.id));
		return { revoked: Number(ctx.params.id) };
	});

	r.delete(
		"/api/account",
		async (ctx) => {
			const { password } = z.object({ password: z.string().min(1, "Enter your password to confirm.") }).parse(ctx.body);
			await app.accounts.deleteAccount(ctx.user, password);
			ctx.res.setHeader(
				"Set-Cookie",
				sessionCookie(null, { secure: app.config.auth.secureCookies, maxAgeSeconds: SESSION_TTL_SECONDS }),
			);
			return { deleted: true };
		},
		{ limit: sensitive },
	);
}
