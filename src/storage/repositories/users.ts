import type { Exchange } from "../../markets/types.js";
import type { Database, Param, Row } from "../database.js";
import { inSeconds, timestamp } from "../driver.js";
import { flag, str } from "../rows.js";

export type Role = "admin" | "member";
export type PlanId = "free" | "pro";

export interface User {
	id: number;
	email: string;
	name: string;
	role: Role;
	plan: PlanId;
	planRenewsAt: string | null;
	emailVerifiedAt: string | null;
	onboardedAt: string | null;
	defaultExchange: Exchange;
	emailAlerts: boolean;
	telegramChatId: string | null;
	discordWebhookUrl: string | null;
	billingCustomerId: string | null;
	billingSubscriptionId: string | null;
	/** Receive a daily wrap-up of their watchlist and portfolio after their market closes. */
	dailyDigest: boolean;
	lastDigestOn: string | null;
	createdAt: string;
	lastLoginAt: string | null;
}

/** Fields that may be changed through `update`, mapped to their columns. */
const UPDATABLE = {
	name: "name",
	email: "email",
	role: "role",
	plan: "plan",
	planRenewsAt: "plan_renews_at",
	emailVerifiedAt: "email_verified_at",
	onboardedAt: "onboarded_at",
	defaultExchange: "default_exchange",
	emailAlerts: "email_alerts",
	telegramChatId: "telegram_chat_id",
	discordWebhookUrl: "discord_webhook_url",
	billingCustomerId: "billing_customer_id",
	billingSubscriptionId: "billing_subscription_id",
	dailyDigest: "daily_digest",
	lastDigestOn: "last_digest_on",
} as const satisfies Partial<Record<keyof User, string>>;
export type UserPatch = Partial<Pick<User, keyof typeof UPDATABLE>>;

export interface SessionInfo {
	id: string;
	userAgent: string | null;
	ip: string | null;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

export interface ApiTokenInfo {
	id: number;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
}

export type AuthTokenPurpose = "verify-email" | "reset-password" | "telegram-link";

/** Accounts, sessions, one-time auth tokens and personal API tokens. All secrets are stored hashed. */
export class UserRepository {
	constructor(private readonly db: Database) {}

	count(): Promise<number> {
		return this.db.count("SELECT COUNT(*) AS n FROM users");
	}

