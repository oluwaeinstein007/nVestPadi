/**
 * Keeps NGX filings and dividends up to date, and summarises filings with AI on request.
 *
 * Each sync fetches filings published since the newest one stored (the first sync goes back `BACKFILL_DAYS` so
 * trailing yields have a year of dividends), matches ISINs to symbols, then reads a bounded number of filings that
 * can carry a dividend:
 *
 * - corporate-action notices (NGX's dividend template, or a generic title carrying it);
 * - AGM notices, which state the final dividend and its dates in prose;
 * - full-year and half-year results (first pages only), where a board proposes a dividend before the AGM notice
 *   gives its dates. These are recorded without dates and give way to the dated notice when it arrives.
 *
 * Scanned notices have no text. When an AI provider is configured, a separate pass has the model transcribe them
 * and the same parser reads the transcript; scans stay queued until that succeeds (including ones found before AI
 * was set up), and the pass pauses for a few hours after a model error (e.g. a spending cap) instead of retrying.
 * Everything else is marked checked without downloading anything.
 */
import type { AIProvider } from "../ai/provider.js";
import { AppError, FeatureUnavailableError, NotFoundError } from "../lib/errors.js";
import { errorMessage, logger } from "../lib/logger.js";
import {
	type Filing,
	type NgxDisclosure,
	type NgxIssuer,
	fetchDisclosures,
	fetchFiling,
	fetchIssuers,
	isDividendNotice,
	mayHoldDividend,
	parseDividendNotice,
	parseProposedDividend,
} from "../markets/ngxDisclosures.js";
import type { Database } from "../storage/database.js";
import type { Disclosure } from "../storage/repositories/disclosures.js";
import type { User } from "../storage/repositories/users.js";

export interface DisclosureFetchers {
	disclosures(since: string): Promise<NgxDisclosure[]>;
	issuers(): Promise<NgxIssuer[]>;
	filing(url: string, maxPages?: number): Promise<Filing>;
}

const NETWORK: DisclosureFetchers = { disclosures: fetchDisclosures, issuers: fetchIssuers, filing: fetchFiling };

export interface DisclosureSyncResult {
	fetched: number;
	dividendsFound: number;
	/** Filings downloaded and read this sync. */
	noticesRead: number;
	/** Of those, scans (no text). */
	scanned: number;
	/** Scans transcribed by the AI model. */
	transcribed: number;
}

/** How a filing is read for a dividend, or null when it can't carry one. */
type Reader = { mode: "notice" | "titled-notice" | "agm" | "results"; maxPages: number };

export function dividendReader(d: Pick<Disclosure, "kind" | "title">): Reader | null {
	if (d.kind === "corporate-action") {
		if (isDividendNotice(d.title)) return { mode: "titled-notice", maxPages: 10 };
		return mayHoldDividend(d.title) ? { mode: "notice", maxPages: 10 } : null;
	}
	if (d.kind === "agm") {
		return /notice/i.test(d.title) && !/resolution|proxy|live\s*-?stream|link/i.test(d.title)
			? { mode: "agm", maxPages: 6 }
			: null;
	}
	if (d.kind === "financial-statements") {
		return /audited|year[\s-]*end|full[\s-]*year|annual|half[\s-]*year|\bh1\b|interim|quarter\s*[245]\b|\bq[24]\b/i.test(
			d.title,
		)
			? { mode: "results", maxPages: 12 }
			: null;
	}
	return null;
}

const BACKFILL_DAYS = 400;
/** PDFs read per sync, so a first sync doesn't hammer NGX (the rest follow on later syncs). */
const MAX_READS = 80;
/** Scans transcribed per sync (each is a model call). */
const MAX_TRANSCRIPTIONS = 20;
/** Longer scans aren't dividend notices worth a model call. */
const MAX_SCAN_PAGES = 6;
/** After a model error (e.g. a spending cap), wait this long before trying again. */
const PAUSE_MS = 6 * 3600_000;
const PAUSE_KEY = "ngx-filings:transcription-paused-until";
/** NGX re-publishes corrected filings with a new time; look back a little to catch them. */
const OVERLAP_MS = 2 * 86_400_000;
const ISSUER_TTL_MS = 12 * 3600_000;
/** Text sent to the model when summarising (a results PDF can run to hundreds of pages). */
const SUMMARY_CHARS = 12_000;
const SUMMARY_PAGES = 15;
const TRANSCRIBE =
	"Transcribe all the text in this document exactly as written, as plain text, in reading order. No commentary, no formatting, no corrections.";
