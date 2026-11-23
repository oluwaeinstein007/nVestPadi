import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { hashPassword, verifyPassword } from "../src/lib/crypto.js";
import { currentPlan } from "../src/services/plans.js";
import { Database } from "../src/storage/database.js";
import { MIGRATIONS } from "../src/storage/migrations.js";
import { TestMailer, security, seed, user } from "./helpers.js";

const meta = { userAgent: "test", ip: "127.0.0.1" };

function setup(env: Record<string, string> = {}) {
	const mailer = new TestMailer();
	const app = createApp(parseConfig({ DATABASE_PATH: ":memory:", NODE_ENV: "test", ...env }), { mailer });
	return { app, mailer };
}

describe("passwords", () => {
	it("hashes with a per-password salt and verifies", async () => {
		const a = await hashPassword("correct horse");
		const b = await hashPassword("correct horse");
		assert.notEqual(a, b);
		assert.match(a, /^scrypt\$16384\$8\$1\$/);
		assert.equal(await verifyPassword("correct horse", a), true);
		assert.equal(await verifyPassword("wrong horse", a), false);
		assert.equal(await verifyPassword("x", "garbage"), false);
	});
});

describe("sign-up and sign-in", () => {
	it("makes the first account the admin, then closes sign-up on self-hosted servers", async () => {
		const { app } = setup();
		assert.deepEqual(app.auth.signupStatus(), { open: true, needsOwner: true });
		const { user: owner } = await app.auth.signup(
			{ name: "Ada", email: " Ada@Example.com ", password: "s3cret-pass" },
			meta,
		);
		assert.equal(owner.role, "admin");
		assert.equal(owner.email, "ada@example.com");
		assert.deepEqual(app.auth.signupStatus(), { open: false, needsOwner: false });
		await assert.rejects(
			app.auth.signup({ name: "Bo", email: "bo@example.com", password: "s3cret-pass" }, meta),
			(e: Error & { status?: number }) => e.status === 403,
		);
	});

	it("keeps sign-up open in cloud mode, and rejects duplicate emails", async () => {
		const { app } = setup({ APP_MODE: "cloud" });
		await app.auth.signup({ name: "Ada", email: "ada@example.com", password: "s3cret-pass" }, meta);
		const { user: second } = await app.auth.signup(
			{ name: "Bo", email: "bo@example.com", password: "s3cret-pass" },
			meta,
		);
		assert.equal(second.role, "member");
		assert.equal(second.plan, "free");
		await assert.rejects(
			app.auth.signup({ name: "Ada 2", email: "ADA@example.com", password: "s3cret-pass" }, meta),
			(e: Error & { status?: number }) => e.status === 409,
		);
	});

	it("enforces the password policy", async () => {
		const { app } = setup();
		await assert.rejects(app.auth.signup({ name: "A", email: "a@example.com", password: "short" }, meta), /at least 8/);
		await assert.rejects(
			app.auth.signup({ name: "A", email: "a@example.com", password: "a@example.com" }, meta),
			/same as your email/,
		);
	});

	it("signs in, resolves sessions and signs out", async () => {
		const { app } = setup();
		await app.auth.signup({ name: "Ada", email: "ada@example.com", password: "s3cret-pass" }, meta);
		await assert.rejects(app.auth.login({ email: "ada@example.com", password: "nope-nope" }, meta), /Incorrect/);
		await assert.rejects(app.auth.login({ email: "who@example.com", password: "nope-nope" }, meta), /Incorrect/);
		const { token } = await app.auth.login({ email: "ADA@example.com", password: "s3cret-pass" }, meta);
		assert.equal(app.auth.authenticateSession(token)?.user.email, "ada@example.com");
		assert.equal(app.auth.authenticateSession("forged"), null);
		app.auth.logout(token);
		assert.equal(app.auth.authenticateSession(token), null);
	});
});

describe("email verification and password reset", () => {
	it("verifies email with a single-use link", async () => {
		const { app, mailer } = setup({ APP_MODE: "cloud" });
		const { user: u } = await app.auth.signup({ name: "Ada", email: "ada@example.com", password: "s3cret-pass" }, meta);
		assert.equal(u.emailVerifiedAt, null);
		assert.match(mailer.sent[0]?.subject ?? "", /Confirm your email/);
		const token = mailer.lastToken();
		assert.ok(app.auth.verifyEmail(token).emailVerifiedAt);
		assert.throws(() => app.auth.verifyEmail(token), /invalid or has expired/);
	});

	it("auto-verifies when email only goes to the log", async () => {
		const app = createApp(parseConfig({ DATABASE_PATH: ":memory:", NODE_ENV: "test" }));
		const { user: u } = await app.auth.signup({ name: "Ada", email: "ada@example.com", password: "s3cret-pass" }, meta);
		assert.ok(u.emailVerifiedAt);
	});

	it("resets the password, signs out old sessions and never reveals unknown accounts", async () => {
		const { app, mailer } = setup();
		const { token: oldSession } = await app.auth.signup(
			{ name: "Ada", email: "ada@example.com", password: "s3cret-pass" },
			meta,
		);
		const before = mailer.sent.length;
		await app.auth.requestPasswordReset("nobody@example.com");
		assert.equal(mailer.sent.length, before, "no email for unknown accounts");

		await app.auth.requestPasswordReset("ada@example.com");
		const resetToken = mailer.lastToken();
		const { token } = await app.auth.resetPassword(resetToken, "brand-new-pass", meta);
		assert.equal(app.auth.authenticateSession(oldSession), null);
		assert.ok(app.auth.authenticateSession(token));
		await app.auth.login({ email: "ada@example.com", password: "brand-new-pass" }, meta);
		await assert.rejects(app.auth.resetPassword(resetToken, "another-pass", meta), /invalid or has expired/);
	});

	it("changes the password but keeps the current session", async () => {
		const { app } = setup();
		const { user: u, token } = await app.auth.signup(
			{ name: "Ada", email: "ada@example.com", password: "s3cret-pass" },
			meta,
		);
		const other = app.auth.createSession(u.id, meta);
		const current = app.auth.authenticateSession(token)?.sessionId;
		await assert.rejects(app.auth.changePassword(u, "wrong-pass", "new-pass-123", current), /incorrect/);
		await app.auth.changePassword(u, "s3cret-pass", "new-pass-123", current);
		assert.ok(app.auth.authenticateSession(token));
		assert.equal(app.auth.authenticateSession(other), null);
	});
});

