/**
 * Accounts and credentials: sign-up, sign-in, sessions, email verification,
 * password reset and personal API tokens.
 *
 * - Passwords are hashed with scrypt; unknown emails still run a hash so
 *   timing doesn't reveal which accounts exist.
 * - Session, reset and API tokens are random 256-bit values stored as SHA-256
 *   hashes, so a database leak can't be replayed.
 * - Sessions last 30 days and slide forward while in use; changing or
 *   resetting a password signs out every other session.
 */
import type { Config } from "../config.js";
import { dummyPasswordHash, hashPassword, hashToken, randomToken, verifyPassword } from "../lib/crypto.js";
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from "../lib/errors.js";
import { errorMessage, logger } from "../lib/logger.js";
import type { Database } from "../storage/database.js";
import type { PlanId, Role, User } from "../storage/repositories/users.js";
import * as emails from "./emails.js";
import type { Mailer } from "./mailer.js";

export const SESSION_TTL_SECONDS = 30 * 86_400;
const VERIFY_TTL_SECONDS = 48 * 3600;
const RESET_TTL_SECONDS = 3600;
/** Avoid a write on every request: only extend sessions idle for longer than this. */
const SESSION_TOUCH_MS = 10 * 60_000;
export const API_TOKEN_PREFIX = "nvp_";

export interface ClientMeta {
	userAgent?: string;
	ip?: string;
}

export interface SignupStatus {
	/** Whether a visitor may create an account right now. */
	open: boolean;
	/** No accounts yet: the next sign-up becomes the server's owner (admin). */
	needsOwner: boolean;
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function validatePassword(password: string, email?: string) {
	if (password.length < 8) throw new ValidationError("Password must be at least 8 characters.");
	if (password.length > 128) throw new ValidationError("Password must be at most 128 characters.");
	if (email && password.toLowerCase() === normalizeEmail(email)) {
		throw new ValidationError("Password can't be the same as your email.");
	}
}

export class AuthService {
	constructor(
		private readonly db: Database,
		private readonly mailer: Mailer,
		private readonly config: Pick<Config, "mode" | "appUrl" | "auth">,
	) {}

	signupStatus(): SignupStatus {
		const needsOwner = this.db.users.count() === 0;
		const allow = this.config.auth.allowSignup ?? this.config.mode === "cloud";
		return { open: needsOwner || allow, needsOwner };
	}

	/**
	 * Create an account. The first account on a server becomes its admin and
	 * inherits any watchlist/alerts created before accounts existed.
	 */
	async createAccount(input: {
		email: string;
		name: string;
		password: string;
		role?: Role;
		plan?: PlanId;
		emailVerified?: boolean;
	}): Promise<User> {
		const email = normalizeEmail(input.email);
		validatePassword(input.password, email);
		if (this.db.users.byEmail(email))
			throw new ConflictError("An account with this email already exists. Try signing in.");
		const passwordHash = await hashPassword(input.password);
		const user = this.db.transaction(() => {
			const first = this.db.users.count() === 0;
			const created = this.db.users.create({
				email,
				name: input.name.trim() || email.split("@")[0] || email,
				passwordHash,
				role: first ? "admin" : (input.role ?? "member"),
				plan: input.plan,
				// Nobody could click a verification link that only goes to the log.
				emailVerified: input.emailVerified ?? !this.mailer.delivers,
			});
			if (first) {
				const claimed = this.db.users.claimUnownedData(created.id);
				if (claimed.watchlist || claimed.alerts) logger.info("first account claimed existing data", claimed);
			}
			return created;
		});
		if (!user.emailVerifiedAt) {
			// The account exists either way; the user can ask for another link from the app.
			await this.sendVerification(user).catch((err) =>
				logger.warn("verification email failed", { userId: user.id, error: errorMessage(err) }),
			);
		}
		return user;
	}

	async signup(input: { email: string; name: string; password: string }, meta: ClientMeta) {
		const status = this.signupStatus();
		if (!status.open)
			throw new ForbiddenError("Sign-up is closed on this server. Ask its owner to create an account for you.");
		const user = await this.createAccount(input);
		this.db.users.touchLogin(user.id);
		return { user, token: this.createSession(user.id, meta) };
	}

	async login(input: { email: string; password: string }, meta: ClientMeta) {
		const user = this.db.users.byEmail(normalizeEmail(input.email));
		const hash = user ? this.db.users.passwordHash(user.id) : null;
		const ok = await verifyPassword(input.password, hash ?? (await dummyPasswordHash()));
		if (!user || !hash || !ok) throw new UnauthorizedError("Incorrect email or password.");
		this.db.users.touchLogin(user.id);
		return { user, token: this.createSession(user.id, meta) };
	}

