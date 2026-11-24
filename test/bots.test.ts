import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { verifyDiscordRequest } from "../src/integrations/discord.js";
import { handleDiscordInteraction } from "../src/integrations/handlers.js";
import { toTelegramHtml } from "../src/integrations/telegram.js";
import { hashToken } from "../src/lib/crypto.js";
import { isoDate } from "../src/lib/util.js";
import type { BotContext } from "../src/services/botService.js";
import { TestMailer, makeBars, security, seed, user } from "./helpers.js";

function setup(env: Record<string, string> = {}) {
	const mailer = new TestMailer();
	const app = await createApp(parseConfig({ DATABASE_PATH: ":memory:", NODE_ENV: "test", ...env }), { mailer });
	const today = isoDate(new Date());
	// Two stocks whose latest bar is today, with enough history to avoid network backfills.
	const start = new Date(Date.now() - 69 * 86_400_000).toISOString().slice(0, 10);
	await app.db.market.upsertSecurities([
		security("GTCO", "Guaranty Trust", "Banking"),
		security("ZENITH", "Zenith Bank", "Banking"),
	]);
	await app.db.market.upsertPrices([
		...makeBars(
			"GTCO",
			Array.from({ length: 70 }, (_, i) => 100 + i),
			"NGX",
			start,
		),
		...makeBars(
			"ZENITH",
			Array.from({ length: 70 }, (_, i) => 80 - i / 2),
			"NGX",
			start,
		),
	]);
	return { app, mailer, today };
}

const dm = (overrides: Partial<BotContext> = {}): BotContext => ({
	platform: "telegram",
	chatKey: "42",
	chatId: "42",
	isPrivate: true,
	user: null,
	...overrides,
});

describe("portfolio", () => {
	it("values positions per currency and averages repeat buys", async () => {
		const { app } = setup({ APP_MODE: "cloud" });
		const u = user(app.db);
		await app.portfolio.add(u, { symbol: "GTCO", quantity: 10, avgCost: 100 });
		await app.portfolio.add(u, { symbol: "GTCO", quantity: 10, avgCost: 120 });
		const { positions, totals } = await app.portfolio.get(u);
		assert.equal(positions.length, 1);
		assert.equal(positions[0]?.quantity, 20);
		assert.equal(positions[0]?.avgCost, 110);
		assert.equal(positions[0]?.value, 20 * 169);
		assert.equal(positions[0]?.pnl, 20 * 169 - 2200);
		assert.equal(positions[0]?.dayPnl, 20);
		assert.equal(totals[0]?.currency, "NGN");
		await assert.rejects(await app.portfolio.add(u, { symbol: "GTCO", quantity: 0, avgCost: 1 }), /greater than 0/);
	});

	it("enforces the plan's position limit", async () => {
		const { app } = setup({ APP_MODE: "cloud" });
		const u = user(app.db);
		for (let i = 0; i < 10; i++)
			await app.db.holdings.insert(u.id, { exchange: "NGX", symbol: `S${i}`, quantity: 1, avgCost: 1 });
		await assert.rejects(await app.portfolio.add(u, { symbol: "GTCO", quantity: 1, avgCost: 1 }), /up to 10 positions/);
	});
});

describe("digests", () => {
	it("builds a market digest and a personal digest from the user's own data only", async () => {
		const { app } = setup();
		const text = await app.digests.marketDigest("NGX") ?? "";
		assert.match(text, /\*\*Nigerian Exchange — session/);
		assert.match(text, /Top gainers:\*\* GTCO/);

		const u = user(app.db);
		assert.equal(await app.digests.userDigest(u), null, "nothing personal yet");
		await app.db.watchlist.add(u.id, "NGX", "ZENITH");
		await app.portfolio.add(u, { symbol: "GTCO", quantity: 2, avgCost: 150 });
		const digest = await app.digests.userDigest(u);
		const body = digest?.paragraphs.join("\n") ?? "";
		assert.match(body, /Your watchlist\*\*\n▼ ZENITH/);
		assert.match(body, /Your portfolio\*\*\nNGN: ₦338\.00/);
		const watchlist = digest?.paragraphs.find((p) => p.startsWith("**Your watchlist")) ?? "";
		assert.doesNotMatch(watchlist, /GTCO/, "only the user's own watchlist appears");
	});

	it("sends each digest once per day and only after the market closes", async () => {
		const { app, mailer, today } = setup();
		const u = user(app.db);
		await app.db.watchlist.add(u.id, "NGX", "GTCO");
		let refreshes = 0;
		const refresh = async () => {
			refreshes++;
		};
		// Before every market's digest time (crypto's is 07:00 UTC).
		const before = new Date(`${today}T06:00:00Z`);
		const after = new Date(`${today}T15:05:00Z`);
		const weekend = [0, 6].includes(after.getUTCDay());

		assert.deepEqual(
			(await app.digests.runDue(before, refresh)).map((r) => r.exchange),
			[],
		);
		const first = (await app.digests.runDue(after, refresh)).filter((r) => r.exchange === "NGX");
		if (!weekend) {
			assert.equal(first.length, 1);
			assert.equal(first[0]?.users, 1);
			assert.match(mailer.sent.at(-1)?.subject ?? "", /Nigerian Exchange wrap-up/);
		}
		const sentCount = mailer.sent.length;
		assert.deepEqual(await app.digests.runDue(after, refresh), []);
		assert.equal(mailer.sent.length, sentCount, "no duplicates");
		assert.ok(refreshes <= 2);
	});
});