describe("accounts", () => {
	it("issues API tokens that are shown once and can be revoked", async () => {
		const { app } = setup();
		const u = user(app.db);
		const { token, info } = app.accounts.createApiToken(u, "laptop");
		assert.match(token, /^nvp_/);
		assert.equal(info.prefix, token.slice(0, 10));
		assert.equal(app.auth.authenticateApiToken(token)?.id, u.id);
		assert.equal(app.auth.authenticateApiToken("nvp_forged"), null);
		app.accounts.revokeApiToken(u, info.id);
		assert.equal(app.auth.authenticateApiToken(token), null);
	});

	it("meters AI questions per day on Free and refunds failed ones", () => {
		const { app } = setup({ APP_MODE: "cloud" });
		const u = user(app.db);
		for (let i = 0; i < 4; i++) app.accounts.meterAiQuestion(u);
		const refund = app.accounts.meterAiQuestion(u);
		assert.throws(() => app.accounts.meterAiQuestion(u), /today's 5 AI questions/);
		refund();
		app.accounts.meterAiQuestion(u);
		assert.equal(app.accounts.overview(u).usage.aiQuestionsToday, 5);
	});

	it("is unlimited when self-hosted", () => {
		const { app } = setup();
		const o = app.accounts.overview(user(app.db));
		assert.equal(o.plan.id, "self-hosted");
		assert.equal(o.limits.watchlist, null);
		assert.equal(o.limits.discordAlerts, true);
	});

	it("validates notification channels and gates Discord to Pro", () => {
		const { app } = setup({ APP_MODE: "cloud" });
		const free = user(app.db);
		const hook = "https://discord.com/api/webhooks/123/abc-DEF_1";
		assert.equal(app.accounts.updateNotifications(free, { dailyDigest: false }).dailyDigest, false);
		assert.throws(() => app.accounts.updateNotifications(free, { discordWebhookUrl: hook }), /part of Pro/);
		const pro = user(app.db, { plan: "pro" });
		assert.throws(() => app.accounts.updateNotifications(pro, { discordWebhookUrl: "https://evil.test/x" }), /Discord/);
		assert.equal(app.accounts.updateNotifications(pro, { discordWebhookUrl: hook }).discordWebhookUrl, hook);
	});

	it("treats a long-lapsed Pro renewal as Free", () => {
		const { app } = setup();
		const u = app.db.users.update(user(app.db, { plan: "pro" }).id, { planRenewsAt: "2020-01-01 00:00:00" });
		assert.equal(currentPlan(u), "free");
		assert.equal(currentPlan(app.db.users.update(u.id, { planRenewsAt: null })), "pro");
	});

	it("deletes an account and everything it owns", async () => {
		const { app } = setup();
		seed(app.db, [{ s: security("GTCO", "Guaranty Trust"), closes: [1, 2, 3] }]);
		const { user: u } = await app.auth.signup({ name: "Ada", email: "ada@example.com", password: "s3cret-pass" }, meta);
		app.db.watchlist.add(u.id, "NGX", "GTCO");
		app.alerts.add(u, { exchange: "NGX", symbol: "GTCO", condition: "above", threshold: 5 });
		await assert.rejects(app.accounts.deleteAccount(u, "wrong"), /incorrect/);
		await app.accounts.deleteAccount(u, "s3cret-pass");
		assert.equal(app.db.users.byId(u.id), null);
		assert.equal(app.db.watchlist.count(u.id), 0);
		assert.equal(app.db.alerts.countActive(u.id), 0);
	});
});

describe("migration from v2 (single-user) databases", () => {
	it("keeps existing watchlist and alerts and hands them to the first account", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "nvest-"));
		const file = path.join(dir, "v2.db");
		try {
			const v2 = new DatabaseSync(file);
			v2.exec(MIGRATIONS[0] as string);
			v2.exec("PRAGMA user_version = 1");
			v2.exec("INSERT INTO watchlist (exchange, symbol) VALUES ('NGX', 'GTCO'), ('US', 'AAPL')");
			v2.exec("INSERT INTO alerts (exchange, symbol, condition, threshold) VALUES ('NGX', 'GTCO', 'above', 100)");
			v2.close();

			const db = new Database(file);
			assert.equal(db.schemaVersion, MIGRATIONS.length);
			const owner = db.users.create({ email: "owner@example.com", name: "Owner", passwordHash: "x", role: "admin" });
			assert.deepEqual(db.users.claimUnownedData(owner.id), { watchlist: 2, alerts: 1 });
			assert.deepEqual(
				db.watchlist.list(owner.id).map((w) => w.symbol),
				["GTCO", "AAPL"],
			);
			assert.equal(db.alerts.countActive(owner.id), 1);
			db.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