const SUMMARISE =
	"You summarise Nigerian Exchange (NGX) company filings for retail investors. In at most 3 short sentences, say what changed and why it might matter to a shareholder: figures with their period and direction (e.g. profit up 24% year on year), dividends with amount and dates, board or ownership changes, deadlines. Use only the filing's content; if it's routine (e.g. a reminder or a form), say so in one sentence. No advice, no speculation.";

export class DisclosureService {
	private issuers: { at: number; map: Map<string, string> } | null = null;

	constructor(
		private readonly db: Database,
		private readonly ai: AIProvider | null,
		private readonly meter: (user: User) => Promise<() => Promise<void>>,
		private readonly fetch: DisclosureFetchers = NETWORK,
	) {}

	async sync(now = new Date()): Promise<DisclosureSyncResult> {
		const latest = await this.db.disclosures.latestPublishedAt("NGX");
		const since = latest
			? new Date(Date.parse(latest) - OVERLAP_MS)
			: new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
		const [filings, symbols] = await Promise.all([this.fetch.disclosures(since.toISOString()), this.issuerMap()]);
		await this.db.disclosures.upsert(
			filings.map((f) => ({
				id: f.id,
				exchange: "NGX",
				symbol: symbols.get(f.isin) ?? null,
				isin: f.isin,
				kind: f.kind,
				category: f.category,
				company: f.company,
				title: f.title,
				url: f.url,
				publishedAt: f.publishedAt,
			})),
		);
		await this.db.disclosures.assignSymbols("NGX", symbols);
		const read = await this.readFilings();
		const scans = await this.transcribeScans(now);
		return {
			fetched: filings.length,
			...read,
			transcribed: scans.transcribed,
			dividendsFound: read.dividendsFound + scans.dividendsFound,
		};
	}

	/** Read pending filings that can carry a dividend (bounded per run); mark the rest checked. */
	private async readFilings(): Promise<Omit<DisclosureSyncResult, "fetched" | "transcribed">> {
		const out = { noticesRead: 0, dividendsFound: 0, scanned: 0 };
		for (const d of await this.db.disclosures.unchecked("NGX", 3000)) {
			const reader = dividendReader(d);
			if (!reader) {
				await this.db.disclosures.markChecked(d.id, false);
				continue;
			}
			if (out.noticesRead >= MAX_READS) continue;
			out.noticesRead++;
			let filing: Filing;
			try {
				filing = await this.fetch.filing(d.url, reader.maxPages);
			} catch (err) {
				// Left unchecked, so the next sync retries it.
				logger.warn("couldn't read NGX filing", { id: d.id, error: errorMessage(err) });
				continue;
			}
			const isScan = filing.text.length < 50;
			if (isScan) out.scanned++;
			else if (await this.saveDividend(d, reader, filing.text)) out.dividendsFound++;
			// A long scan (a results document) isn't worth a model call, so it isn't queued for transcription.
			await this.db.disclosures.markChecked(
				d.id,
				isScan && reader.mode !== "results" && filing.pages <= MAX_SCAN_PAGES,
			);
		}
		return out;
	}

