/**
 * Nigerian Exchange (NGX) data.
 *
 * - Daily snapshot: NGX's public equities statistics API (full OHLC, volume,
 *   trades, value, sector for every listed equity).
 * - Company names + recent history: afx.kwayisi.org (best-effort; history is
 *   the last ~10 sessions, close and volume only). Longer NGX history builds up
 *   in the local database as `nvest sync` runs each trading day.
 */
import * as cheerio from "cheerio";
import { getJson, getText } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { round, toNumber } from "../lib/util.js";
import { CURRENCY, type MarketSnapshot, type PriceBar, type Security } from "./types.js";

const NGX_API = "https://doclib.ngxgroup.com/REST/api/statistics/equities/";
const AFX_BASE = "https://afx.kwayisi.org/ngx";
const PAGE_SIZE = 300;

interface NgxApiRow {
	Symbol?: string;
	Company2?: string;
	Sector?: string;
	TradeDate?: string;
	OpeningPrice?: number | string;
	HighPrice?: number | string;
	LowPrice?: number | string;
	ClosePrice?: number | string;
	PrevClosingPrice?: number | string;
	Change?: number | string;
	PercChange?: number | string;
	Volume?: number | string;
	Trades?: number | string;
	Value?: number | string;
}

const SMALL_WORDS = new Set(["and", "of", "the", "&"]);
const ACRONYMS = new Set(["ICT"]);

/** "OIL AND GAS" → "Oil and Gas", "ICT" stays "ICT". */
export function titleCase(s: string): string {
	return s
		.toLowerCase()
		.split(/(\s+|\/)/)
		.map((word, i) => {
			if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
			if (i > 0 && SMALL_WORDS.has(word)) return word;
			return word.charAt(0).toUpperCase() + word.slice(1);
		})
		.join("");
}

export async function fetchNgxSnapshot(): Promise<MarketSnapshot> {
	const rows: NgxApiRow[] = [];
	for (let page = 0; ; page++) {
		const url = `${NGX_API}?market=&sector=&orderby=&pageSize=${PAGE_SIZE}&pageNo=${page}`;
		const data = await getJson<unknown>(url);
		if (!Array.isArray(data)) throw new Error("Unexpected NGX API response (expected an array)");
		rows.push(...(data as NgxApiRow[]));
		if (data.length < PAGE_SIZE) break;
	}

	const names = await fetchAfxNames().catch((err) => {
		logger.debug("afx name lookup failed; using NGX symbols as names", { error: String(err) });
		return new Map<string, string>();
	});

	const securities: Security[] = [];
	const bars: PriceBar[] = [];
	for (const row of rows) {
		const symbol = row.Symbol?.trim().toUpperCase();
		const close = toNumber(row.ClosePrice);
		if (!symbol || close === null) continue;

		securities.push({
			exchange: "NGX",
			symbol,
			name: names.get(symbol) ?? (row.Company2?.trim() || symbol),
			sector: row.Sector ? titleCase(row.Sector.trim()) : null,
			currency: CURRENCY.NGX,
		});

		const prev = toNumber(row.PrevClosingPrice);
		const change = toNumber(row.Change) ?? (prev !== null ? round(close - prev, 4) : null);
		bars.push({
			exchange: "NGX",
			symbol,
			date: (row.TradeDate ?? new Date().toISOString()).slice(0, 10),
			open: toNumber(row.OpeningPrice),
			high: toNumber(row.HighPrice),
			low: toNumber(row.LowPrice),
			close,
			volume: toNumber(row.Volume),
			change,
			changePct: toNumber(row.PercChange) ?? (prev ? round(((close - prev) / prev) * 100, 2) : null),
			trades: toNumber(row.Trades),
			value: toNumber(row.Value),
		});
	}
	return { securities, bars };
}

/** Ticker → company name from the (paginated) afx.kwayisi.org listing. */
async function fetchAfxNames(maxPages = 5): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	for (let page = 1; page <= maxPages; page++) {
		const url = page === 1 ? `${AFX_BASE}/` : `${AFX_BASE}/?page=${page}`;
		const $ = cheerio.load(await getText(url, { retries: 0, timeoutMs: 10_000 }));
		const before = names.size;
		$("table tbody tr").each((_, tr) => {
			const cells = $(tr).find("td");
			const ticker = $(cells[0]).text().trim().toUpperCase();
			const name = $(cells[1]).text().trim();
			if (cells.length >= 5 && ticker && name) names.set(ticker, name);
		});
		if (names.size === before || $(`a[href*="page=${page + 1}"]`).length === 0) break;
	}
	return names;
}

/** Recent daily history for an NGX symbol (close + volume; ~10 sessions). */
export async function fetchNgxHistory(symbol: string): Promise<MarketSnapshot> {
	const ticker = symbol.trim().toUpperCase();
	const html = await getText(`${AFX_BASE}/${encodeURIComponent(ticker.toLowerCase())}.html`);
	const $ = cheerio.load(html);

	// Columns: Date | Volume | Close | Change | Change%
	const bars: PriceBar[] = [];
	$("table[data-hist] tbody tr").each((_, tr) => {
		const cells = $(tr).find("td");
		const date = $(cells[0]).text().trim();
		const close = toNumber($(cells[2]).text());
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null) return;
		bars.push({
			exchange: "NGX",
			symbol: ticker,
			date,
			open: null,
			high: null,
			low: null,
			close,
			volume: toNumber($(cells[1]).text()),
			change: toNumber($(cells[3]).text()) ?? 0,
			changePct: toNumber($(cells[4]).text()) ?? 0,
			trades: null,
			value: null,
		});
	});
	if (bars.length === 0) throw new Error(`No NGX history found for ${ticker}`);

	const title = $("h1").first().text().trim();
	const name = title.replace(/\s*\(NGX:[^)]*\).*$/i, "").trim() || ticker;
	return {
		securities: [{ exchange: "NGX", symbol: ticker, name, sector: null, currency: CURRENCY.NGX }],
		bars: bars.reverse(),
	};
}
