/** Server and administration commands: serve, doctor, users. */
import { randomBytes } from "node:crypto";
import { registerDiscordCommands } from "../../integrations/discord.js";
import { discordCommands, telegramCommands } from "../../integrations/handlers.js";
import { onShutdown } from "../../lib/shutdown.js";
import { EXCHANGES, parseExchange } from "../../markets/types.js";
import { Scheduler } from "../../scheduler.js";
import { startServer } from "../../server/server.js";
import { normalizeEmail } from "../../services/authService.js";
import { currentPlan } from "../../services/plans.js";
import type { PlanId, Role } from "../../storage/repositories/users.js";
import { VERSION } from "../../version.js";
import { type Command, UsageError, num, out, str } from "../command.js";
import { c, heading, table } from "../format.js";

export const systemCommands: Record<string, Command> = {
	serve: {
		usage: "serve [--port 3000] [--sync-every <minutes>]",
		summary: "Start the web app + REST API",
		options: { port: { type: "string", short: "p" }, "sync-every": { type: "string" } },
		async run(app, _args, flags) {
			const port = num(flags.port, "port") ?? app.config.server.port;
			await startServer(app, { port });
			const scheduler = new Scheduler(app);
			onShutdown(() => scheduler.stop());
			const every = num(flags["sync-every"], "sync-every");
			if (every) {
				scheduler.startSync(every, [...EXCHANGES]);
				if (app.config.liveSyncMinutes < every) scheduler.startLiveSync(app.config.liveSyncMinutes);
			}
			if (app.config.digests) scheduler.startDigests();
			await scheduler.startTelegram();
			await new Promise(() => undefined);
		},
	},

	doctor: {
		usage: "doctor",
		summary: "Check configuration and connectivity",
		async run(app, _args, _flags, json) {
			const checks = await app.doctor();
			if (json) return checks;
			const icon = { ok: c.green("✔"), warn: c.yellow("!"), off: c.dim("○"), error: c.red("✘") };
			out(heading("nVestPadi doctor", `v${VERSION}`));
			for (const ch of checks) out(`  ${icon[ch.status]} ${c.bold(ch.name.padEnd(15))} ${ch.detail}`);
			out();
			if (checks.some((ch) => ch.status === "error")) process.exitCode = 1;
		},
	},

	digest: {
		usage: "digest [ngx|us|crypto] [--user email] [--send]",
		summary: "Preview (or --send) a market digest, or a user's personal digest",
		options: { user: { type: "string", short: "u" }, send: { type: "boolean" } },
		async run(app, args, flags, json) {
			const email = str(flags.user);
			if (email) {
				const user = app.db.users.byEmail(normalizeEmail(email));
				if (!user) throw new UsageError(`No account for ${email}`);
				const digest = app.digests.userDigest(user);
				if (!digest) return out(c.dim("Nothing personal to report (empty watchlist, portfolio and alerts)."));
				if (flags.send) {
					const results = await app.notifier.deliver(user, digest.paragraphs, { subject: digest.subject });
					return json
						? results
						: out(
								`${c.green("✔")} sent via ${
									results
										.filter((r) => r.ok)
										.map((r) => r.channel)
										.join(", ") || "no channel"
								}`,
							);
				}
				return json ? digest : out(`${c.bold(digest.subject)}\n\n${digest.paragraphs.join("\n\n")}`);
			}
			const exchange = parseExchange(args[0]) ?? "NGX";
			const text = app.digests.marketDigest(exchange);
			if (!text) return out(c.dim(`No ${exchange} data yet — run \`nvest sync\` first.`));
			if (flags.send) {
				const sent = await app.digests.broadcast(text);
				return json
					? { sent }
					: out(
							`${c.green("✔")} posted to ${sent.join(", ") || "no channel (set TELEGRAM_CHAT_ID or DISCORD_WEBHOOK_URL)"}`,
						);
			}
			return json ? { text } : out(text);
		},
	},

	bots: {
		usage: "bots setup",
		summary: "Register Telegram commands and Discord slash commands",
		async run(app, args) {
			if (args[0] !== "setup") throw new UsageError("Usage: nvest bots setup");
			if (app.telegram) {
				await app.telegram.setCommands(telegramCommands());
				out(`${c.green("✔")} Telegram commands set for @${await app.telegram.botUsername()}`);
			} else out(c.dim("○ Telegram: set TELEGRAM_BOT_TOKEN"));
			const discord = app.config.discord.app;
			if (discord?.botToken) {
				await registerDiscordCommands(discord.applicationId, discord.botToken, discordCommands());
				out(`${c.green("✔")} Discord slash commands registered`);
				out(
					c.dim(
						`  Interactions endpoint URL (Discord developer portal): ${app.config.appUrl}/api/integrations/discord`,
					),
				);
			} else out(c.dim("○ Discord: set DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY and DISCORD_BOT_TOKEN"));
		},
	},

	users: {
		usage:
			"users [list | create <email> [--name N] [--password P] [--admin] [--plan pro] | set-password <email> [--password P] | set-plan <email> free|pro | set-role <email> admin|member | delete <email>]",
		summary: "Manage accounts (the first account created becomes the owner)",
		options: {
			name: { type: "string" },
			password: { type: "string" },
			admin: { type: "boolean" },
			plan: { type: "string" },
		},
		async run(app, args, flags, json) {
			const [action = "list", email, value] = args;
			const find = () => {
				if (!email) throw new UsageError(`users ${action} needs an email`);
				const user = app.db.users.byEmail(normalizeEmail(email));
				if (!user) throw new UsageError(`No account for ${email}`);
				return user;
			};
			// Generated passwords are printed once; the user should change it after signing in.
			const passwordOrGenerated = () => str(flags.password) ?? randomBytes(12).toString("base64url");

			if (action === "list") {
				const users = app.db.users.list();
				if (json) return users.map(({ billingCustomerId, billingSubscriptionId, ...u }) => u);
				if (users.length === 0) return out(`No accounts yet. Create one with ${c.bold("nvest users create <email>")}.`);
				return out(
					table(users, [
						{ header: "ID", value: (u) => c.dim(`#${u.id}`), align: "right" },
						{ header: "Email", value: (u) => c.bold(u.email) },
						{ header: "Name", value: (u) => u.name.slice(0, 24) },
						{ header: "Role", value: (u) => (u.role === "admin" ? c.cyan("admin") : "member") },
						{
							header: "Plan",
							value: (u) => (app.config.mode === "self-hosted" ? c.dim("self-hosted") : currentPlan(u)),
						},
						{ header: "Verified", value: (u) => (u.emailVerifiedAt ? c.green("yes") : c.yellow("no")) },
						{ header: "Last login", value: (u) => c.dim(u.lastLoginAt ?? "never") },
					]),
				);
			}

			if (action === "create") {
				if (!email) throw new UsageError("users create needs an email");
				const plan = str(flags.plan);
				if (plan && plan !== "free" && plan !== "pro") throw new UsageError("--plan must be free or pro");
				const password = passwordOrGenerated();
				const user = await app.auth.createAccount({
					email,
					name: str(flags.name) ?? "",
					password,
					role: flags.admin ? "admin" : "member",
					plan: plan as PlanId | undefined,
					emailVerified: true, // created by an operator, not self-service
				});
				if (json)
					return {
						id: user.id,
						email: user.email,
						role: user.role,
						password: str(flags.password) ? undefined : password,
					};
				out(`${c.green("✔")} Created ${user.role} ${c.bold(user.email)}`);
				if (!str(flags.password))
					out(`  Temporary password: ${c.bold(password)}  ${c.dim("(change it under Settings → Security)")}`);
				out(c.dim(`  Sign in at ${app.config.appUrl}/login`));
				return;
			}

			const user = find();
			if (action === "set-password") {
				const password = passwordOrGenerated();
				await app.auth.setPassword(user, password);
				if (json) return { email: user.email, password: str(flags.password) ? undefined : password };
				out(`${c.green("✔")} Password updated for ${user.email}; all their sessions were signed out.`);
				if (!str(flags.password)) out(`  New password: ${c.bold(password)}`);
				return;
			}
			if (action === "set-plan") {
				if (value !== "free" && value !== "pro") throw new UsageError("Usage: nvest users set-plan <email> free|pro");
				// Manual grants (e.g. comps, beta testers) don't expire until changed.
				const updated = app.db.users.update(user.id, { plan: value, planRenewsAt: null });
				return json ? updated : out(`${c.green("✔")} ${user.email} is now on ${value}`);
			}
			if (action === "set-role") {
				if (value !== "admin" && value !== "member")
					throw new UsageError("Usage: nvest users set-role <email> admin|member");
				const updated = app.db.users.update(user.id, { role: value as Role });
				return json ? updated : out(`${c.green("✔")} ${user.email} is now ${value}`);
			}
			if (action === "delete") {
				app.db.users.delete(user.id);
				return json ? { deleted: user.email } : out(`${c.green("✔")} Deleted ${user.email} and their data`);
			}
			throw new UsageError(`Unknown users action "${action}"`);
		},
	},
};
