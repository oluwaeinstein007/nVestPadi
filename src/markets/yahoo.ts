/**
 * US equities via Yahoo Finance's public chart API (no API key required).
 */
import { HttpError, getJson } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { isoDate, mapLimit, round } from "../lib/util.js";
import { CURRENCY, type MarketSnapshot, type PriceBar, type Security } from "./types.js";

export const YAHOO_RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"] as const;
export type YahooRange = (typeof YAHOO_RANGES)[number];

interface ChartResult {
	meta: {
		symbol: string;
		longName?: string;
		shortName?: string;
		currency?: string;
		chartPreviousClose?: number;
		exchangeName?: string;
		fullExchangeName?: string;
	};
	timestamp?: number[];
	indicators: {
		quote: {
			open: (number | null)[];
			high: (number | null)[];
			low: (number | null)[];
			close: (number | null)[];
			volume: (number | null)[];
		}[];
	};
}

async function fetchChart(symbol: string, range: string): Promise<MarketSnapshot> {
	const ticker = symbol.trim().toUpperCase();
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
	let data: { chart?: { result?: ChartResult[] | null } };
	try {
		data = await getJson(url, { retries: 3 });
	} catch (err) {
		if (err instanceof HttpError && err.status === 404) throw new Error(`Unknown US symbol ${ticker}`);
		throw err;
	}
	const result = data.chart?.result?.[0];
	if (!result) throw new Error(`No Yahoo Finance data for ${ticker}`);

	const q = result.indicators.quote[0];
	const timestamps = result.timestamp ?? [];
	const bars: PriceBar[] = [];
	let prevClose = result.meta.chartPreviousClose ?? null;
	for (let i = 0; i < timestamps.length; i++) {
		const close = q?.close[i];
		if (close == null) continue;
		const change = prevClose !== null ? close - prevClose : null;
		bars.push({
			exchange: "US",
			symbol: ticker,
			date: isoDate(new Date((timestamps[i] as number) * 1000)),
			open: q?.open[i] ?? null,
			high: q?.high[i] ?? null,
			low: q?.low[i] ?? null,
			close: round(close, 4),
			volume: q?.volume[i] ?? null,
			change: change !== null ? round(change, 4) : null,
			changePct: change !== null && prevClose ? round((change / prevClose) * 100, 2) : null,
			trades: null,
			value: null,
		});
		prevClose = close;
	}

	const security: Security = {
		exchange: "US",
		symbol: ticker,
		name: result.meta.longName ?? result.meta.shortName ?? ticker,
		sector: null,
		currency: result.meta.currency ?? CURRENCY.US,
		venue: usVenue(result.meta.exchangeName, result.meta.fullExchangeName),
	};
	return { securities: [security], bars };
}

const VENUES: Record<string, string> = {
	NMS: "Nasdaq",
	NGM: "Nasdaq",
	NCM: "Nasdaq",
	NAS: "Nasdaq",
	NYQ: "NYSE",
	NYS: "NYSE",
	ASE: "NYSE American",
	PCX: "NYSE Arca",
	BTS: "Cboe",
};

/** Yahoo exchange codes ("NMS", "NYQ") → the venue names investors know. */
export function usVenue(code?: string, full?: string): string | null {
	if (code && VENUES[code]) return VENUES[code] as string;
	if (full?.startsWith("Nasdaq")) return "Nasdaq";
	return full ?? null;
}

export function fetchUsHistory(symbol: string, range: YahooRange = "1y"): Promise<MarketSnapshot> {
	return fetchChart(symbol, range);
}

/** Latest session (plus prior few, for change calculation) for many symbols. */
export async function fetchUsSnapshot(symbols: string[]): Promise<MarketSnapshot & { failed: string[] }> {
	const failed: string[] = [];
	const results = await mapLimit(symbols, 4, async (symbol) => {
		try {
			return await fetchChart(symbol, "5d");
		} catch (err) {
			logger.warn(`could not fetch ${symbol}`, { error: err instanceof Error ? err.message : String(err) });
			failed.push(symbol);
			return null;
		}
	});
	const ok = results.filter((r): r is MarketSnapshot => r !== null);
	return {
		securities: ok.flatMap((r) => r.securities),
		bars: ok.flatMap((r) => r.bars),
		failed,
	};
}
