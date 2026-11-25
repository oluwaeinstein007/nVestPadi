/**
 * Keeps NGX filings and dividends up to date, and summarises filings with AI on request.
 *
 * Each sync fetches filings published since the newest one stored (the first sync goes back `BACKFILL_DAYS` so
 * trailing yields have a year of dividends), matches ISINs to symbols, then reads a bounded number of dividend
 * notices' PDFs. Notices that aren't about a dividend are marked checked without downloading anything.
 */
import type { AIProvider } from "../ai/provider.js";
import { AppError, FeatureUnavailableError, NotFoundError } from "../lib/errors.js";
import { errorMessage, logger } from "../lib/logger.js";
import {
	type NgxDisclosure,
	type NgxIssuer,
	fetchDisclosures,
	fetchFilingText,
	fetchIssuers,
	isDividendNotice,
	mayHoldDividend,
	parseDividendNotice,
} from "../markets/ngxDisclosures.js";
import type { Database } from "../storage/database.js";
import type { Disclosure } from "../storage/repositories/disclosures.js";
import type { User } from "../storage/repositories/users.js";

export interface DisclosureFetchers {
	disclosures(since: string): Promise<NgxDisclosure[]>;
	issuers(): Promise<NgxIssuer[]>;
	text(url: string): Promise<string>;
}

const NETWORK: DisclosureFetchers = { disclosures: fetchDisclosures, issuers: fetchIssuers, text: fetchFilingText };

export interface DisclosureSyncResult {
	fetched: number;
	dividendsFound: number;
	noticesRead: number;
	scanned: number;
}

const BACKFILL_DAYS = 400;
/** PDFs read per sync, so a first sync doesn't hammer NGX (the rest follow on later syncs). */
const MAX_READS = 80;
/** NGX re-publishes corrected filings with a new time; look back a little to catch them. */
const OVERLAP_MS = 2 * 86_400_000;
const ISSUER_TTL_MS = 12 * 3600_000;
/** Text sent to the model when summarising (a results PDF can run to hundreds of pages). */
const SUMMARY_CHARS = 12_000;
const SCANNED = "This filing is a scanned image, so it can't be summarised. Open the PDF instead.";

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
		const read = await this.readDividendNotices();
		return { fetched: filings.length, ...read };
	}

	/** Read pending dividend notices (bounded per run); mark other corporate actions as checked. */
	private async readDividendNotices(): Promise<Omit<DisclosureSyncResult, "fetched">> {
		let noticesRead = 0;
		let dividendsFound = 0;
		let scanned = 0;
		for (const d of await this.db.disclosures.uncheckedCorporateActions("NGX", 2000)) {
			const titled = isDividendNotice(d.title);
			if (!titled && !mayHoldDividend(d.title)) {
				await this.db.disclosures.markChecked(d.id, false);
				continue;
			}
			if (noticesRead >= MAX_READS) continue;
			noticesRead++;
			let text: string;
			try {
				text = await this.fetch.text(d.url);
			} catch (err) {
				// Left unchecked, so the next sync retries it.
				logger.warn("couldn't read NGX filing", { id: d.id, error: errorMessage(err) });
				continue;
			}
			const isScan = text.length < 50;
			if (isScan) scanned++;
			const parsed = isScan ? null : parseDividendNotice(text);
			// A generic notice only counts when it carries the template's dates, not a passing "recommended dividend".
			const notice = parsed && (titled || parsed.qualificationDate) ? parsed : null;
			if (notice && d.symbol) {
				await this.db.disclosures.saveDividend({
					disclosureId: d.id,
					exchange: "NGX",
					symbol: d.symbol,
					...notice,
					announcedAt: d.publishedAt,
				});
				dividendsFound++;
			}
			await this.db.disclosures.markChecked(d.id, isScan);
		}
		return { noticesRead, dividendsFound, scanned };
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
	 * one of the user's AI questions; reading a cached one is free.
	 */
	async summarize(id: number, user: User): Promise<Disclosure> {
		const d = await this.db.disclosures.get(id);
		if (!d) throw new NotFoundError("Filing not found");
		if (d.summary) return d;
		if (!this.ai) throw new FeatureUnavailableError("AI summaries", ["AI_PROVIDER", "AI_API_KEY"]);
		if (d.scanned) throw new AppError(SCANNED, 422, "scanned_filing");
		const refund = await this.meter(user);
		try {
			const text = (await this.fetch.text(d.url)).slice(0, SUMMARY_CHARS);
			if (text.length < 50) {
				await this.db.disclosures.markChecked(d.id, true);
				throw new AppError(SCANNED, 422, "scanned_filing");
			}
			const summary = (
				await this.ai.chat([
					{
						role: "system",
						content:
							"You summarise Nigerian Exchange (NGX) company filings for retail investors. In at most 3 short sentences, say what changed and why it might matter to a shareholder: figures with their period and direction (e.g. profit up 24% year on year), dividends with amount and dates, board or ownership changes, deadlines. Use only the filing's text; if it's routine (e.g. a reminder or a form), say so in one sentence. No advice, no speculation.",
					},
					{ role: "user", content: `Filing: ${d.company} — ${d.title}\n\n${text}` },
				])
			).trim();
			await this.db.disclosures.setSummary(d.id, summary);
			return { ...d, summary };
		} catch (err) {
			await refund();
			throw err;
		}
	}
}
