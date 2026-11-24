import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { connectionSettings, toPositional } from "../src/storage/postgresDriver.js";
import { dropTestDatabases, makeBars, memoryDb, security, user } from "./helpers.js";

after(dropTestDatabases);

describe("storage: behaviour that must hold on every engine", () => {
	it("lets only `limit` of many concurrent metered calls through", async () => {
		const db = await memoryDb();
		const u = await user(db);
		const results = await Promise.all(Array.from({ length: 12 }, () => db.usage.consume(u.id, "ai_questions", 5)));
		assert.equal(results.filter(Boolean).length, 5);
		assert.equal(await db.usage.get(u.id, "ai_questions"), 5);
		await db.usage.refund(u.id, "ai_questions");
		assert.equal(await db.usage.get(u.id, "ai_questions"), 4);
		await db.close();
	});

	it("redeems a one-time token exactly once, even when raced", async () => {
		const db = await memoryDb();
		const u = await user(db);
		await db.users.createAuthToken("tok", u.id, "reset-password", 600);
		const redeemed = await Promise.all(
			Array.from({ length: 6 }, () => db.users.consumeAuthToken("tok", "reset-password")),
		);
		assert.equal(redeemed.filter((id) => id === u.id).length, 1);
		await db.close();
	});

	it("fires an alert once even if two checks race", async () => {
		const db = await memoryDb();
		const u = await user(db);
		const alert = await db.alerts.create({
			userId: u.id,
			exchange: "NGX",
			symbol: "GTCO",
			condition: "above",
			threshold: 1,
		});
		const fired = await Promise.all([db.alerts.markTriggered(alert.id, 2), db.alerts.markTriggered(alert.id, 2)]);
		assert.deepEqual(fired.filter(Boolean).length, 1);
		await db.close();
	});

	it("rolls back a failed transaction and joins nested ones", async () => {
		const db = await memoryDb();
		await assert.rejects(
			db.transaction(async () => {
				await db.market.upsertSecurities([security("AAA", "Triple A")]);
				await db.transaction(async () => db.market.upsertSecurities([security("BBB", "Triple B")])); // nested
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.equal(await db.market.getSecurity("NGX", "AAA"), null);
		assert.equal(await db.market.getSecurity("NGX", "BBB"), null);
		await db.transaction(async () => db.market.upsertSecurities([security("CCC", "Triple C")]));
		assert.equal((await db.market.getSecurity("NGX", "CCC"))?.name, "Triple C");
		await db.close();
	});

	it("keeps concurrent writers out of each other's transactions", async () => {
		const db = await memoryDb();
		const failing = db.transaction(async () => {
			await db.market.upsertSecurities([security("ROLL", "Rolled back")]);
			await new Promise((r) => setTimeout(r, 30));
			throw new Error("abort");
		});
		const other = (async () => {
			await new Promise((r) => setTimeout(r, 5));
			await db.market.upsertSecurities([security("KEEP", "Kept")]);
		})();
		await assert.rejects(failing, /abort/);
		await other;
		assert.equal(await db.market.getSecurity("NGX", "ROLL"), null);
		assert.equal((await db.market.getSecurity("NGX", "KEEP"))?.name, "Kept");
		await db.close();
	});

	it("handles duplicate keys inside one batch and large batches", async () => {
		const db = await memoryDb();
		await db.market.upsertSecurities([security("DUP", "Dup One"), security("DUP", "Dup Two")]);
		assert.equal((await db.market.getSecurity("NGX", "DUP"))?.name, "Dup Two");
		const closes = Array.from({ length: 700 }, (_, i) => 100 + i);
		await db.market.upsertPrices([...makeBars("BIG", closes), ...makeBars("BIG", closes)]);
		assert.equal((await db.market.history("NGX", "BIG", 1000)).length, 700);
		await db.close();
	});

	it("treats emails case-insensitively and keeps unique violations recognisable", async () => {
		const db = await memoryDb();
		await user(db, { email: "Ada@Example.com" });
		assert.equal((await db.users.byEmail("ada@example.COM"))?.email, "Ada@Example.com");
		await assert.rejects(user(db, { email: "ADA@example.com" }));
		await db.close();
	});

	it("stores prices and volumes without losing precision", async () => {
		const db = await memoryDb();
		await db.market.upsertSecurities([security("PREC", "Precision")]);
		const [bar] = makeBars("PREC", [1234567.891234]);
		await db.market.upsertPrices([{ ...(bar as NonNullable<typeof bar>), volume: 98_765_432_101 }]);
		const stored = (await db.market.history("NGX", "PREC"))[0];
		assert.equal(stored?.close, 1234567.891234);
		assert.equal(stored?.volume, 98_765_432_101);
		await db.close();
	});
});

describe("postgres driver helpers", () => {
	it("rewrites ? placeholders but leaves literals, quoted names and comments alone", () => {
		assert.equal(toPositional("SELECT ? , ? FROM t WHERE a = ?"), "SELECT $1 , $2 FROM t WHERE a = $3");
		assert.equal(toPositional("SELECT '?' , \"a?b\" , ? -- why?\n, ?"), "SELECT '?' , \"a?b\" , $1 -- why?\n, $2");
	});

	it("maps sslmode to TLS settings the way libpq does", () => {
		const ssl = (url: string, caCert?: string) => connectionSettings({ url, caCert }).ssl;
		assert.equal(ssl("postgres://u:p@localhost/db"), false);
		assert.equal(ssl("postgres://u:p@db.example.com/db?sslmode=disable"), false);
		assert.deepEqual(ssl("postgres://u:p@db.example.com/db"), { rejectUnauthorized: false });
		assert.deepEqual(ssl("postgres://u:p@db.example.com/db?sslmode=require"), { rejectUnauthorized: false });
		assert.deepEqual(ssl("postgres://u:p@db.example.com/db?sslmode=verify-full", "PEM"), {
			rejectUnauthorized: true,
			ca: "PEM",
		});
		assert.ok(
			!connectionSettings({ url: "postgres://u:p@h/db?sslmode=require" }).connectionString?.includes("sslmode"),
		);
	});
});
