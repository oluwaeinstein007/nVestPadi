/** Shared CLI types and argument helpers. */
import type { App } from "../app.js";
import { EXCHANGES, type Exchange, parseExchange } from "../markets/types.js";
import type { User } from "../storage/repositories/users.js";

export type Flags = Record<string, string | boolean | undefined>;

export interface Command {
	usage: string;
	summary: string;
	options?: Record<string, { type: "string" | "boolean"; short?: string }>;
	run(app: App, args: string[], flags: Flags, json: boolean): Promise<unknown>;
}

export class UsageError extends Error {}

export const out = (s = "") => process.stdout.write(`${s}\n`);
export const str = (v: unknown) => (typeof v === "string" ? v : undefined);
export const num = (v: unknown, name: string) => {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
	return n;
};
export const exchangeFlag = { exchange: { type: "string" as const, short: "e" } };
export const userFlag = { user: { type: "string" as const, short: "u" } };
export const exchangesArg = (arg: string | undefined): Exchange[] =>
	!arg || arg.toLowerCase() === "all" ? [...EXCHANGES] : [parseExchange(arg) as Exchange];

/**
 * The account a user-scoped command (watchlist, alerts) acts as: `--user <email>`,
 * or the server's first admin.
 */
export function cliUser(app: App, flags: Flags): User {
	const email = str(flags.user);
	if (email) {
		const user = app.db.users.byEmail(email.trim().toLowerCase());
		if (!user) throw new UsageError(`No account for ${email}. List accounts with \`nvest users list\`.`);
		return user;
	}
	const admin = app.db.users.firstAdmin();
	if (!admin) {
		throw new UsageError(
			`No accounts yet. Create the owner account first:\n  nvest users create you@example.com --name "Your Name"\nor sign up at ${app.config.appUrl}/signup`,
		);
	}
	return admin;
}