	createSession(userId: number, meta: ClientMeta): string {
		const token = randomToken();
		this.db.users.createSession(hashToken(token), userId, SESSION_TTL_SECONDS, meta);
		return token;
	}

	/** Resolve a session cookie to its user, extending the session while it's in use. */
	authenticateSession(token: string): { user: User; sessionId: string } | null {
		const sessionId = hashToken(token);
		const found = this.db.users.sessionUser(sessionId);
		if (!found) return null;
		if (Date.now() - Date.parse(`${found.lastSeenAt.replace(" ", "T")}Z`) > SESSION_TOUCH_MS) {
			this.db.users.touchSession(sessionId, SESSION_TTL_SECONDS);
		}
		return { user: found.user, sessionId };
	}

	authenticateApiToken(token: string): User | null {
		if (!token.startsWith(API_TOKEN_PREFIX)) return null;
		return this.db.users.apiTokenUser(hashToken(token));
	}

	logout(token: string) {
		this.db.users.deleteSession(hashToken(token));
	}

	// -- Email verification --------------------------------------------------------

	async sendVerification(user: User) {
		if (user.emailVerifiedAt) return;
		const token = randomToken();
		this.db.users.createAuthToken(hashToken(token), user.id, "verify-email", VERIFY_TTL_SECONDS);
		await this.mailer.send(
			emails.verifyEmail(
				user.email,
				user.name,
				`${this.config.appUrl}/verify-email?token=${encodeURIComponent(token)}`,
			),
		);
	}

	verifyEmail(token: string): User {
		const userId = this.db.users.consumeAuthToken(hashToken(token), "verify-email");
		if (!userId) throw new ValidationError("This verification link is invalid or has expired. Request a new one.");
		return this.db.users.update(userId, { emailVerifiedAt: sqlNow() });
	}

	// -- Password reset --------------------------------------------------------------

	/** Always succeeds from the caller's point of view, so it can't be used to probe for accounts. */
	async requestPasswordReset(email: string) {
		const user = this.db.users.byEmail(normalizeEmail(email));
		if (!user) return;
		const token = randomToken();
		this.db.users.createAuthToken(hashToken(token), user.id, "reset-password", RESET_TTL_SECONDS);
		await this.mailer
			.send(
				emails.passwordReset(
					user.email,
					user.name,
					`${this.config.appUrl}/reset-password?token=${encodeURIComponent(token)}`,
				),
			)
			// Failing loudly here would reveal that the account exists.
			.catch((err) => logger.error("password reset email failed", { userId: user.id, error: errorMessage(err) }));
	}

	async resetPassword(token: string, password: string, meta: ClientMeta) {
		const userId = this.db.users.consumeAuthToken(hashToken(token), "reset-password");
		if (!userId) throw new ValidationError("This reset link is invalid or has expired. Request a new one.");
		const existing = this.db.users.byId(userId) as User;
		validatePassword(password, existing.email);
		this.db.users.setPassword(userId, await hashPassword(password));
		this.db.users.deleteSessions(userId);
		// Following the emailed link proves they own the address.
		const user = existing.emailVerifiedAt ? existing : this.db.users.update(userId, { emailVerifiedAt: sqlNow() });
		return { user, token: this.createSession(userId, meta) };
	}

	async changePassword(user: User, current: string, next: string, keepSessionId?: string) {
		const hash = this.db.users.passwordHash(user.id);
		if (!hash || !(await verifyPassword(current, hash)))
			throw new ValidationError("Your current password is incorrect.");
		validatePassword(next, user.email);
		this.db.users.setPassword(user.id, await hashPassword(next));
		this.db.users.deleteSessions(user.id, keepSessionId);
	}

	/** Set a password without knowing the old one (CLI / admin recovery). Signs out everywhere. */
	async setPassword(user: User, password: string) {
		validatePassword(password, user.email);
		this.db.users.setPassword(user.id, await hashPassword(password));
		this.db.users.deleteSessions(user.id);
	}

	async confirmPassword(user: User, password: string) {
		const hash = this.db.users.passwordHash(user.id);
		if (!hash || !(await verifyPassword(password, hash))) throw new ValidationError("Your password is incorrect.");
	}
}

/** Current time in SQLite's `datetime('now')` format, so all stored timestamps compare consistently. */
export function sqlNow(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}
