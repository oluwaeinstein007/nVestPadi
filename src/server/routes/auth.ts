/** Sign-up, sign-in, sign-out, email verification and password reset. */
import { z } from "zod";
import type { App } from "../../app.js";
import { ValidationError } from "../../lib/errors.js";
import { rateLimiter } from "../../lib/rateLimit.js";
import { toPublicUser } from "../../services/accountService.js";
import { type ClientMeta, SESSION_TTL_SECONDS } from "../../services/authService.js";
import { PLANS } from "../../services/plans.js";
import { type RequestContext, sessionCookie } from "../http.js";
import type { Router } from "../router.js";
import { emailSchema } from "./shared.js";

const TOO_MANY = "Too many attempts. Wait a few minutes and try again.";

export function authRoutes(r: Router, app: App) {
	const perIp = rateLimiter(20, 15 * 60_000, TOO_MANY);
	const perEmail = rateLimiter(8, 15 * 60_000, TOO_MANY);
	const emails = rateLimiter(
		3,
		15 * 60_000,
		"We just sent you an email. Check your inbox (and spam) before asking again.",
	);

	const setSession = (ctx: RequestContext, token: string | null) =>
		ctx.res.setHeader(
			"Set-Cookie",
			sessionCookie(token, { secure: app.config.auth.secureCookies, maxAgeSeconds: SESSION_TTL_SECONDS }),
		);
	const meta = (ctx: RequestContext): ClientMeta => ({ userAgent: ctx.req.headers["user-agent"], ip: ctx.ip });

	// Everything the browser needs to render auth pages and decide where to go.
	r.get(
		"/api/auth/session",
		async (ctx) => ({
			user: ctx.principal ? toPublicUser(ctx.principal.user) : null,
			mode: app.config.mode,
			signup: await app.auth.signupStatus(),
			billing: app.billing.enabled,
			emailDelivers: app.mailer.delivers,
			plans: Object.values(PLANS).map(({ id, name, priceLabel, tagline, limits }) => ({
				id,
				name,
				priceLabel,
				tagline,
				limits,
			})),
		}),
		{ access: "public" },
	);

	r.post(
		"/api/auth/signup",
		async (ctx) => {
			const b = z
				.object({
					name: z.string().trim().min(1, "Tell us your name.").max(80),
					email: emailSchema,
					password: z.string(),
					acceptTerms: z.boolean().optional(),
				})
				.parse(ctx.body);
			if (app.config.mode === "cloud" && !b.acceptTerms) {
				throw new ValidationError("Please accept the Terms and Privacy Policy to create an account.");
			}
			perEmail(b.email);
			const { user, token } = await app.auth.signup(b, meta(ctx));
			setSession(ctx, token);
			return { user: toPublicUser(user) };
		},
		{ access: "public", limit: perIp },
	);

	r.post(
		"/api/auth/login",
		async (ctx) => {
			const b = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password.") }).parse(ctx.body);
			perEmail(b.email);
			const { user, token } = await app.auth.login(b, meta(ctx));
			setSession(ctx, token);
			return { user: toPublicUser(user) };
		},
		{ access: "public", limit: perIp },
	);

	r.post(
		"/api/auth/logout",
		async (ctx) => {
			if (ctx.sessionToken) await app.auth.logout(ctx.sessionToken);
			setSession(ctx, null);
			return { ok: true };
		},
		{ access: "public" },
	);

	r.post(
		"/api/auth/forgot-password",
		async (ctx) => {
			const { email } = z.object({ email: emailSchema }).parse(ctx.body);
			emails(email);
			await app.auth.requestPasswordReset(email);
			return { ok: true };
		},
		{ access: "public", limit: perIp },
	);

	r.post(
		"/api/auth/reset-password",
		async (ctx) => {
			const b = z.object({ token: z.string().min(10), password: z.string() }).parse(ctx.body);
			const { user, token } = await app.auth.resetPassword(b.token, b.password, meta(ctx));
			setSession(ctx, token);
			return { user: toPublicUser(user) };
		},
		{ access: "public", limit: perIp },
	);

	r.post(
		"/api/auth/verify-email",
		async (ctx) => {
			const { token } = z.object({ token: z.string().min(10) }).parse(ctx.body);
			return { user: toPublicUser(await app.auth.verifyEmail(token)) };
		},
		{ access: "public", limit: perIp },
	);

	r.post("/api/auth/resend-verification", async (ctx) => {
		emails(ctx.user.email);
		await app.auth.sendVerification(ctx.user);
		return { ok: true, delivered: app.mailer.delivers };
	});
}
