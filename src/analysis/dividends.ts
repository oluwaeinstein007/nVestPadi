/**
 * Dividend calendar and yields from the dividends read out of NGX notices.
 *
 * - To receive a dividend you must be on the register at the close of the qualification date, and a purchase only
 *   reaches the register once it settles. NGX equities settle T+2 (since Nov 2025; a move to T+1 was scheduled for
 *   June 2026), so "buy by" is two trading days before the qualification date: early enough under either cycle.
 *   Public holidays aren't counted, so confirm with your broker close to the date.
 * - Trailing yield = naira dividends with a qualification date in the past 12 months ÷ the latest price. Dividends
 *   declared in dollars (e.g. dual-listed companies) are listed but left out of naira yields.
 */
import { round } from "../lib/util.js";
import type { Exchange, Quote } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { Dividend } from "../storage/repositories/disclosures.js";

export const SETTLEMENT_DAYS = 2;

export interface DividendEvent extends Dividend {
	name: string;
	price: number | null;
	/** This payout as a share of the latest price (%), naira dividends only. */
	payoutYieldPct: number | null;
	/** Last trading day to buy and still qualify (estimate). */
	buyBy: string | null;
	/**
	 * open: you can still buy and qualify. qualified: too late to qualify, payment pending. paid: payment date passed.
	 * unknown: the notice gave no dates.
	 */
	status: "open" | "qualified" | "paid" | "unknown";
}

export interface DividendSummary {
	exchange: Exchange;
	symbol: string;
	/** Naira dividends over the past 12 months, per share. */
	trailingAmount: number;
	trailingYieldPct: number | null;
	/** Payouts in the past 12 months. */
	trailingCount: number;
	next: DividendEvent | null;
	history: DividendEvent[];
}

/** `date` minus `days` weekdays (YYYY-MM-DD). */
export function tradingDaysBefore(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	let left = days;
	while (left > 0) {
		d.setUTCDate(d.getUTCDate() - 1);
		const wd = d.getUTCDay();
		if (wd !== 0 && wd !== 6) left--;
	}
	return d.toISOString().slice(0, 10);
}

export function toEvent(d: Dividend, quote: Pick<Quote, "name" | "close"> | undefined, today: string): DividendEvent {
	const price = quote?.close ?? null;
	const buyBy = d.qualificationDate ? tradingDaysBefore(d.qualificationDate, SETTLEMENT_DAYS) : null;
	const status: DividendEvent["status"] =
		d.paymentDate && d.paymentDate < today
			? "paid"
			: buyBy && today <= buyBy
				? "open"
				: d.qualificationDate
					? "qualified"
					: "unknown";
	return {
		...d,
		name: quote?.name ?? d.symbol,
		price,
		payoutYieldPct: d.currency === "NGN" && price ? round((d.amount / price) * 100, 2) : null,
		buyBy,
		status,
	};
}

const daysAgo = (today: string, n: number) =>
	new Date(new Date(`${today}T00:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Market-wide calendar: payouts whose qualification date is from `pastDays` ago onwards (soonest first), plus
 * recently announced ones without dates yet.
 */
export async function dividendCalendar(
	db: Database,
	exchange: Exchange,
	options: { today?: string; pastDays?: number } = {},
): Promise<DividendEvent[]> {
	const today = options.today ?? new Date().toISOString().slice(0, 10);
	const from = daysAgo(today, options.pastDays ?? 14);
	const [all, quotes] = await Promise.all([
		db.disclosures.dividends({ exchange }, 1000),
		db.market.latestQuotes(exchange),
	]);
	const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
	return all
		.filter((d) =>
			d.qualificationDate ? d.qualificationDate >= from : d.announcedAt.slice(0, 10) >= daysAgo(today, 60),
		)
		.map((d) => toEvent(d, bySymbol.get(d.symbol), today))
		.sort((a, b) => (a.qualificationDate ?? "9999").localeCompare(b.qualificationDate ?? "9999"));
}

/** One security's payout history, trailing yield and next dividend. */
export async function dividendSummary(
	db: Database,
	exchange: Exchange,
	symbol: string,
	today = new Date().toISOString().slice(0, 10),
): Promise<DividendSummary> {
	const [list, quotes] = await Promise.all([
		db.disclosures.dividends({ exchange, symbol }, 100),
		db.market.latestQuotes(exchange),
	]);
	const quote = quotes.find((q) => q.symbol === symbol);
	const history = list.map((d) => toEvent(d, quote, today));
	const yearAgo = daysAgo(today, 365);
	const trailing = history.filter((d) => {
		const on = d.qualificationDate ?? d.announcedAt.slice(0, 10);
		return d.currency === "NGN" && on >= yearAgo && on <= today;
	});
	const trailingAmount = round(
		trailing.reduce((s, d) => s + d.amount, 0),
		4,
	);
	const upcoming = history
		.filter((d) => d.status === "open" || d.status === "qualified")
		.sort((a, b) => (a.qualificationDate ?? "").localeCompare(b.qualificationDate ?? ""));
	return {
		exchange,
		symbol,
		trailingAmount,
		trailingYieldPct: quote?.close && trailingAmount > 0 ? round((trailingAmount / quote.close) * 100, 2) : null,
		trailingCount: trailing.length,
		next: upcoming[0] ?? null,
		history,
	};
}