	async create(input: {
		email: string;
		name: string;
		passwordHash: string;
		role?: Role;
		plan?: PlanId;
		emailVerified?: boolean;
	}): Promise<User> {
		const row = await this.db.get(
			`INSERT INTO users (email, name, password_hash, role, plan, email_verified_at)
			 VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
			[
				input.email,
				input.name,
				input.passwordHash,
				input.role ?? "member",
				input.plan ?? "free",
				input.emailVerified ? timestamp() : null,
			],
		);
		return (await this.byId(Number(row?.id))) as User;
	}

	private async one(where: string, params: Param[]): Promise<User | null> {
		const row = await this.db.get(`SELECT * FROM users WHERE ${where}`, params);
		return row ? toUser(row) : null;
	}

	byId(id: number): Promise<User | null> {
		return this.one("id = ?", [id]);
	}

	/** Email addresses are unique and matched case-insensitively. */
	byEmail(email: string): Promise<User | null> {
		return this.one("LOWER(email) = LOWER(?)", [email]);
	}

	byBillingCustomer(customerId: string): Promise<User | null> {
		return this.one("billing_customer_id = ?", [customerId]);
	}

	bySubscription(subscriptionId: string): Promise<User | null> {
		return this.one("billing_subscription_id = ?", [subscriptionId]);
	}

	/** The account the CLI acts as by default: the earliest admin. */
	firstAdmin(): Promise<User | null> {
		return this.one("role = 'admin' ORDER BY id LIMIT 1", []);
	}

	/** Users who want a daily digest and whose default market is `exchange`, not yet sent `day`. */
	async digestRecipients(exchange: Exchange, day: string): Promise<User[]> {
		const rows = await this.db.all(
			`SELECT * FROM users WHERE daily_digest = 1 AND default_exchange = ?
			 AND (last_digest_on IS NULL OR last_digest_on < ?) ORDER BY id`,
			[exchange, day],
		);
		return rows.map(toUser);
	}

	byTelegramChat(chatId: string): Promise<User | null> {
		return this.one("telegram_chat_id = ?", [chatId]);
	}

	async list(): Promise<User[]> {
		return (await this.db.all("SELECT * FROM users ORDER BY id")).map(toUser);
	}

	async passwordHash(id: number): Promise<string | null> {
		const row = await this.db.get("SELECT password_hash FROM users WHERE id = ?", [id]);
		return str(row?.password_hash);
	}

	async update(id: number, patch: UserPatch): Promise<User> {
		const entries = Object.entries(patch).filter(([k, v]) => k in UPDATABLE && v !== undefined);
		if (entries.length > 0) {
			const sets = entries.map(([k]) => `${UPDATABLE[k as keyof typeof UPDATABLE]} = ?`).join(", ");
			const values = entries.map(([, v]) => (typeof v === "boolean" ? (v ? 1 : 0) : (v as Param)));
			await this.db.run(`UPDATE users SET ${sets} WHERE id = ?`, [...values, id]);
		}
		return (await this.byId(id)) as User;
	}

	async setPassword(id: number, passwordHash: string): Promise<void> {
		await this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id]);
	}

	async touchLogin(id: number): Promise<void> {
		await this.db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [timestamp(), id]);
	}

	async delete(id: number): Promise<boolean> {
		return (await this.db.run("DELETE FROM users WHERE id = ?", [id])).changes > 0;
	}

	/** Hand watchlist/alert rows created before accounts existed (v2.0) to this user. */
	claimUnownedData(userId: number): Promise<{ watchlist: number; alerts: number }> {
		return this.db.transaction(async () => ({
			watchlist: (await this.db.run("UPDATE watchlist SET user_id = ? WHERE user_id IS NULL", [userId])).changes,
			alerts: (await this.db.run("UPDATE alerts SET user_id = ? WHERE user_id IS NULL", [userId])).changes,
		}));
	}

	// -- Sessions ----------------------------------------------------------------

	async createSession(
		id: string,
		userId: number,
		ttlSeconds: number,
		meta: { userAgent?: string; ip?: string },
	): Promise<void> {
		await this.db.run("INSERT INTO sessions (id, user_id, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)", [
			id,
			userId,
			meta.userAgent?.slice(0, 300) ?? null,
			meta.ip ?? null,
			inSeconds(ttlSeconds),
		]);
	}

	/** The live session's user, or null when unknown or expired. */
	async sessionUser(id: string): Promise<{ user: User; lastSeenAt: string } | null> {
		const row = await this.db.get(
			`SELECT u.*, s.last_seen_at AS session_last_seen FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.id = ? AND s.expires_at > ?`,
			[id, timestamp()],
		);
		return row ? { user: toUser(row), lastSeenAt: String(row.session_last_seen) } : null;
	}

	/** Sliding expiry: extend a session that is still in use. */
	async touchSession(id: string, ttlSeconds: number): Promise<void> {
		await this.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [
			timestamp(),
			inSeconds(ttlSeconds),
			id,
		]);
	}

	async deleteSession(id: string): Promise<void> {
		await this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
	}

	/** Sign out everywhere, optionally keeping the current session. */
	async deleteSessions(userId: number, exceptId?: string): Promise<number> {
		return (await this.db.run("DELETE FROM sessions WHERE user_id = ? AND id != ?", [userId, exceptId ?? ""])).changes;
	}

	async listSessions(userId: number): Promise<SessionInfo[]> {
		const rows = await this.db.all(
			`SELECT id, user_agent, ip, created_at, last_seen_at, expires_at
			 FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
			[userId, timestamp()],
		);
		return rows.map((r) => ({
			id: String(r.id),
			userAgent: str(r.user_agent),
			ip: str(r.ip),
			createdAt: String(r.created_at),
			lastSeenAt: String(r.last_seen_at),
			expiresAt: String(r.expires_at),
		}));
	}

