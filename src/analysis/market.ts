import { mapLimit, round } from "../lib/util.js";
import type { Exchange, Quote } from "../markets/types.js";
/**
 * Market-wide views over the latest session: breadth, movers, sector
 * performance, and a screener with optional technical filters.
 */
import type { Database } from "../storage/database.js";
import { rsi } from "./technicalAnalysis.js";

export interface SectorPerformance {
	sector: string;
	count: number;
	avgChangePct: number;
	advancers: number;
	decliners: number;
	value: number;
}

export interface MarketOverview {
	exchange: Exchange;
	date: string | null;
	count: number;
	advancers: number;
	decliners: number;
	unchanged: number;
	totalVolume: number;
	totalValue: number;
	gainers: Quote[];
	losers: Quote[];
	mostActive: Quote[];
	sectors: SectorPerformance[];
}

/** Only quotes from the exchange's most recent session (stale symbols excluded). */
async function currentSession(db: Database, exchange: Exchange): Promise<{ date: string | null; quotes: Quote[] }> {
	const quotes = await db.market.latestQuotes(exchange);
	const date = quotes.reduce<string | null>((max, q) => (max === null || q.date > max ? q.date : max), null);
	return { date, quotes: quotes.filter((q) => q.date === date) };
}

const tradedValue = (q: Quote) => q.value ?? (q.volume ?? 0) * q.close;

export async function marketOverview(db: Database, exchange: Exchange, top = 5): Promise<MarketOverview> {
	const { date, quotes } = await currentSession(db, exchange);
	const withChange = quotes.filter((q) => q.changePct !== null);
	const byChange = [...withChange].sort((a, b) => (b.changePct as number) - (a.changePct as number));

	const sectorMap = new Map<string, Quote[]>();
	for (const q of quotes) {
		const key = q.sector ?? "Other";
		sectorMap.set(key, [...(sectorMap.get(key) ?? []), q]);
	}
	const sectors = [...sectorMap.entries()]
		.map(([sector, list]) => {
			const changes = list.map((q) => q.changePct ?? 0);
			return {
				sector,
				count: list.length,
				avgChangePct: round(changes.reduce((a, b) => a + b, 0) / list.length, 2),
				advancers: changes.filter((c) => c > 0).length,
				decliners: changes.filter((c) => c < 0).length,
				value: round(
					list.reduce((s, q) => s + tradedValue(q), 0),
					0,
				),
			};
		})
		.sort((a, b) => b.avgChangePct - a.avgChangePct);

	return {
		exchange,
		date,
		count: quotes.length,
		advancers: withChange.filter((q) => (q.changePct as number) > 0).length,
		decliners: withChange.filter((q) => (q.changePct as number) < 0).length,
		unchanged: quotes.length - withChange.filter((q) => q.changePct !== 0).length,
		totalVolume: quotes.reduce((s, q) => s + (q.volume ?? 0), 0),
		totalValue: round(
			quotes.reduce((s, q) => s + tradedValue(q), 0),
			0,
		),
		gainers: byChange.filter((q) => (q.changePct as number) > 0).slice(0, top),
		losers: byChange
			.filter((q) => (q.changePct as number) < 0)
			.reverse()
			.slice(0, top),
		mostActive: [...quotes].sort((a, b) => tradedValue(b) - tradedValue(a)).slice(0, top),
		sectors,
	};
}

export const SCREEN_SORTS = ["gainers", "losers", "active", "volume", "price", "symbol", "rsi"] as const;
export type ScreenSort = (typeof SCREEN_SORTS)[number];

export interface ScreenOptions {
	exchange: Exchange;
	sector?: string;
	query?: string;
	minPrice?: number;
	maxPrice?: number;
	minChangePct?: number;
	maxChangePct?: number;
	rsiBelow?: number;
	rsiAbove?: number;
	sort?: ScreenSort;
	limit?: number;
}

export interface ScreenRow extends Quote {
	rsi14: number | null;
	tradedValue: number;
}

export async function screen(db: Database, options: ScreenOptions): Promise<ScreenRow[]> {
	const { quotes } = await currentSession(db, options.exchange);
	const sector = options.sector?.toLowerCase();
	const query = options.query?.toLowerCase();
	const needsRsi = options.rsiBelow !== undefined || options.rsiAbove !== undefined || options.sort === "rsi";

	let rows: ScreenRow[] = quotes
		.filter((q) => !sector || q.sector?.toLowerCase().includes(sector))
		.filter((q) => !query || q.symbol.toLowerCase().includes(query) || q.name.toLowerCase().includes(query))
		.filter((q) => options.minPrice === undefined || q.close >= options.minPrice)
		.filter((q) => options.maxPrice === undefined || q.close <= options.maxPrice)
		.filter((q) => options.minChangePct === undefined || (q.changePct ?? 0) >= options.minChangePct)
		.filter((q) => options.maxChangePct === undefined || (q.changePct ?? 0) <= options.maxChangePct)
		.map((q) => ({ ...q, rsi14: null, tradedValue: round(tradedValue(q), 0) }));

	if (needsRsi) {
		rows = await mapLimit(rows, 8, async (r) => {
			const closes = (await db.market.history(r.exchange, r.symbol, 120)).map((b) => b.close);
			const value = rsi(closes, 14).at(-1);
			return { ...r, rsi14: value === undefined || Number.isNaN(value) ? null : round(value, 1) };
		});
		rows = rows.filter(
			(r) =>
				(options.rsiBelow === undefined || (r.rsi14 !== null && r.rsi14 < options.rsiBelow)) &&
				(options.rsiAbove === undefined || (r.rsi14 !== null && r.rsi14 > options.rsiAbove)),
		);
	}

	const sorters: Record<ScreenSort, (a: ScreenRow, b: ScreenRow) => number> = {
		gainers: (a, b) => (b.changePct ?? Number.NEGATIVE_INFINITY) - (a.changePct ?? Number.NEGATIVE_INFINITY),
		losers: (a, b) => (a.changePct ?? Number.POSITIVE_INFINITY) - (b.changePct ?? Number.POSITIVE_INFINITY),
		active: (a, b) => b.tradedValue - a.tradedValue,
		volume: (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
		price: (a, b) => b.close - a.close,
		symbol: (a, b) => a.symbol.localeCompare(b.symbol),
		rsi: (a, b) => (a.rsi14 ?? Number.POSITIVE_INFINITY) - (b.rsi14 ?? Number.POSITIVE_INFINITY),
	};
	rows.sort(sorters[options.sort ?? "gainers"]);
	return options.limit ? rows.slice(0, options.limit) : rows;
}
