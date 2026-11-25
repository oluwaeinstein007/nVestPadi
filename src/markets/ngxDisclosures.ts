/**
 * NGX corporate disclosures and dividends, from NGX's own document library (doclib.ngxgroup.com, free and public):
 *
 * - the disclosures list: every filing (financial statements, corporate actions, directors' dealings, board and AGM
 *   notices) with its title, PDF link, ISIN and time, queryable for the whole market through SharePoint's REST API;
 * - the company directory, which maps ISINs to ticker symbols;
 * - the filings themselves. Dividend notices follow NGX's template ("Proposed Dividend … Closure of Register …
 *   Qualification Date … Payment Date"), so amounts and dates are read from the PDF text. Scanned notices have no
 *   text and are kept as links only.
 */
import { getJson, request } from "../lib/http.js";
import { toNumber } from "../lib/util.js";

const DOCLIB = "https://doclib.ngxgroup.com";
/** The SharePoint list behind ngxgroup.com's "Corporate Disclosures" pages. */
const DISCLOSURES_LIST = `${DOCLIB}/_api/Web/Lists(guid'13a54dad-cf15-4eb4-a4fe-ea461b729ddb')/Items`;
const DIRECTORY = `${DOCLIB}/REST/api/issuers/companydirectory`;
const ODATA = { Accept: "application/json;odata=verbose" };
const PAGE = 500;

export type DisclosureKind =
	| "financial-statements"
	| "corporate-action"
	| "directors-dealings"
	| "board-meeting"
	| "agm"
	| "other";

export interface NgxDisclosure {
	/** The list item id: stable, increasing. */
	id: number;
	isin: string;
	kind: DisclosureKind;
	/** NGX's own category label, e.g. "Corporate Actions". */
	category: string;
	/** "GUARANTY TRUST HOLDING COMPANY PLC-2026 INTERIM DIVIDEND ANNOUNCEMENT" → the part after the company name. */
	title: string;
	company: string;
	url: string;
	/** ISO timestamp. */
	publishedAt: string;
}

export interface NgxIssuer {
	isin: string;
	symbol: string;
	name: string;
	sharesOutstanding: number | null;
}

interface ListItem {
	Id: number;
	URL?: { Description?: string; Url?: string } | null;
	InternationSecIN?: string | null;
	Type_of_Submission?: string | null;
	Modified?: string;
}

/** Filings published (or re-published) since `since` (ISO), oldest first. */
export async function fetchDisclosures(since: string): Promise<NgxDisclosure[]> {
	const out: NgxDisclosure[] = [];
	// SharePoint's `__next` link for the following page comes already encoded.
	let url: string | null = encodeURI(
		`${DISCLOSURES_LIST}?$select=Id,URL,InternationSecIN,Type_of_Submission,Modified` +
			`&$filter=Modified ge datetime'${since.slice(0, 19)}Z'&$orderby=Modified asc&$top=${PAGE}`,
	);
	for (let page = 0; url && page < 40; page++) {
		const body: { d?: { results?: ListItem[]; __next?: string } } = await getJson(url, { headers: ODATA });
		for (const item of body.d?.results ?? []) {
			const d = toDisclosure(item);
			if (d) out.push(d);
		}
		url = body.d?.__next ?? null;
	}
	return out;
}

export function toDisclosure(item: ListItem): NgxDisclosure | null {
	const href = item.URL?.Url;
	const isin = item.InternationSecIN?.trim();
	if (!href || !isin || !item.Modified) return null;
	const category = (item.Type_of_Submission ?? "").trim();
	const { company, title } = splitTitle(item.URL?.Description ?? "");
	return {
		id: item.Id,
		isin,
		kind: kindOf(category),
		category,
		title,
		company,
		url: href,
		publishedAt: item.Modified,
	};
}