	purgeExpired(): Promise<number> {
		return this.db.transaction(async () => {
			const now = timestamp();
			const sessions = await this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
			const tokens = await this.db.run("DELETE FROM auth_tokens WHERE expires_at <= ?", [now]);
			return sessions.changes + tokens.changes;
		});
	}

	// -- One-time tokens (email verification, password reset) ----------------------

	createAuthToken(id: string, userId: number, purpose: AuthTokenPurpose, ttlSeconds: number): Promise<void> {
		return this.db.transaction(async () => {
			// Only the newest link of each kind works.
			await this.db.run("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?", [userId, purpose]);
			await this.db.run("INSERT INTO auth_tokens (id, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)", [
				id,
				userId,
				purpose,
				inSeconds(ttlSeconds),
			]);
		});
	}

	/**
	 * Single use: the token is deleted whether or not it was still valid. One DELETE ... RETURNING, so two
	 * simultaneous requests can't both redeem it.
	 */
	async consumeAuthToken(id: string, purpose: AuthTokenPurpose): Promise<number | null> {
		const row = await this.db.get(
			"DELETE FROM auth_tokens WHERE id = ? AND purpose = ? RETURNING user_id, expires_at",
			[id, purpose],
		);
		if (!row) return null;
		return String(row.expires_at) > timestamp() ? Number(row.user_id) : null;
	}

	// -- Personal API tokens -------------------------------------------------------

	async createApiToken(userId: number, name: string, tokenHash: string, prefix: string): Promise<ApiTokenInfo> {
		const row = await this.db.get(
			"INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?) RETURNING id",
			[userId, name, tokenHash, prefix],
		);
		return (await this.listApiTokens(userId)).find((t) => t.id === Number(row?.id)) as ApiTokenInfo;
	}

	async apiTokenUser(tokenHash: string): Promise<User | null> {
		const row = await this.db.get(
			"SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?",
			[tokenHash],
		);
		if (!row) return null;
		await this.db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [timestamp(), Number(row.token_id)]);
		return toUser(row);
	}

	async listApiTokens(userId: number): Promise<ApiTokenInfo[]> {
		const rows = await this.db.all(
			"SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC",
			[userId],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			name: String(r.name),
			prefix: String(r.prefix),
			createdAt: String(r.created_at),
			lastUsedAt: str(r.last_used_at),
		}));
	}

	async deleteApiToken(userId: number, id: number): Promise<boolean> {
		return (await this.db.run("DELETE FROM api_tokens WHERE id = ? AND user_id = ?", [id, userId])).changes > 0;
	}
}

function toUser(r: Row): User {
	return {
		id: Number(r.id),
		email: String(r.email),
		name: String(r.name),
		role: r.role as Role,
		plan: r.plan as PlanId,
		planRenewsAt: str(r.plan_renews_at),
		emailVerifiedAt: str(r.email_verified_at),
		onboardedAt: str(r.onboarded_at),
		defaultExchange: r.default_exchange as Exchange,
		emailAlerts: flag(r.email_alerts),
		telegramChatId: str(r.telegram_chat_id),
		discordWebhookUrl: str(r.discord_webhook_url),
		billingCustomerId: str(r.billing_customer_id),
		billingSubscriptionId: str(r.billing_subscription_id),
		dailyDigest: flag(r.daily_digest),
		lastDigestOn: str(r.last_digest_on),
		createdAt: String(r.created_at),
		lastLoginAt: str(r.last_login_at),
	};
}