describe("chat bot", () => {
	it("answers public market commands and hides personal ones until linked", async () => {
		const { app } = setup();
		assert.match(
			(await app.bots.handleText("/market@nvestpadi_bot ngx", dm({ isPrivate: false }))) ?? "",
			/Gainers\*\*\nGTCO/,
		);
		assert.match((await app.bots.handleText("/quote gtco", dm())) ?? "", /Guaranty Trust\*\* \(NGX:GTCO\)/);
		assert.match((await app.bots.handleText("/watchlist", dm())) ?? "", /linked accounts/);
		assert.equal(
			await app.bots.handleText("hello group", dm({ isPrivate: false })),
			null,
			"groups only react to commands",
		);
		assert.match((await app.bots.handleText("/ask how are banks?", dm())) ?? "", /aren't enabled/);
	});

	it("links a Telegram DM with a one-time token and scopes commands to that account", async () => {
		const { app } = setup();
		const u = user(app.db);
		await app.db.watchlist.add(u.id, "NGX", "GTCO");
		await app.db.users.createAuthToken(hashToken("link-token-123"), u.id, "telegram-link", 900);

		assert.match((await app.bots.handleText("/start link-token-123", dm({ isPrivate: false }))) ?? "", /private chat/);
		assert.match((await app.bots.handleText("/start link-token-123", dm())) ?? "", /Connected/);
		const linked = await app.db.users.byTelegramChat("42");
		assert.equal(linked?.id, u.id);
		assert.match((await app.bots.handleText("/start link-token-123", dm())) ?? "", /expired/, "single use");

		assert.match((await app.bots.handleText("/watchlist", dm({ user: linked }))) ?? "", /GTCO ₦169\.00/);
		assert.match((await app.bots.handleText("/digest off", dm({ user: linked }))) ?? "", /off/);
		assert.equal(await app.db.users.byId(u.id)?.dailyDigest, false);
		await app.bots.handleText("/unlink", dm({ user: await app.db.users.byId(u.id) }));
		assert.equal(await app.db.users.byTelegramChat("42"), null);
	});

	it("formats replies for Telegram safely", async () => {
		assert.equal(toTelegramHtml("**A&B** <x> `c`"), "<b>A&amp;B</b> &lt;x&gt; <code>c</code>");
	});
});

describe("Discord interactions", () => {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicHex = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");

	it("verifies Ed25519 request signatures", async () => {
		const body = Buffer.from('{"type":1}');
		const ts = "1700000000";
		const sig = sign(null, Buffer.concat([Buffer.from(ts), body]), privateKey).toString("hex");
		assert.equal(verifyDiscordRequest(publicHex, sig, ts, body), true);
		assert.equal(verifyDiscordRequest(publicHex, sig, "1700000001", body), false);
		assert.equal(verifyDiscordRequest(publicHex, "00", ts, body), false);
		assert.equal(verifyDiscordRequest(publicHex, undefined, ts, body), false);
	});

	it("answers pings and fast slash commands inline", async () => {
		const { app } = setup();
		assert.deepEqual(handleDiscordInteraction(app, { type: 1, token: "t", application_id: "1" }), { type: 1 });
		const res = (await handleDiscordInteraction(app, {
			type: 2,
			token: "t",
			application_id: "1",
			guild_id: "g",
			data: { name: "market", options: [{ name: "market", value: "ngx" }] },
		})) as { type: number; data: { content: string } };
		assert.equal(res.type, 4);
		assert.match(res.data.content, /Nigerian Exchange/);
	});
});