/** ISIN → listed symbol for every NGX issuer. */
export async function fetchIssuers(): Promise<NgxIssuer[]> {
	const rows = await getJson<unknown>(DIRECTORY);
	if (!Array.isArray(rows)) throw new Error("Unexpected NGX company directory response (expected an array)");
	const seen = new Set<string>();
	const out: NgxIssuer[] = [];
	for (const r of rows as Record<string, unknown>[]) {
		const isin = String(r.InternationSecIN ?? "").trim();
		const symbol = String(r.Symbol ?? "")
			.trim()
			.toUpperCase();
		if (!isin || !symbol || seen.has(isin)) continue;
		seen.add(isin);
		out.push({
			isin,
			symbol,
			name: String(r.CompanyName ?? symbol).trim(),
			sharesOutstanding: toNumber(r.SharesOutstanding),
		});
	}
	return out;
}

export interface Filing {
	/** Text of the first `maxPages` pages, whitespace collapsed; "" for a scanned document. */
	text: string;
	pages: number;
	/** The PDF itself, for reading scans with an AI model. */
	pdf: Uint8Array;
}

/** Download a filing and extract the text of its first `maxPages` pages (results run to hundreds). */
export async function fetchFiling(url: string, maxPages = 20): Promise<Filing> {
	const res = await request(url, { timeoutMs: 60_000 });
	const pdf = new Uint8Array(await res.arrayBuffer());
	const { getDocumentProxy } = await import("unpdf");
	// pdf.js may detach the buffer it's given, so it gets a copy.
	const doc = await getDocumentProxy(pdf.slice(), { verbosity: 0 });
	const parts: string[] = [];
	for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
		const content = await (await doc.getPage(i)).getTextContent();
		parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
	}
	return { text: parts.join(" ").replace(/\s+/g, " ").trim(), pages: doc.numPages, pdf };
}

function kindOf(category: string): DisclosureKind {
	const c = category.toLowerCase();
	if (c.startsWith("financial")) return "financial-statements";
	if (c.startsWith("corporate action")) return "corporate-action";
	if (c.startsWith("directors")) return "directors-dealings";
	if (c.startsWith("board")) return "board-meeting";
	if (c.includes("general meeting")) return "agm";
	return "other";
}

/** "UNILEVER NIGERIA PLC - INTERIM DIVIDEND ANNOUNCEMENT" → company + title (the first " - " or "-" after "PLC"). */
export function splitTitle(description: string): { company: string; title: string } {
	const clean = description.replace(/\s+/g, " ").trim();
	const m = /^(.*?\b(?:PLC|LIMITED|LTD|FUND|INCORPORATED|REIT|TRUST|ETF)\.?)\s*[-–]\s*(.+)$/i.exec(clean);
	if (m) return { company: (m[1] as string).trim(), title: (m[2] as string).trim() };
	const dash = clean.indexOf("-");
	return dash > 0
		? { company: clean.slice(0, dash).trim(), title: clean.slice(dash + 1).trim() }
		: { company: "", title: clean };
}

// -- Dividend notices ------------------------------------------------------------------------------

/** Titles that announce a dividend's amount and dates (not exchange rates, unclaimed lists, policies, forms…). */
export function isDividendNotice(title: string): boolean {
	return (
		/\b(dividends?|distribution|closure of register|qualification date)\b/i.test(title) &&
		!/exchange rate|currency|unclaimed|policy|closed period|election form|reference price|mandate|e-?dividend registration|scrip/i.test(
			title,
		)
	);
}

/**
 * Corporate actions with a generic title ("CORPORATE ACTION ANNOUNCEMENT", "ANNOUNCEMENT", "NOTICE") that may carry a
 * dividend in NGX's template, as opposed to ones that clearly don't (board changes, insider dealings, …).
 */
export function mayHoldDividend(title: string): boolean {
	return (
		/\b(corporate actions?|announcements?|notices?|notifications?|disclosures?|updates?)\b/i.test(title) &&
		!/board|director|appoint|resign|retire|insider|dealing|meeting date|closed period|unclaimed|exchange rate|currency|merger|acquisition|holding|share award|buy-?back|rights issue|listing|auditor|secretary|registrar|policy|scheme|court|litigation|rating|bond|commercial paper|voting rights|change of name|address/i.test(
			title,
		)
	);
}

