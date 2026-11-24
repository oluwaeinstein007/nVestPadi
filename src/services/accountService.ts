/**
 * Everything a signed-in user manages about their own account: profile,
 * notification channels, onboarding, plan usage, sessions, API tokens and
 * deletion.
 */
import type { AppMode } from "../config.js";
import { hashToken, randomToken } from "../lib/crypto.js";
import { NotFoundError, PlanLimitError, ValidationError } from "../lib/errors.js";
import { errorMessage, logger } from "../lib/logger.js";
import type { Exchange } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { ApiTokenInfo, SessionInfo, User } from "../storage/repositories/users.js";
import { API_TOKEN_PREFIX, type AuthService, sqlNow } from "./authService.js";
import type { DeliveryResult, Notifier } from "./notifier.js";
import { PLANS, currentPlan, limitsFor } from "./plans.js";
import type { WatchlistService } from "./watchlistService.js";

const MAX_API_TOKENS = 10;
const DISCORD_WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

/** What the API returns about the signed-in user — never secrets or billing internals. */
export interface PublicUser {
	id: number;
	email: string;
	name: string;
	role: User["role"];
	emailVerified: boolean;
	onboarded: boolean;
	defaultExchange: Exchange;
	createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		emailVerified: Boolean(user.emailVerifiedAt),
		onboarded: Boolean(user.onboardedAt),
		defaultExchange: user.defaultExchange,
		createdAt: user.createdAt,
	};
}

export class AccountService {
	constructor(
		private readonly db: Database,
		private readonly auth: AuthService,
		private readonly notifier: Notifier,
		private readonly watchlists: WatchlistService,
		private readonly mode: AppMode,
	) {}

	/** Profile, plan, limits (null = unlimited) and today's usage. */
	async overview(user: User) {
		const limits = limitsFor(user, this.mode);
		const planId = currentPlan(user);
		const finite = (n: number) => (Number.isFinite(n) ? n : null);
		const [watchlist, holdings, activeAlerts, aiQuestionsToday] = await Promise.all([
			this.db.watchlist.count(user.id),
			this.db.holdings.count(user.id),
			this.db.alerts.countActive(user.id),
			this.db.usage.get(user.id, "ai_questions"),
		]);
		return {
			user: toPublicUser(user),
			plan: {
				id: this.mode === "self-hosted" ? "self-hosted" : planId,
				name: this.mode === "self-hosted" ? "Self-hosted" : PLANS[planId].name,
				renewsAt: planId === "pro" ? user.planRenewsAt : null,
				managed: Boolean(user.billingSubscriptionId),
			},
			limits: {
				watchlist: finite(limits.watchlist),
				holdings: finite(limits.holdings),
				activeAlerts: finite(limits.activeAlerts),
				aiQuestionsPerDay: finite(limits.aiQuestionsPerDay),
				discordAlerts: limits.discordAlerts,
			},
			usage: { watchlist, holdings, activeAlerts, aiQuestionsToday },
			notifications: {
				emailAlerts: user.emailAlerts,
				dailyDigest: user.dailyDigest,
				telegramLinked: Boolean(user.telegramChatId),
				discordWebhookUrl: user.discordWebhookUrl,
				activeChannels: this.notifier.channelsFor(user),
				telegramAvailable: this.notifier.telegramAvailable,
				emailDelivers: this.notifier.emailDelivers,
			},
		};
	}

	updateProfile(user: User, patch: { name?: string; defaultExchange?: Exchange }): Promise<User> {
		const name = patch.name?.trim();
		if (patch.name !== undefined && !name) throw new ValidationError("Name can't be empty.");
		return this.db.users.update(user.id, { name, defaultExchange: patch.defaultExchange });
	}

	updateNotifications(
		user: User,
		patch: { emailAlerts?: boolean; dailyDigest?: boolean; discordWebhookUrl?: string | null },
	): Promise<User> {
		const discord = patch.discordWebhookUrl?.trim() || null;
		if (discord && !DISCORD_WEBHOOK.test(discord)) {
			throw new ValidationError("That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…).");
		}
		if (discord && !limitsFor(user, this.mode).discordAlerts) {
			throw new PlanLimitError("Discord alerts are part of Pro. Upgrade to connect a webhook.");
		}
		return this.db.users.update(user.id, {
			emailAlerts: patch.emailAlerts,
			dailyDigest: patch.dailyDigest,
			discordWebhookUrl: patch.discordWebhookUrl === undefined ? undefined : discord,
		});
	}

