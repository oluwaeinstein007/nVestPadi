import type { Exchange } from "../../markets/types.js";
import type { Database, Param, Row } from "../database.js";
import { placeholders, slices, timestamp, valuesList } from "../driver.js";
import { flag, str } from "../rows.js";

export interface Disclosure {
	id: number;
	exchange: Exchange;
	/** Null when the filer isn't a listed equity we know (e.g. a bond or a delisted company). */
	symbol: string | null;
	isin: string;
	kind: string;
	category: string;
	company: string;
	title: string;
	url: string;
	publishedAt: string;
	/** No text in the PDF (a scan): only the link is available. */
	scanned: boolean;
	summary: string | null;
}

export type NewDisclosure = Omit<Disclosure, "scanned" | "summary">;

export interface Dividend {
	disclosureId: number;
	exchange: Exchange;
	symbol: string;
	kind: string;
	amount: number;
	currency: string;
	qualificationDate: string | null;
	closureStart: string | null;
	closureEnd: string | null;
	paymentDate: string | null;
	agmDate: string | null;
	bonus: string | null;
	/** When the notice was published. */
	announcedAt: string;
	/** The notice's PDF. */
	url?: string;
}

const REPEAT_WINDOW_MS = 120 * 86_400_000;
/** Amended notices move dates by days, not months. */
const SAME_DATES_MS = 21 * 86_400_000;

/** Filings and the dividends read from them. */
export class DisclosureRepository {
	constructor(private readonly db: Database) {}

	/** Insert or refresh filings (NGX re-publishes corrected ones under the same id). */
	async upsert(items: NewDisclosure[]): Promise<void> {
		if (items.length === 0) return;
		await this.db.transaction(async () => {
			for (const batch of slices(items, 50)) {
				await this.db.run(
					`INSERT INTO disclosures (id, exchange, symbol, isin, kind, category, company, title, url, published_at)
					 VALUES ${valuesList(batch.length, 10)}
					 ON CONFLICT (id) DO UPDATE SET
						symbol = COALESCE(excluded.symbol, disclosures.symbol), kind = excluded.kind,
						category = excluded.category, company = excluded.company, title = excluded.title,
						url = excluded.url, published_at = excluded.published_at`,
					batch.flatMap((d) => [
						d.id,
						d.exchange,
						d.symbol,
						d.isin,
						d.kind,
						d.category,
						d.company,
						d.title,
						d.url,
						d.publishedAt,
					]),
				);
			}
		});
	}

	/** Fill in symbols for filings stored before their ISIN could be matched. */
	async assignSymbols(exchange: Exchange, isinToSymbol: Map<string, string>): Promise<number> {
		let changed = 0;
		const rows = await this.db.all("SELECT DISTINCT isin FROM disclosures WHERE exchange = ? AND symbol IS NULL", [
			exchange,
		]);
		for (const r of rows) {
			const symbol = isinToSymbol.get(String(r.isin));
			if (!symbol) continue;
			changed += (
				await this.db.run("UPDATE disclosures SET symbol = ? WHERE exchange = ? AND isin = ? AND symbol IS NULL", [
					symbol,
					exchange,
					String(r.isin),
				])
			).changes;
		}
		return changed;
	}

	async get(id: number): Promise<Disclosure | null> {
		const row = await this.db.get("SELECT * FROM disclosures WHERE id = ?", [id]);
		return row ? toDisclosure(row) : null;
	}

	async latestPublishedAt(exchange: Exchange): Promise<string | null> {
		return str((await this.db.get("SELECT MAX(published_at) AS m FROM disclosures WHERE exchange = ?", [exchange]))?.m);
	}

	/** Filings of listed companies not yet checked for a dividend, newest first. */
	async unchecked(exchange: Exchange, limit: number): Promise<Disclosure[]> {
		const rows = await this.db.all(
			`SELECT * FROM disclosures
			 WHERE exchange = ? AND dividend_checked_at IS NULL AND symbol IS NOT NULL
			 ORDER BY published_at DESC LIMIT ?`,
			[exchange, limit],
		);
		return rows.map(toDisclosure);
	}

	/** Scanned filings of listed companies an AI model hasn't transcribed yet, newest first. */
	async untranscribedScans(exchange: Exchange, limit: number): Promise<Disclosure[]> {
		const rows = await this.db.all(
			`SELECT * FROM disclosures
			 WHERE exchange = ? AND scanned = 1 AND transcribed_at IS NULL AND symbol IS NOT NULL
			 ORDER BY published_at DESC LIMIT ?`,
			[exchange, limit],
		);
		return rows.map(toDisclosure);
	}

	async markTranscribed(id: number): Promise<void> {
		await this.db.run("UPDATE disclosures SET transcribed_at = ? WHERE id = ?", [timestamp(), id]);
	}

	async markChecked(id: number, scanned: boolean): Promise<void> {
		await this.db.run("UPDATE disclosures SET dividend_checked_at = ?, scanned = ? WHERE id = ?", [
			timestamp(),
			scanned ? 1 : 0,
			id,
		]);
	}

