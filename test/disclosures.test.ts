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
	parseProposedDividend,
	splitTitle,
	toDisclosure,
} from "../src/markets/ngxDisclosures.js";
import { DisclosureService, dividendReader } from "../src/services/disclosureService.js";
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
	const KIND = {
		"Corporate Actions": "corporate-action",
		"Financial Statements": "financial-statements",
		"Annual General Meeting (AGM)": "agm",
	} as const;
	const filing = (id: number, isin: string, category: keyof typeof KIND, title: string, at: string): NgxDisclosure => ({
		id,
		isin,
		kind: KIND[category],
		category,
		title,
		company: "",
		url: `https://doclib.ngxgroup.com/${id}.pdf`,
		publishedAt: at,
	});
	/** Wording from Zenith Bank's 2026 AGM notice and audited results. */
	const ZENITH_AGM =
		"Notice is hereby given that the Thirty-fifth Annual General Meeting of Zenith Bank Plc will hold on Tuesday May 5, 2026 at the Civic Centre. 3. Closure of Register of Members The Register of Members and Transfer Books of the Company will be closed on April 27, 2026, to enable the Registrar prepare for the payment of dividend. 4. Dividend If approved, dividend for the sum of N8.75K for every share of 50K (bringing the total dividend for the financial year ended December 31, 2025 to N10.00K) will be paid via e-mandate on May 5, 2026, to shareholders whose names are registered in the register of members at the close of business on April 24, 2026.";
	const ZENITH_RESULTS =
		"The Directors, pursuant to the powers vested in it by the provisions of section 426 of the Companies and Allied Matters Act (CAMA 2020) of Nigeria, proposed a final dividend of N8.75 which in addition to the N1.25 per share as interim dividend amounts to N10.00 per share (2024: Interim dividend of N1.00 per share, final dividend of N4.00).";
	const texts: Record<string, string> = {
		"https://doclib.ngxgroup.com/1.pdf": UNILEVER,
		"https://doclib.ngxgroup.com/2.pdf": UNILEVER, // a reminder of the same payout
		"https://doclib.ngxgroup.com/3.pdf": "", // scanned
		"https://doclib.ngxgroup.com/7.pdf": ZENITH_RESULTS,
		"https://doclib.ngxgroup.com/8.pdf": ZENITH_AGM,
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
			filing(
				7,
				"NGZENITHBNK9",
				"Financial Statements",
				"AUDITED FINANCIAL STATEMENTS FOR THE YEAR ENDED 31 DECEMBER 2025",
				"2026-04-07T09:00:00Z",
			),
			filing(
				8,
				"NGZENITHBNK9",
				"Annual General Meeting (AGM)",
				"NOTICE OF ANNUAL GENERAL MEETING (AGM)",
				"2026-04-10T09:00:00Z",
			),
		],
		issuers: async () => [
			{ isin: "NGUNILEVER01", symbol: "UNILEVER", name: "Unilever Nigeria", sharesOutstanding: null },
			{ isin: "NGGTCO000002", symbol: "GTCO", name: "GTCO", sharesOutstanding: null },
			{ isin: "NGZENITHBNK9", symbol: "ZENITHBANK", name: "Zenith Bank", sharesOutstanding: null },
		],
		filing: async (url: string) => {
			read.push(url);
			const text = texts[url] ?? "Quarter 3 results: profit after tax rose 24% to N500bn.";
			return { text, pages: 2, pdf: new Uint8Array([1]) };
		},
	};
	const noMeter = async () => async () => undefined;
	const stubAI = (answers: { chat?: string; pdf?: string }) => ({
		name: "fake",
		chatModel: "fake",
		embeddingModel: "fake",
		calls: { chat: 0, pdf: 0 },
		embed: async () => [],
		async chat() {
			this.calls.chat++;
			return answers.chat ?? "";
		},
		async readPdf() {
			this.calls.pdf++;
			return answers.pdf ?? "";
		},
	});

	it("reads notices, AGM notices and results; skips everything else; builds history and yields", async () => {
		const db = await memoryDb();
		read.length = 0;
		const service = new DisclosureService(db, null, noMeter, fetchers);
		const r = await service.sync(new Date("2026-11-25T00:00:00Z"));
		assert.equal(r.fetched, 8);
		assert.equal(r.dividendsFound, 4); // Unilever twice, Zenith's proposal and its AGM notice
		assert.equal(r.scanned, 1);
		assert.equal(r.transcribed, 0, "no AI configured");
		// The appointment and the Q3 results weren't downloaded; the unknown ISIN has no symbol.
		assert.deepEqual(read.map((u) => u.replace("https://doclib.ngxgroup.com/", "")).sort(), [
			"1.pdf",
			"2.pdf",
			"3.pdf",
			"7.pdf",
			"8.pdf",
		]);
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

		// The results' proposal and the AGM notice are one payout, kept with the AGM notice's dates.
		const zenith = await dividendSummary(db, "NGX", "ZENITHBANK", "2026-04-20");
		assert.equal(zenith.history.length, 1);
		assert.deepEqual(
			[zenith.next?.kind, zenith.next?.amount, zenith.next?.qualificationDate, zenith.next?.paymentDate],
			["final", 8.75, "2026-04-24", "2026-05-05"],
		);

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

	it("has the AI model transcribe scanned notices, then reads them like any other", async () => {
		const db = await memoryDb();
		const ai = stubAI({ pdf: UNILEVER.replace("Unilever", "GTCO") });
		const r = await new DisclosureService(db, ai, noMeter, fetchers).sync(new Date("2026-11-25T00:00:00Z"));
		assert.equal(r.transcribed, 1);
		assert.equal(ai.calls.pdf, 1);
		assert.equal((await dividendSummary(db, "NGX", "GTCO", "2026-10-28")).next?.amount, 2);
		await db.close();
	});

	it("queues scans when the model fails, pauses, and transcribes them on a later sync", async () => {
		const db = await memoryDb();
		const ai = stubAI({ pdf: UNILEVER.replace("Unilever", "GTCO") });
		const failing = { ...ai, readPdf: async () => Promise.reject(new Error("429: spending cap")) };
		const t0 = new Date("2026-11-25T00:00:00Z");
		const first = await new DisclosureService(db, failing, noMeter, fetchers).sync(t0);
		assert.equal(first.transcribed, 0);
		assert.equal((await db.disclosures.untranscribedScans("NGX", 10)).length, 1, "still queued");
		// Paused: even a working model isn't called within the next few hours…
		const service = new DisclosureService(db, ai, noMeter, fetchers);
		assert.equal((await service.sync(new Date(t0.getTime() + 3600_000))).transcribed, 0);
		assert.equal(ai.calls.pdf, 0);
		// …and after that, the queued scan is transcribed and read.
		const later = await service.sync(new Date(t0.getTime() + 7 * 3600_000));
		assert.equal(later.transcribed, 1);
		assert.equal(later.dividendsFound, 1);
		assert.equal((await db.disclosures.untranscribedScans("NGX", 10)).length, 0);
		await db.close();
	});

	it("keeps equal quarterly dividends apart but merges amended dates", async () => {
		const db = await memoryDb();
		const d = (id: number, q: string, at: string) => ({
			disclosureId: id,
			exchange: "NGX" as const,
			symbol: "SEPLAT",
			kind: "interim",
			amount: 0.036,
			currency: "USD",
			qualificationDate: q,
			closureStart: null,
			closureEnd: null,
			paymentDate: null,
			agmDate: null,
			bonus: null,
			announcedAt: at,
		});
		await db.disclosures.upsert(
			[1, 2, 3].map((id) => ({
				id,
				exchange: "NGX" as const,
				symbol: "SEPLAT",
				isin: "NGSEPLAT0008",
				kind: "corporate-action",
				category: "Corporate Actions",
				company: "SEPLAT",
				title: "INTERIM DIVIDEND",
				url: `https://doclib.ngxgroup.com/${id}.pdf`,
				publishedAt: "2026-05-01T00:00:00Z",
			})),
		);
		await db.disclosures.saveDividend(d(1, "2026-05-15", "2026-05-01T00:00:00Z"));
		await db.disclosures.saveDividend(d(2, "2026-05-19", "2026-05-08T00:00:00Z")); // amended dates
		await db.disclosures.saveDividend(d(3, "2026-08-14", "2026-07-30T00:00:00Z")); // next quarter
		const list = await db.disclosures.dividends({ exchange: "NGX", symbol: "SEPLAT" });
		assert.deepEqual(
			list.map((x) => x.qualificationDate),
			["2026-08-14", "2026-05-19"],
		);
		await db.close();
	});

	it("summarises a filing once, metered, reading scans directly, and serves the cached summary after", async () => {
		const app = await createApp(parseConfig(await testEnv()));
		const ai = stubAI({
			chat: "Profit after tax rose 24% to ₦500bn in Q3.",
			pdf: "GTCO declared a ₦1 interim dividend.",
		});
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
		assert.equal(ai.calls.chat, 1);
		assert.equal(metered, 1);
		assert.match((await service.summarize(3, u)).summary ?? "", /interim dividend/, "a scan is read by the model");
		await assert.rejects(service.summarize(999, u), /not found/i);
		await app.close();
	});

	it("chooses which filings to read", () => {
		assert.equal(dividendReader({ kind: "agm", title: "NOTICE OF ANNUAL GENERAL MEETING" })?.mode, "agm");
		assert.equal(dividendReader({ kind: "agm", title: "RESOLUTIONS PASSED AT THE AGM NOTICE" }), null);
		assert.equal(
			dividendReader({
				kind: "financial-statements",
				title: "AUDITED FINANCIAL STATEMENT FOR THE YEAR ENDED 31 DECEMBER 2025",
			})?.mode,
			"results",
		);
		assert.equal(
			dividendReader({ kind: "financial-statements", title: "QUARTER 1 - FINANCIAL STATEMENT FOR 2026" }),
			null,
		);
		assert.equal(dividendReader({ kind: "directors-dealings", title: "DIRECTORSDEALINGS" }), null);
	});

	it("reads a board's proposed dividend from results, ignoring comparatives and refusals", () => {
		assert.deepEqual(parseProposedDividend(ZENITH_RESULTS), { kind: "final", amount: 8.75, currency: "NGN" });
		assert.equal(
			parseProposedDividend("The Board of Directors has not proposed a final dividend (Dec 2024: N3.00)."),
			null,
		);
		assert.equal(parseProposedDividend("(2024: proposed final dividend of N4.00 per share)"), null);
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
