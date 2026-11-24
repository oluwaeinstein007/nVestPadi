/**
 * Yahoo Finance's public chart API (no API key required):
 * - US equities: daily history and the latest sessions
 * - crypto: daily OHLC history ("BTC-USD"), which CoinGecko only has as closes
 * - intraday 5-minute candles and the near-live price for both
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
		regularMarketPrice?: number;
		regularMarketTime?: number;
		regularMarketDayHigh?: number;
		regularMarketDayLow?: number;
		regularMarketVolume?: number;
		previousClose?: number;
		currentTradingPeriod?: { regular?: { start: number; end: number } };
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

async function fetchResult(
	yahooSymbol: string,
	interval: string,
	range: string,
	unknown: string,
): Promise<ChartResult> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
	let data: { chart?: { result?: ChartResult[] | null } };
	try {
		data = await getJson(url, { retries: 3 });
	} catch (err) {
		if (err instanceof HttpError && err.status === 404) throw new Error(unknown);
		throw err;
	}
	const result = data.chart?.result?.[0];
	if (!result) throw new Error(`No Yahoo Finance data for ${yahooSymbol}`);
	return result;
}

/** Yahoo's ticker for a coin: "BTC" → "BTC-USD". */
export const yahooCryptoSymbol = (symbol: string) => `${symbol.toUpperCase()}-USD`;

async function fetchChart(symbol: string, range: string, exchange: "US" | "CRYPTO" = "US"): Promise<MarketSnapshot> {
	const ticker = symbol.trim().toUpperCase();
	const result = await fetchResult(
		exchange === "CRYPTO" ? yahooCryptoSymbol(ticker) : ticker,
		"1d",
		range,
		`Unknown ${exchange === "CRYPTO" ? "crypto" : "US"} symbol ${ticker}`,
	);

	const q = result.indicators.quote[0];
	const timestamps = result.timestamp ?? [];
	const bars: PriceBar[] = [];
	let prevClose = result.meta.chartPreviousClose ?? null;
	for (let i = 0; i < timestamps.length; i++) {
		const close = q?.close[i];
		if (close == null) continue;
		const change = prevClose !== null ? close - prevClose : null;
		const volume = q?.volume[i] ?? null;
		const digits = exchange === "CRYPTO" && close < 1 ? 8 : 4;
		const px = (v: number | null | undefined) => (v == null ? null : round(v, digits));
		bars.push({
			exchange,
			symbol: ticker,
			date: isoDate(new Date((timestamps[i] as number) * 1000)),
			open: px(q?.open[i]),
			high: px(q?.high[i]),
			low: px(q?.low[i]),
			close: round(close, digits),
			// Yahoo reports crypto volume in USD: store units like CoinGecko bars do, and the USD as value.
			volume: exchange === "CRYPTO" && volume !== null ? round(volume / close, 2) : volume,
			change: px(change),
			changePct: change !== null && prevClose ? round((change / prevClose) * 100, 2) : null,
			trades: null,
			value: exchange === "CRYPTO" ? volume : null,
		});
		prevClose = close;
	}

	const security: Security = {
		exchange,
		symbol: ticker,
		name: (result.meta.longName ?? result.meta.shortName ?? ticker).replace(/ USD$/, ""),
		sector: null,
		currency: result.meta.currency ?? CURRENCY[exchange],
		venue: exchange === "CRYPTO" ? "Crypto" : usVenue(result.meta.exchangeName, result.meta.fullExchangeName),
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

/** Daily OHLC for a coin by ticker. Tickers are ambiguous, so callers should sanity-check the price. */
export function fetchCryptoHistory(symbol: string, range: YahooRange = "2y"): Promise<MarketSnapshot> {
	return fetchChart(symbol, range, "CRYPTO");
}

export interface IntradayCandle {
	/** ISO timestamp of the candle's start. */
	time: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number | null;
}

export interface IntradayQuote {
	price: number;
	previousClose: number | null;
	dayHigh: number | null;
	dayLow: number | null;
	volume: number | null;
	/** When the price last changed (ISO). */
	time: string | null;
	/** Whether the regular session is under way, per Yahoo's trading period. */
	open: boolean;
	candles: IntradayCandle[];
}

/** Latest price and today's 5-minute candles. `yahooSymbol` is e.g. "AAPL" or "BTC-USD". */
export async function fetchIntraday(yahooSymbol: string, interval = "5m"): Promise<IntradayQuote> {
	const r = await fetchResult(yahooSymbol, interval, "1d", `Unknown symbol ${yahooSymbol}`);
	const q = r.indicators.quote[0];
	const candles: IntradayCandle[] = [];
	for (const [i, t] of (r.timestamp ?? []).entries()) {
		const [open, high, low, close] = [q?.open[i], q?.high[i], q?.low[i], q?.close[i]];
		if (open == null || high == null || low == null || close == null) continue;
		candles.push({ time: new Date(t * 1000).toISOString(), open, high, low, close, volume: q?.volume[i] ?? null });
	}
	const m = r.meta;
	const price = m.regularMarketPrice ?? candles.at(-1)?.close;
	if (price == null) throw new Error(`No live price for ${yahooSymbol}`);
	const period = m.currentTradingPeriod?.regular;
	const now = Date.now() / 1000;
	return {
		price,
		previousClose: m.previousClose ?? m.chartPreviousClose ?? null,
		dayHigh: m.regularMarketDayHigh ?? null,
		dayLow: m.regularMarketDayLow ?? null,
		volume: m.regularMarketVolume ?? null,
		time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
		open: period ? now >= period.start && now < period.end : false,
		candles,
	};
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