	async forSymbol(exchange: Exchange, symbol: string, limit = 20): Promise<Disclosure[]> {
		const rows = await this.db.all(
			"SELECT * FROM disclosures WHERE exchange = ? AND symbol = ? ORDER BY published_at DESC LIMIT ?",
			[exchange, symbol, limit],
		);
		return rows.map(toDisclosure);
	}

	async setSummary(id: number, summary: string): Promise<void> {
		await this.db.run("UPDATE disclosures SET summary = ?, summarized_at = ? WHERE id = ?", [summary, timestamp(), id]);
	}

	async saveDividend(d: Dividend): Promise<void> {
		await this.db.run(
			`INSERT INTO dividends (disclosure_id, exchange, symbol, kind, amount, currency, qualification_date,
				closure_start, closure_end, payment_date, agm_date, bonus, announced_at)
			 VALUES (${placeholders(13)})
			 ON CONFLICT (disclosure_id) DO UPDATE SET kind = excluded.kind, amount = excluded.amount,
				currency = excluded.currency, qualification_date = excluded.qualification_date,
				closure_start = excluded.closure_start, closure_end = excluded.closure_end,
				payment_date = excluded.payment_date, agm_date = excluded.agm_date, bonus = excluded.bonus`,
			[
				d.disclosureId,
				d.exchange,
				d.symbol,
				d.kind,
				d.amount,
				d.currency,
				d.qualificationDate,
				d.closureStart,
				d.closureEnd,
				d.paymentDate,
				d.agmDate,
				d.bonus,
				d.announcedAt,
			],
		);
	}

	/**
	 * Dividends matching the filters, newest first, with repeat notices of the same payout (reminders, corrections)
	 * collapsed into the latest one.
	 */
	async dividends(
		filter: { exchange: Exchange; symbol?: string; qualifiedFrom?: string; qualifiedTo?: string },
		limit = 200,
	): Promise<Dividend[]> {
		const where = ["v.exchange = ?"];
		const params: Param[] = [filter.exchange];
		if (filter.symbol) {
			where.push("v.symbol = ?");
			params.push(filter.symbol);
		}
		if (filter.qualifiedFrom) {
			where.push("v.qualification_date >= ?");
			params.push(filter.qualifiedFrom);
		}
		if (filter.qualifiedTo) {
			where.push("v.qualification_date <= ?");
			params.push(filter.qualifiedTo);
		}
		const rows = await this.db.all(
			`SELECT v.*, d.url FROM dividends v JOIN disclosures d ON d.id = v.disclosure_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY COALESCE(v.qualification_date, substr(v.announced_at, 1, 10)) DESC, v.announced_at DESC`,
			params,
		);
		// One payout is often announced several times: proposed in the results, dated in the AGM notice or a
		// corporate action, then reminded or amended. Same security and amount within a few months is the same payout
		// unless both have qualification dates weeks apart (e.g. equal quarterly dividends). Rows come dated-first, so
		// the version with dates is the one kept.
		const kept = new Map<string, Dividend[]>();
		const out: Dividend[] = [];
		for (const r of rows) {
			const d = toDividend(r);
			const key = `${d.symbol}|${d.currency}|${d.amount}`;
			const same = kept.get(key) ?? [];
			if (same.some((k) => samePayout(k, d))) continue;
			kept.set(key, [...same, d]);
			out.push(d);
			if (out.length >= limit) break;
		}
		return out;
	}
}

function samePayout(a: Dividend, b: Dividend): boolean {
	if (Math.abs(Date.parse(a.announcedAt) - Date.parse(b.announcedAt)) > REPEAT_WINDOW_MS) return false;
	if (!a.qualificationDate || !b.qualificationDate) return true;
	return Math.abs(Date.parse(a.qualificationDate) - Date.parse(b.qualificationDate)) <= SAME_DATES_MS;
}

function toDisclosure(r: Row): Disclosure {
	return {
		id: Number(r.id),
		exchange: r.exchange as Exchange,
		symbol: str(r.symbol),
		isin: String(r.isin),
		kind: String(r.kind),
		category: String(r.category),
		company: String(r.company),
		title: String(r.title),
		url: String(r.url),
		publishedAt: String(r.published_at),
		scanned: flag(r.scanned),
		summary: str(r.summary),
	};
}

function toDividend(r: Row): Dividend {
	return {
		disclosureId: Number(r.disclosure_id),
		exchange: r.exchange as Exchange,
		symbol: String(r.symbol),
		kind: String(r.kind),
		amount: Number(r.amount),
		currency: String(r.currency),
		qualificationDate: str(r.qualification_date),
		closureStart: str(r.closure_start),
		closureEnd: str(r.closure_end),
		paymentDate: str(r.payment_date),
		agmDate: str(r.agm_date),
		bonus: str(r.bonus),
		announcedAt: String(r.announced_at),
		url: str(r.url) ?? undefined,
	};
}
