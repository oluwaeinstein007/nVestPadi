import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { dividendCalendar, dividendSummary, toEvent, tradingDaysBefore } from "../src/analysis/dividends.js";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import {
	type NgxDisclosure,
	isDividendNotice,
	mayHoldDividend,
	parseAmount,
	parseDate,
	parseDividendNotice,
	splitTitle,
	toDisclosure,
} from "../src/markets/ngxDisclosures.js";
import { DisclosureService } from "../src/services/disclosureService.js";
import { dropTestDatabases, makeBars, memoryDb, security, testEnv, user } from "./helpers.js";

/** Wording from real NGX notices (Unilever, Okomu, Transcorp, Ikeja Hotel, Seplat, AVA fund). */
const UNILEVER = `Corporate Actions Announcement UNILEVER NIGERIA PLC Proposed Interim Dividend An Interim Dividend of N2.00 kobo
	for every ordinary share of 50k each, subject to deduction of withholding tax, will be paid to shareholders whose names
	appear in the Register of Members as at the close of business on Friday, 30 October 2026. Closure of Register The
	Register of Shareholders will be closed from Monday, 2 November 2026 to Friday, 6 November 2026 (both dates
	inclusive). Qualification Date Friday, 30 October 2026. Payment Date On Wednesday 18 November 2026, dividends will be
	paid electronically to shareholders whose names appear on the Register of Members as at Friday, 30 October 2026.`;

describe("NGX dividend notices", () => {
	it("reads NGX's template: amount, kind and every date", () => {
		assert.deepEqual(parseDividendNotice(UNILEVER), {
			kind: "interim",
			amount: 2,
			currency: "NGN",
			qualificationDate: "2026-10-30",
			closureStart: "2026-11-02",
			closureEnd: "2026-11-06",
			paymentDate: "2026-11-18",
			agmDate: null,
			bonus: null,
		});
	});

	it("handles kobo, naira-with-kobo, US cents and per-unit amounts after a total", () => {
		assert.deepEqual(parseAmount("N1.60 Kobo (One Naira Sixty Kobo) per ordinary share"), {
			amount: 1.6,
			currency: "NGN",
		});
		assert.deepEqual(parseAmount("N11.50 kobo per 50kobo ordinary share"), { amount: 11.5, currency: "NGN" });
		assert.deepEqual(parseAmount("12.5k for every share of 50 kobo"), { amount: 0.125, currency: "NGN" });
		assert.deepEqual(parseAmount("30 kobo for every share"), { amount: 0.3, currency: "NGN" });
		assert.deepEqual(parseAmount("US4 cents (United States Four cents) per Ordinary Share"), {
			amount: 0.04,
			currency: "USD",
		});
		assert.deepEqual(parseAmount("₦442,026,861.70 amounting to ₦108,472.85 per unit"), {
			amount: 108472.85,
			currency: "NGN",
		});
	});

	it("reads the dates people actually type, and fixes last year's year", () => {
		assert.equal(parseDate("29th day of April, 2026"), "2026-04-29");
		assert.equal(parseDate("Friday, July 3, 2026"), "2026-07-03");
		assert.equal(parseDate("On 15h July 2026, dividends"), "2026-07-15");
		assert.equal(parseDate("17th April , 2026"), "2026-04-17");
		const typo = parseDividendNotice(
			"Proposed Dividend A Final Dividend of 12.5k for every share. Closure of Register The Register will be closed from the 7th day of July 2025 to 22nd of July 2026 Qualification Date 6th day of July, 2026 Payment Date On the 23rd day of July, 2025, dividends will be paid",
		);
		assert.equal(typo?.paymentDate, "2026-07-23");
		assert.equal(typo?.closureStart, "2026-07-07");
		const noYear = parseDividendNotice(
			"Proposed Dividend A Final Dividend of N10.00 per share. Closure of Register The Register of Shareholders will be closed from the 11th of May to the 15th of May 2026 (both days inclusive). Qualification Date 8th May 2026.",
		);
		assert.equal(noYear?.closureStart, "2026-05-11");
	});

	it("knows which filings to read", () => {
		assert.ok(isDividendNotice("2026 INTERIM DIVIDEND ANNOUNCEMENT"));
		assert.ok(isDividendNotice("H1 2026 Distribution Announcement"));
		assert.ok(!isDividendNotice("NOTIFICATION OF EXCHANGE RATE - INTERIM DIVIDEND"));
		assert.ok(!isDividendNotice("UNCLAIMED DIVIDENDS ANNOUNCEMENT"));
		assert.ok(!isDividendNotice("CORPORATE DISCLOSURE"), "DISCLOSURE isn't CLOSURE");
		assert.ok(mayHoldDividend("CORPORATE ACTION ANNOUNCEMENT"));
		assert.ok(!mayHoldDividend("NOTIFICATION OF BOARD CHANGE"));
		assert.equal(parseDividendNotice("Resignation of external auditor"), null);
	});

	it("splits NGX titles into company and subject", () => {
		assert.deepEqual(splitTitle("UNILEVER NIGERIA PLC - INTERIM DIVIDEND ANNOUNCEMENT"), {
			company: "UNILEVER NIGERIA PLC",
			title: "INTERIM DIVIDEND ANNOUNCEMENT",
		});
		const d = toDisclosure({
			Id: 7,
			URL: { Description: "AIICO INSURANCE PLC.-PROPOSED MERGER", Url: "https://doclib.ngxgroup.com/x.pdf" },
			InternationSecIN: "NGAIICO00002",
			Type_of_Submission: "Corporate Actions ",
			Modified: "2026-11-23T14:10:03Z",
		});
		assert.equal(d?.kind, "corporate-action");
		assert.equal(d?.title, "PROPOSED MERGER");
	});
});