export interface DividendNotice {
	kind: "interim" | "final" | "special" | "dividend";
	/** Per share/unit, in `currency`. */
	amount: number;
	currency: "NGN" | "USD";
	/** Be on the register at the close of this day to receive it. */
	qualificationDate: string | null;
	closureStart: string | null;
	closureEnd: string | null;
	paymentDate: string | null;
	agmDate: string | null;
	/** Bonus shares, e.g. "1 for 10", when proposed alongside. */
	bonus: string | null;
}

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];
const MONTH =
	"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
// "15h" and "20st" are real typos in NGX notices.
const DAY = "(\\d{1,2})(?:st|nd|rd|th|h)?";
const DATE_PATTERNS: RegExp[] = [
	// 29th day of April, 2026 · 10 April 2026 · 30th of April 2026
	new RegExp(`${DAY}(?:\\s+day)?(?:\\s+of)?\\s+${MONTH}\\s*,?\\s+(\\d{4})`, "i"),
	// July 3, 2026 · July 3rd 2026
	new RegExp(`${MONTH}\\s+${DAY}\\s*,?\\s+(\\d{4})`, "i"),
	// 30/10/2026
	/(\d{1,2})\/(\d{1,2})\/(\d{4})/,
];

/** The first date in `text` as YYYY-MM-DD, or null. */
export function parseDate(text: string): string | null {
	let best: { at: number; iso: string } | null = null;
	for (const [i, re] of DATE_PATTERNS.entries()) {
		const m = re.exec(text);
		if (!m) continue;
		let day: number;
		let month: number;
		let year: number;
		if (i === 0) [day, month, year] = [Number(m[1]), monthIndex(m[2] as string), Number(m[3])];
		else if (i === 1) [day, month, year] = [Number(m[2]), monthIndex(m[1] as string), Number(m[3])];
		else [day, month, year] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
		if (month < 0 || day < 1 || day > 31) continue;
		const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		if (!best || m.index < best.at) best = { at: m.index, iso };
	}
	return best?.iso ?? null;
}

function monthIndex(name: string): number {
	const n = name.toLowerCase().slice(0, 3);
	return MONTHS.findIndex((m) => m.startsWith(n));
}

/** Labels in NGX's dividend template, used to cut the text into sections. */
const LABELS = [
	"Proposed Dividend",
	"Proposed Bonus",
	"Closure of Register",
	"Qualification Date",
	"Payment Date",
	"AGM Date",
	"Date of AGM",
	"Annual General Meeting",
	"E-Dividend",
	"Unclaimed Dividend",
];

/** The text after the `nth` mention of `label` up to the next template label (at most `max` characters). */
function section(text: string, label: string, max = 260, nth = 0): string | null {
	let i = -1;
	for (let k = 0; k <= nth; k++) {
		i = text.toLowerCase().indexOf(label.toLowerCase(), i + 1);
		if (i < 0) return null;
	}
	const rest = text.slice(i + label.length, i + label.length + max);
	let end = rest.length;
	for (const other of LABELS) {
		if (other.toLowerCase() === label.toLowerCase()) continue;
		const j = rest.toLowerCase().indexOf(other.toLowerCase());
		if (j > 0 && j < end) end = j;
	}
	return rest.slice(0, end);
}

/**
 * "N1.25", "₦8.28", "N2.00 kobo" (₦2), "12.5k", "30 kobo", "$0.0333", "US4 cents" → amount + currency. When a total
 * comes first ("₦442,026,861.70 amounting to ₦108,472.85 per unit"), the amount right before "per share/unit" wins.
 */