	/** Have the model transcribe queued scans and read them for dividends. */
	private async transcribeScans(now: Date): Promise<{ transcribed: number; dividendsFound: number }> {
		const out = { transcribed: 0, dividendsFound: 0 };
		if (!this.ai) return out;
		const paused = await this.db.jobs.get(PAUSE_KEY);
		if (paused && paused > now.toISOString()) return out;
		for (const d of await this.db.disclosures.untranscribedScans("NGX", MAX_TRANSCRIPTIONS)) {
			const reader = dividendReader(d);
			try {
				const filing = await this.fetch.filing(d.url, 1);
				if (reader && filing.pages <= MAX_SCAN_PAGES) {
					const text = await this.ai.readPdf(filing.pdf, TRANSCRIBE);
					if (await this.saveDividend(d, reader, text)) out.dividendsFound++;
				}
				await this.db.disclosures.markTranscribed(d.id);
				out.transcribed++;
			} catch (err) {
				await this.db.jobs.set(PAUSE_KEY, new Date(now.getTime() + PAUSE_MS).toISOString());
				logger.warn("pausing transcription of scanned NGX filings", { id: d.id, error: errorMessage(err) });
				break;
			}
		}
		return out;
	}

	private async saveDividend(d: Disclosure, reader: Reader, text: string): Promise<boolean> {
		if (text.length < 50 || !d.symbol) return false;
		const base = { disclosureId: d.id, exchange: "NGX" as const, symbol: d.symbol, announcedAt: d.publishedAt };
		if (reader.mode === "results") {
			const proposed = parseProposedDividend(text);
			if (!proposed) return false;
			await this.db.disclosures.saveDividend({
				...base,
				...proposed,
				qualificationDate: null,
				closureStart: null,
				closureEnd: null,
				paymentDate: null,
				agmDate: null,
				bonus: null,
			});
			return true;
		}
		const notice = parseDividendNotice(text, reader.mode === "agm" ? "final" : "dividend");
		// Only a dividend-titled notice counts without dates: elsewhere a bare amount is usually a passing mention.
		const dated = Boolean(notice?.qualificationDate || notice?.paymentDate);
		if (!notice || (reader.mode !== "titled-notice" && !dated)) return false;
		await this.db.disclosures.saveDividend({ ...base, ...notice });
		return true;
	}

	private async issuerMap(): Promise<Map<string, string>> {
		if (this.issuers && Date.now() - this.issuers.at < ISSUER_TTL_MS) return this.issuers.map;
		try {
			const map = new Map((await this.fetch.issuers()).map((i) => [i.isin, i.symbol]));
			this.issuers = { at: Date.now(), map };
			return map;
		} catch (err) {
			logger.warn("NGX company directory unavailable; filings stored without symbols for now", {
				error: errorMessage(err),
			});
			return this.issuers?.map ?? new Map();
		}
	}

	/**
	 * A plain-English "what changed" for one filing, generated once and cached for everyone. Generating one counts as
	 * one of the user's AI questions; reading a cached one is free. Scans are read by the model directly.
	 */
	async summarize(id: number, user: User): Promise<Disclosure> {
		const d = await this.db.disclosures.get(id);
		if (!d) throw new NotFoundError("Filing not found");
		if (d.summary) return d;
		if (!this.ai) throw new FeatureUnavailableError("AI summaries", ["AI_PROVIDER", "AI_API_KEY"]);
		const refund = await this.meter(user);
		try {
			const filing = await this.fetch.filing(d.url, SUMMARY_PAGES);
			const heading = `Filing: ${d.company} — ${d.title}`;
			let summary: string;
			if (filing.text.length >= 50) {
				summary = await this.ai.chat([
					{ role: "system", content: SUMMARISE },
					{ role: "user", content: `${heading}\n\n${filing.text.slice(0, SUMMARY_CHARS)}` },
				]);
			} else if (filing.pages <= SUMMARY_PAGES) {
				summary = await this.ai.readPdf(filing.pdf, `${SUMMARISE}\n\n${heading}`);
			} else {
				throw new AppError(
					"This filing is a long scanned document, so it can't be summarised. Open the PDF instead.",
					422,
					"scanned_filing",
				);
			}
			summary = summary.trim();
			if (!summary) throw new AppError("The AI model returned no summary. Try again later.", 502, "empty_summary");
			await this.db.disclosures.setSummary(d.id, summary);
			return { ...d, summary };
		} catch (err) {
			await refund();
			throw err;
		}
	}
}
