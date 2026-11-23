import type { SQLInputValue } from "node:sqlite";
import type { Exchange } from "../../markets/types.js";
import { type Database, inSeconds } from "../database.js";

type Row = Record<string, SQLInputValue>;

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

export type AuthTokenPurpose = "verify-email" | "reset-password";

/** Accounts, sessions, one-time auth tokens and personal API tokens. All secrets are stored hashed. */
export class UserRepository {
	constructor(private readonly db: Database) {}

	count(): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
	}

	create(input: {
		email: string;
		name: string;
		passwordHash: string;
		role?: Role;
		plan?: PlanId;
		emailVerified?: boolean;
	}): User {
		const r = this.db
			.prepare(
				`INSERT INTO users (email, name, password_hash, role, plan, email_verified_at)
				 VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END)`,
			)
			.run(
				input.email,
				input.name,
				input.passwordHash,
				input.role ?? "member",
				input.plan ?? "free",
				input.emailVerified ? 1 : 0,
			);
		return this.byId(Number(r.lastInsertRowid)) as User;
	}

	byId(id: number): User | null {
		const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
		return row ? toUser(row) : null;
	}

	byEmail(email: string): User | null {
		const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined;
		return row ? toUser(row) : null;
	}

	byBillingCustomer(customerId: string): User | null {
		const row = this.db.prepare("SELECT * FROM users WHERE billing_customer_id = ?").get(customerId) as Row | undefined;
		return row ? toUser(row) : null;
	}

	bySubscription(subscriptionId: string): User | null {
		const row = this.db.prepare("SELECT * FROM users WHERE billing_subscription_id = ?").get(subscriptionId) as
			| Row
			| undefined;
		return row ? toUser(row) : null;
	}

	/** The account the CLI acts as by default: the earliest admin. */
	firstAdmin(): User | null {
		const row = this.db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as
			| Row
			| undefined;
		return row ? toUser(row) : null;
	}

	list(): User[] {
		return (this.db.prepare("SELECT * FROM users ORDER BY id").all() as Row[]).map(toUser);
	}

	passwordHash(id: number): string | null {
		const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as
			| { password_hash: string }
			| undefined;
		return row?.password_hash ?? null;
	}

	update(id: number, patch: UserPatch): User {
		const entries = Object.entries(patch).filter(([k, v]) => k in UPDATABLE && v !== undefined);
		if (entries.length > 0) {
			const sets = entries.map(([k]) => `${UPDATABLE[k as keyof typeof UPDATABLE]} = ?`).join(", ");
			const values = entries.map(([, v]) => (typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue)));
			this.db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);
		}
		return this.byId(id) as User;
	}

	setPassword(id: number, passwordHash: string) {
		this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
	}

	touchLogin(id: number) {
		this.db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
	}

	delete(id: number): boolean {
		return Number(this.db.prepare("DELETE FROM users WHERE id = ?").run(id).changes) > 0;
	}

	/** Hand watchlist/alert rows created before accounts existed (v2.0) to this user. */
	claimUnownedData(userId: number): { watchlist: number; alerts: number } {
		return this.db.transaction(() => ({
			watchlist: Number(this.db.prepare("UPDATE watchlist SET user_id = ? WHERE user_id IS NULL").run(userId).changes),
			alerts: Number(this.db.prepare("UPDATE alerts SET user_id = ? WHERE user_id IS NULL").run(userId).changes),
		}));
	}

	// -- Sessions ----------------------------------------------------------------

	createSession(id: string, userId: number, ttlSeconds: number, meta: { userAgent?: string; ip?: string }) {
		this.db
			.prepare("INSERT INTO sessions (id, user_id, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))")
			.run(id, userId, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, inSeconds(ttlSeconds));
	}

	/** The live session's user, or null when unknown or expired. */
	sessionUser(id: string): { user: User; lastSeenAt: string } | null {
		const row = this.db
			.prepare(
				`SELECT u.*, s.last_seen_at AS session_last_seen FROM sessions s JOIN users u ON u.id = s.user_id
				 WHERE s.id = ? AND s.expires_at > datetime('now')`,
			)
			.get(id) as Row | undefined;
		return row ? { user: toUser(row), lastSeenAt: String(row.session_last_seen) } : null;
	}

	/** Sliding expiry: extend a session that is still in use. */
	touchSession(id: string, ttlSeconds: number) {
		this.db
			.prepare("UPDATE sessions SET last_seen_at = datetime('now'), expires_at = datetime('now', ?) WHERE id = ?")
			.run(inSeconds(ttlSeconds), id);
	}

	deleteSession(id: string) {
		this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
	}

	/** Sign out everywhere, optionally keeping the current session. */
	deleteSessions(userId: number, exceptId?: string): number {
		return Number(
			this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, exceptId ?? "").changes,
		);
	}

	listSessions(userId: number): SessionInfo[] {
		return this.db
			.prepare(
				`SELECT id, user_agent AS userAgent, ip, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
				 FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY last_seen_at DESC`,
			)
			.all(userId) as unknown as SessionInfo[];
	}

	purgeExpired(): number {
		return this.db.transaction(
			() =>
				Number(this.db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes) +
				Number(this.db.prepare("DELETE FROM auth_tokens WHERE expires_at <= datetime('now')").run().changes),
		);
	}

	// -- One-time tokens (email verification, password reset) ----------------------

	createAuthToken(id: string, userId: number, purpose: AuthTokenPurpose, ttlSeconds: number) {
		this.db.transaction(() => {
			// Only the newest link of each kind works.
			this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?").run(userId, purpose);
			this.db
				.prepare("INSERT INTO auth_tokens (id, user_id, purpose, expires_at) VALUES (?, ?, ?, datetime('now', ?))")
				.run(id, userId, purpose, inSeconds(ttlSeconds));
		});
	}

	/** Single use: the token is deleted whether or not it was still valid. */
	consumeAuthToken(id: string, purpose: AuthTokenPurpose): number | null {
		return this.db.transaction(() => {
			const row = this.db
				.prepare("SELECT user_id, expires_at > datetime('now') AS live FROM auth_tokens WHERE id = ? AND purpose = ?")
				.get(id, purpose) as { user_id: number; live: number } | undefined;
			if (!row) return null;
			this.db.prepare("DELETE FROM auth_tokens WHERE id = ?").run(id);
			return row.live ? row.user_id : null;
		});
	}

	// -- Personal API tokens -------------------------------------------------------

	createApiToken(userId: number, name: string, tokenHash: string, prefix: string): ApiTokenInfo {
		const r = this.db
			.prepare("INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?)")
			.run(userId, name, tokenHash, prefix);
		return this.listApiTokens(userId).find((t) => t.id === Number(r.lastInsertRowid)) as ApiTokenInfo;
	}

	apiTokenUser(tokenHash: string): User | null {
		const row = this.db
			.prepare("SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?")
			.get(tokenHash) as Row | undefined;
		if (!row) return null;
		this.db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(Number(row.token_id));
		return toUser(row);
	}

	listApiTokens(userId: number): ApiTokenInfo[] {
		return this.db
			.prepare(
				`SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt
				 FROM api_tokens WHERE user_id = ? ORDER BY id DESC`,
			)
			.all(userId) as unknown as ApiTokenInfo[];
	}

	deleteApiToken(userId: number, id: number): boolean {
		return Number(this.db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
	}
}

function toUser(r: Row): User {
	const str = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : String(v));
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
		emailAlerts: Boolean(r.email_alerts),
		telegramChatId: str(r.telegram_chat_id),
		discordWebhookUrl: str(r.discord_webhook_url),
		billingCustomerId: str(r.billing_customer_id),
		billingSubscriptionId: str(r.billing_subscription_id),
		createdAt: String(r.created_at),
		lastLoginAt: str(r.last_login_at),
	};
}