export function parseAmount(text: string): { amount: number; currency: "NGN" | "USD" } | null {
	const t = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
	type Money = { at: number; amount: number; currency: "NGN" | "USD" };
	const found: Money[] = [];
	const scan = (re: RegExp, f: (m: RegExpExecArray) => Omit<Money, "at">) => {
		for (const m of t.matchAll(re)) {
			const v = f(m);
			if (v.amount > 0) found.push({ at: m.index ?? 0, ...v });
		}
	};
	scan(/(?:₦|\bN|\bNGN)\s?(\d+(?:\.\d+)?)/gi, (m) => ({ amount: Number(m[1]), currency: "NGN" }));
	// "N1.60 Kobo" means ₦1.60: a number right after a naira sign is never kobo.
	scan(/(?<![₦\d.])(?<!\bN\s?)(?<!NGN\s?)(\d+(?:\.\d+)?)\s?(?:k\b|kobo\b)/gi, (m) => ({
		amount: Number(m[1]) / 100,
		currency: "NGN",
	}));
	scan(/(?:US\$|\$|\bUSD)\s?(\d+(?:\.\d+)?)/gi, (m) => ({ amount: Number(m[1]), currency: "USD" }));
	scan(/(?<![\d.])(\d+(?:\.\d+)?)\s?(?:US\s)?cents?\b/gi, (m) => ({ amount: Number(m[1]) / 100, currency: "USD" }));
	if (found.length === 0) return null;
	found.sort((a, b) => a.at - b.at);
	// A total first ("₦442m amounting to ₦108,472.85 per unit"): take the per-unit amount. Otherwise the first amount
	// wins, so a later comparison ("…in addition to the N1.25 per share interim") isn't mistaken for it.
	const first = found[0] as Money;
	const per = /\bper\s+(?:\d+\s*kobo\s+)?(?:ordinary\s+)?(?:share|unit)/i.exec(t);
	const perUnit = per ? found.filter((m) => m.at < per.index).at(-1) : undefined;
	const pick = perUnit && first.amount >= 100 * perUnit.amount ? perUnit : first;
	return { amount: pick.amount, currency: pick.currency };
}

/**
 * Read a dividend notice's text: NGX's labelled template first, then the prose AGM notices use ("…will be paid on
 * May 5, 2026, to shareholders … at the close of business on April 24, 2026"). Null when it doesn't state an amount.
 * `defaultKind` applies when the notice doesn't say (an AGM declares the final dividend).
 */