describe("dividend calendar", () => {
	it("puts the buy-by date two trading days before qualification", () => {
		assert.equal(tradingDaysBefore("2026-10-30", 2), "2026-10-28"); // Fri → Wed
		assert.equal(tradingDaysBefore("2026-11-02", 2), "2026-10-29"); // Mon → Thu
		const base = {
			disclosureId: 1,
			exchange: "NGX" as const,
			symbol: "UNILEVER",
			kind: "interim",
			amount: 2,
			currency: "NGN",
			qualificationDate: "2026-10-30",
			closureStart: null,
			closureEnd: null,
			paymentDate: "2026-11-18",
			agmDate: null,
			bonus: null,
			announcedAt: "2026-10-23T09:00:00Z",
		};
		const quote = { name: "Unilever Nigeria", close: 50 };
		assert.equal(toEvent(base, quote, "2026-10-28").status, "open");
		assert.equal(toEvent(base, quote, "2026-10-29").status, "qualified");
		assert.equal(toEvent(base, quote, "2026-11-19").status, "paid");
		assert.equal(toEvent(base, quote, "2026-10-01").payoutYieldPct, 4);
		assert.equal(toEvent({ ...base, currency: "USD" }, quote, "2026-10-01").payoutYieldPct, null);
	});
});

describe("filings sync", () => {
	const filing = (id: number, isin: string, category: string, title: string, at: string): NgxDisclosure => ({
		id,
		isin,
		kind: category === "Corporate Actions" ? "corporate-action" : "financial-statements",
		category,
		title,
		company: "",
		url: `https://doclib.ngxgroup.com/${id}.pdf`,
		publishedAt: at,
	});
	const texts: Record<string, string> = {
		"https://doclib.ngxgroup.com/1.pdf": UNILEVER,
		"https://doclib.ngxgroup.com/2.pdf": UNILEVER.replace("Interim", "Interim"), // a reminder of the same payout
		"https://doclib.ngxgroup.com/3.pdf": "", // scanned
	};
	const read: string[] = [];
	const fetchers = {
		disclosures: async () => [
			filing(1, "NGUNILEVER01", "Corporate Actions", "INTERIM DIVIDEND ANNOUNCEMENT", "2026-10-23T09:00:00Z"),
			filing(2, "NGUNILEVER01", "Corporate Actions", "NOTIFICATION OF ANNOUNCEMENT", "2026-10-24T09:00:00Z"),
			filing(3, "NGGTCO000002", "Corporate Actions", "2026 INTERIM DIVIDEND ANNOUNCEMENT", "2026-09-29T09:00:00Z"),
			filing(4, "NGGTCO000002", "Corporate Actions", "APPOINTMENT OF DIRECTOR", "2026-09-30T09:00:00Z"),
			filing(5, "NGGTCO000002", "Financial Statements", "QUARTER 3 FINANCIAL STATEMENT", "2026-10-30T09:00:00Z"),
			filing(6, "XX0000000000", "Corporate Actions", "DIVIDEND ANNOUNCEMENT", "2026-10-30T09:00:00Z"),
		],
		issuers: async () => [
			{ isin: "NGUNILEVER01", symbol: "UNILEVER", name: "Unilever Nigeria", sharesOutstanding: null },
			{ isin: "NGGTCO000002", symbol: "GTCO", name: "GTCO", sharesOutstanding: null },
		],
		text: async (url: string) => {
			read.push(url);
			return texts[url] ?? "Quarter 3 results: profit after tax rose 24% to N500bn.";
		},
	};

	it("stores filings, reads only dividend notices and builds history and yields", async () => {
		const db = await memoryDb();
		const service = new DisclosureService(db, null, async () => async () => undefined, fetchers);
		const r = await service.sync(new Date("2026-11-25T00:00:00Z"));
		assert.equal(r.fetched, 6);
		assert.equal(r.dividendsFound, 2);
		assert.equal(r.scanned, 1);
		// The appointment and the results weren't downloaded; the unknown ISIN has no symbol, so nothing to read.
		assert.deepEqual(read.sort(), [
			"https://doclib.ngxgroup.com/1.pdf",
			"https://doclib.ngxgroup.com/2.pdf",
			"https://doclib.ngxgroup.com/3.pdf",
		]);
		assert.equal((await db.disclosures.forSymbol("NGX", "GTCO")).length, 3);
		assert.equal((await db.disclosures.forSymbol("NGX", "GTCO")).find((d) => d.id === 3)?.scanned, true);

		await db.market.upsertSecurities([security("UNILEVER", "Unilever Nigeria")]);
		await db.market.upsertPrices(makeBars("UNILEVER", [48, 50], "NGX", "2026-10-26"));
		const before = await dividendSummary(db, "NGX", "UNILEVER", "2026-10-28");
		assert.equal(before.history.length, 1, "the reminder notice is the same payout");
		assert.equal(before.next?.buyBy, "2026-10-28");
		assert.equal(before.trailingAmount, 0, "not in the trailing year until it qualifies");
		const afterPaid = await dividendSummary(db, "NGX", "UNILEVER", "2026-11-20");
		assert.equal(afterPaid.trailingAmount, 2);
		assert.equal(afterPaid.trailingYieldPct, 4);
		assert.equal(afterPaid.next, null);
		const calendar = await dividendCalendar(db, "NGX", { today: "2026-10-28" });
		assert.deepEqual(
			calendar.map((e) => [e.symbol, e.status]),
			[["UNILEVER", "open"]],
		);

		// Nothing new: the next sync only re-reads the overlap and downloads nothing.
		read.length = 0;
		await service.sync(new Date("2026-11-25T01:00:00Z"));
		assert.deepEqual(read, []);
		await db.close();
	});

	it("summarises a filing once, metered, and serves the cached summary after", async () => {
		const app = await createApp(parseConfig(await testEnv()));
		let calls = 0;
		const ai = {
			name: "fake",
			chatModel: "fake",
			embeddingModel: "fake",
			embed: async () => [],
			chat: async () => {
				calls++;
				return "Profit after tax rose 24% to ₦500bn in Q3.";
			},
		};
		let metered = 0;
		const service = new DisclosureService(
			app.db,
			ai,
			async () => {
				metered++;
				return async () => undefined;
			},
			fetchers,
		);
		await service.sync(new Date("2026-11-25T00:00:00Z"));
		const u = await user(app.db);
		assert.match((await service.summarize(5, u)).summary ?? "", /24%/);
		assert.equal((await service.summarize(5, u)).summary, "Profit after tax rose 24% to ₦500bn in Q3.");
		assert.equal(calls, 1);
		assert.equal(metered, 1);
		await assert.rejects(service.summarize(3, u), /scanned/);
		await assert.rejects(service.summarize(999, u), /not found/i);
		await app.close();
	});
});