	async testNotifications(user: User): Promise<DeliveryResult[]> {
		if (this.notifier.channelsFor(user).length === 0) {
			throw new ValidationError("No delivery channel is active yet. Verify your email or connect Telegram first.");
		}
		return this.notifier.deliver(user, ["🔔 Test alert from nVestPadi — your alerts will arrive here."], {
			test: true,
		});
	}

	/** Finish onboarding: save preferences and seed the watchlist (best effort per symbol). */
	async completeOnboarding(user: User, input: { defaultExchange: Exchange; symbols: string[] }) {
		const added: string[] = [];
		const failed: string[] = [];
		for (const raw of input.symbols.slice(0, 20)) {
			const [maybeExchange, maybeSymbol] = raw.includes(":") ? raw.split(":") : [undefined, raw];
			try {
				const t = await this.watchlists.add(user, maybeSymbol as string, (maybeExchange as Exchange) ?? undefined);
				added.push(`${t.exchange}:${t.symbol}`);
			} catch (err) {
				if (err instanceof PlanLimitError) break;
				logger.debug("onboarding watch failed", { symbol: raw, error: errorMessage(err) });
				failed.push(raw);
			}
		}
		const updated = await this.db.users.update(user.id, {
			defaultExchange: input.defaultExchange,
			onboardedAt: sqlNow(),
		});
		return { user: toPublicUser(updated), added, failed };
	}

	/** AI questions are metered per day. Returns a function that refunds the use if the call fails. */
	async meterAiQuestion(user: User): Promise<() => Promise<void>> {
		const limit = limitsFor(user, this.mode).aiQuestionsPerDay;
		if (!Number.isFinite(limit)) return async () => undefined;
		if (!(await this.db.usage.consume(user.id, "ai_questions", limit))) {
			throw new PlanLimitError(
				`You've used today's ${limit} AI questions. They reset at midnight UTC — or upgrade to Pro for more.`,
			);
		}
		return () => this.db.usage.refund(user.id, "ai_questions");
	}

	// -- Sessions & API tokens -------------------------------------------------------

	async sessions(
		user: User,
		currentSessionId?: string,
	): Promise<(Omit<SessionInfo, "id"> & { id: string; current: boolean })[]> {
		// Expose a short, non-secret handle rather than the stored hash.
		return (await this.db.users.listSessions(user.id)).map((s) => ({
			...s,
			id: s.id.slice(0, 12),
			current: s.id === currentSessionId,
		}));
	}

	signOutOtherSessions(user: User, currentSessionId?: string): Promise<number> {
		return this.db.users.deleteSessions(user.id, currentSessionId);
	}

	apiTokens(user: User): Promise<ApiTokenInfo[]> {
		return this.db.users.listApiTokens(user.id);
	}

	/** The plaintext token is returned once and never stored. */
	async createApiToken(user: User, name: string): Promise<{ token: string; info: ApiTokenInfo }> {
		const label = name.trim().slice(0, 60);
		if (!label) throw new ValidationError("Give the token a name, e.g. “laptop CLI”.");
		if ((await this.db.users.listApiTokens(user.id)).length >= MAX_API_TOKENS) {
			throw new ValidationError(`You can have up to ${MAX_API_TOKENS} API tokens. Revoke one first.`);
		}
		const token = randomToken(32, API_TOKEN_PREFIX);
		const info = await this.db.users.createApiToken(
			user.id,
			label,
			hashToken(token),
			token.slice(0, API_TOKEN_PREFIX.length + 6),
		);
		return { token, info };
	}

	async revokeApiToken(user: User, id: number): Promise<void> {
		if (!(await this.db.users.deleteApiToken(user.id, id))) throw new NotFoundError("Token not found");
	}

	/** Permanently delete the account and everything it owns (cascades in SQLite). */
	async deleteAccount(user: User, password: string) {
		await this.auth.confirmPassword(user, password);
		if (
			user.role === "admin" &&
			(await this.db.users.list()).filter((u) => u.role === "admin").length === 1 &&
			(await this.db.users.count()) > 1
		) {
			throw new ValidationError("You're the only admin. Make someone else an admin before deleting your account.");
		}
		await this.db.users.delete(user.id);
	}
}