export function parseDividendNotice(
	text: string,
	defaultKind: DividendNotice["kind"] = "dividend",
): DividendNotice | null {
	const t = text.replace(/\s+/g, " ");
	// The amount sits under "Proposed Dividend" in NGX's template; letters and fund notices state it anywhere.
	const pattern =
		/\b(?:(interim|final|special)\s+)?(?:dividends?|distribution)\s+(?:payment\s+)?(?:of|amounting to|(?:in|for) the sum of)\s+(.{0,120})/i;
	const proposed = section(t, "Proposed Dividend", 400) ?? t;
	const of = pattern.exec(proposed) ?? pattern.exec(t);
	const amount = parseAmount(of?.[2] ?? "");
	if (!of || !amount) return null;
	const kind = (of[1]?.toLowerCase() ??
		(/\binterim\b/i.test(proposed)
			? "interim"
			: /\bfinal\b/i.test(proposed)
				? "final"
				: defaultKind)) as DividendNotice["kind"];

	const qualificationDate = labelledDate(t, "Qualification Date") ?? proseDate(t, QUALIFIED_PROSE);
	let paymentDate = labelledDate(t, "Payment Date") ?? proseDate(t, PAID_PROSE);
	const closure = section(t, "Closure of Register") ?? CLOSED_PROSE.exec(t)?.[0] ?? "";
	const fromTo = /closed\s+(?:from|on)\s+(.{0,60}?)(?:\s+to\s+(.{0,60}))?(?:[.(]|$)/i.exec(closure);
	let closureEnd = fromTo?.[2] ? parseDate(fromTo[2]) : null;
	// "from the 11th of May to the 15th of May 2026": the start borrows the end's year.
	let closureStart = fromTo
		? (parseDate(fromTo[1] as string) ?? (closureEnd ? parseDate(`${fromTo[1]} ${closureEnd.slice(0, 4)}`) : null))
		: parseDate(closure);
	if (!closureStart && fromTo && closureEnd) closureStart = dayOnly(fromTo[1] as string, closureEnd);
	const agmDate = labelledDate(t, "AGM Date") ?? labelledDate(t, "Date of AGM") ?? proseDate(t, AGM_PROSE);
	const bonusText = section(t, "Proposed Bonus", 120) ?? "";
	const bonus = /\b(\d+)\s+(?:new\s+)?(?:ordinary\s+)?shares?\s+for\s+(?:every\s+)?(\d+)/i.exec(bonusText);

	// Notices are sometimes typed with last year's date; dates after the qualification date can't precede it.
	if (qualificationDate) {
		paymentDate = notBefore(paymentDate, qualificationDate);
		closureStart = notBefore(closureStart, qualificationDate);
		closureEnd = notBefore(closureEnd, qualificationDate);
	}
	return {
		kind,
		amount: amount.amount,
		currency: amount.currency,
		qualificationDate,
		closureStart,
		closureEnd,
		paymentDate,
		agmDate,
		bonus: bonus ? `${bonus[1]} for ${bonus[2]}` : null,
	};
}

/** Prose that AGM notices and letters use instead of NGX's labels; the date follows each match. */
const QUALIFIED_PROSE =
	/names?\s+(?:appear|are\s+registered|are)\b[^.]{0,80}?register\s+of\s+(?:members|shareholders)[^.]{0,40}?(?:as\s+at|as\s+of|at\s+the\s+close\s+of\s+business\s+on|on)\s+/gi;
const PAID_PROSE = /\b(?:will|shall)\s+be\s+paid\b[^.]{0,60}?\bon\s+/gi;
const CLOSED_PROSE = /register[^.]{0,80}?(?:will|shall)\s+be\s+closed\s+(?:from|on)\s+[^.]{0,120}/i;
const AGM_PROSE = /annual\s+general\s+meeting\b[^.]{0,100}?(?:will|shall)\s+(?:hold|be\s+held)\s+(?:on\s+)?/gi;

/** The date right after the first match of `pattern` (a global regex) that is followed by one. */
function proseDate(text: string, pattern: RegExp): string | null {
	for (const m of text.matchAll(pattern)) {
		const at = (m.index ?? 0) + m[0].length;
		const date = parseDate(text.slice(at, at + 45));
		if (date) return date;
	}
	return null;
}

/**
 * A dividend the board proposes in its results ("…proposed a final dividend of N8.75…"), which come before the
 * AGM notice with the dates. Prior-year comparatives ("2024: final dividend of N4.00") and "has not proposed" are
 * ignored. Null when there's none.
 */
export function parseProposedDividend(text: string): Pick<DividendNotice, "kind" | "amount" | "currency"> | null {
	const t = text.replace(/\s+/g, " ");
	const re =
		/\b(propos\w*|recommend\w*)\s+(?:the\s+)?(?:payment\s+of\s+)?(?:an?\s+)?(?:(interim|final|special)\s+)?dividends?\s+(?:of|amounting\s+to|(?:in|for)\s+the\s+sum\s+of)\s+(.{0,80})/gi;
	for (const m of t.matchAll(re)) {
		const before = t.slice(Math.max(0, (m.index ?? 0) - 25), m.index);
		if (/\b(?:not|no)\s*$/i.test(before) || /\(\s*\d{4}\s*:/.test(before)) continue;
		const amount = parseAmount(m[3] as string);
		if (amount) return { kind: (m[2]?.toLowerCase() ?? "final") as DividendNotice["kind"], ...amount };
	}
	return null;
}

/** The date after the first mention of `label` that has one ("…as at the Qualification Date…" comes earlier). */
function labelledDate(text: string, label: string): string | null {
	for (let nth = 0; nth < 4; nth++) {
		const part = section(text, label, 260, nth);
		if (part === null) return null;
		const date = parseDate(part);
		if (date) return date;
	}
	return null;
}

/** "20st" in "closed from 20st to 24th April 2026": the day, with the end date's month and year. */
function dayOnly(text: string, end: string): string | null {
	const m = /^\s*(?:the\s+)?(\d{1,2})(?:st|nd|rd|th|h)?\b/i.exec(text);
	if (!m) return null;
	const iso = `${end.slice(0, 8)}${String(m[1]).padStart(2, "0")}`;
	return iso <= end ? iso : null;
}

/** A date typed with the wrong year (earlier than `floor`) moved forward a year at a time; null stays null. */
function notBefore(date: string | null, floor: string): string | null {
	if (!date || date >= floor) return date;
	let d = date;
	for (let i = 0; i < 2 && d < floor; i++) d = `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
	return d >= floor ? d : date;
}