describe("dividends in the personal digest", () => {
	it("reminds users of payouts they can still qualify for on stocks they hold or watch", async () => {
		const app = await createApp(parseConfig(await testEnv()));
		const today = new Date().toISOString().slice(0, 10);
		const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
		await app.db.market.upsertSecurities([security("MTNN", "MTN Nigeria"), security("ZENITH", "Zenith")]);
		await app.db.market.upsertPrices([
			...makeBars("MTNN", [240, 250], "NGX", inDays(-1)),
			...makeBars("ZENITH", [40, 41], "NGX", inDays(-1)),
		]);
		await app.db.disclosures.upsert(
			["MTNN", "ZENITH"].map((symbol, i) => ({
				id: i + 1,
				exchange: "NGX" as const,
				symbol,
				isin: `NG${symbol}`,
				kind: "corporate-action",
				category: "Corporate Actions",
				company: symbol,
				title: "INTERIM DIVIDEND ANNOUNCEMENT",
				url: `https://doclib.ngxgroup.com/${i}.pdf`,
				publishedAt: `${today}T08:00:00Z`,
			})),
		);
		for (const [i, symbol] of ["MTNN", "ZENITH"].entries()) {
			await app.db.disclosures.saveDividend({
				disclosureId: i + 1,
				exchange: "NGX",
				symbol,
				kind: "interim",
				amount: 5,
				currency: "NGN",
				qualificationDate: inDays(10),
				closureStart: null,
				closureEnd: null,
				paymentDate: inDays(20),
				agmDate: null,
				bonus: null,
				announcedAt: `${today}T08:00:00Z`,
			});
		}
		const u = await user(app.db);
		await app.portfolio.add(u, { symbol: "MTNN", exchange: "NGX", quantity: 10, avgCost: 200 });
		const body = (await app.digests.userDigest(u, today))?.paragraphs.join("\n") ?? "";
		assert.match(
			body,
			/\*\*Dividends\*\*\n💰 MTNN ₦5 interim dividend — buy by \d{4}-\d{2}-\d{2} to qualify \(you hold it\)/,
		);
		assert.doesNotMatch(body, /ZENITH/, "not held or watched");
		await app.close();
	});
});

after(dropTestDatabases);
