/**
 * Live quotes for the stock detail view: the latest price, today's range and,
 * where a source has them, today's 5-minute candles. Cached briefly per symbol
 * so many open tabs cost one upstream call.
 *
 * How live each market is (shown to users as-is):
 * - US: Yahoo's regular-market price, typically seconds to a minute behind
 * - Crypto: Yahoo's price for the coin, cross-checked against CoinGecko's;
 *   CoinGecko's 30-minute candles when Yahoo's ticker is a different coin
 * - NGX: there is no free intraday feed. The NGX daily board is re-read every
 *   few minutes during trading hours, so prices are delayed and have no
 *   intraday candles.
 */
import { errorMessage, logger } from "../lib/logger.js";
import { round } from "../lib/util.js";
import type { CoinGecko } from "../markets/coingecko.js";
import { SESSION_LABEL, isMarketOpen } from "../markets/hours.js";
import type { Exchange } from "../markets/types.js";
import { type IntradayCandle, fetchIntraday, yahooCryptoSymbol } from "../markets/yahoo.js";
import type { Database } from "../storage/database.js";
import { SymbolNotFoundError } from "./marketService.js";

export interface LiveQuote {
	exchange: Exchange;
	symbol: string;
	price: number;
	change: number | null;
	changePct: number | null;
	dayHigh: number | null;
	dayLow: number | null;
	volume: number | null;
	/** When the price last changed, if the source says (ISO). */
	asOf: string | null;
	marketOpen: boolean;
	session: string;
	/** "live" (seconds–a minute behind), "delayed" (minutes behind) or "close" (last session's close). */
	freshness: "live" | "delayed" | "close";
	source: string;
	candles: IntradayCandle[];
	fetchedAt: string;
}

const TTL_MS = 20_000;

export class LiveService {
	private readonly cache = new Map<string, { at: number; quote: Promise<LiveQuote> }>();

	constructor(
		private readonly db: Database,
		private readonly coingecko: CoinGecko,
	) {}

	quote(exchange: Exchange, symbol: string): Promise<LiveQuote> {
		const key = `${exchange}:${symbol.toUpperCase()}`;
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.at < TTL_MS) return hit.quote;
		const quote = this.fetch(exchange, symbol.toUpperCase());
		this.cache.set(key, { at: Date.now(), quote });
		// Don't cache failures.
		quote.catch(() => this.cache.delete(key));
		if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
		return quote;
	}

	private async fetch(exchange: Exchange, symbol: string): Promise<LiveQuote> {
		const stored = await this.db.market.latestQuote(exchange, symbol);
		if (!stored) throw new SymbolNotFoundError(symbol, exchange);
		const base = {
			exchange,
			symbol,
			marketOpen: isMarketOpen(exchange),
			session: SESSION_LABEL[exchange],
			fetchedAt: new Date().toISOString(),
		};
		const fromStore = (source: string): LiveQuote => ({
			...base,
			price: stored.close,
			change: stored.change,
			changePct: stored.changePct,
			dayHigh: stored.high,
			dayLow: stored.low,
			volume: stored.volume,
			asOf: null,
			// The stored price is minutes old while the market trades (live syncs), else the last close.
			freshness: base.marketOpen ? "delayed" : "close",
			source,
			candles: [],
		});

		if (exchange === "NGX") return fromStore("NGX daily board, refreshed every few minutes in trading hours");

		const yahooSymbol = exchange === "CRYPTO" ? yahooCryptoSymbol(symbol) : symbol;
		try {
			const q = await fetchIntraday(yahooSymbol);
			// Crypto tickers aren't unique: only trust Yahoo when it agrees with CoinGecko.
			if (exchange === "CRYPTO" && Math.abs(q.price - stored.close) / stored.close > 0.1) {
				throw new Error(`Yahoo ${yahooSymbol} is a different coin`);
			}
			const prev = this.reference(exchange, stored, q.previousClose);
			return {
				...base,
				price: q.price,
				change: prev ? round(q.price - prev, 6) : stored.change,
				changePct: prev ? round(((q.price - prev) / prev) * 100, 2) : stored.changePct,
				dayHigh: q.dayHigh,
				dayLow: q.dayLow,
				volume: q.volume,
				asOf: q.time,
				marketOpen: exchange === "CRYPTO" ? true : q.open,
				freshness: exchange === "CRYPTO" || q.open ? "live" : "close",
				source: "Yahoo Finance",
				candles: q.candles,
			};
		} catch (err) {
			logger.debug("live quote from Yahoo failed", { exchange, symbol, error: errorMessage(err) });
		}

		if (exchange === "CRYPTO") {
			const security = await this.db.market.getSecurity("CRYPTO", symbol);
			if (security?.sourceId) {
				try {
					const candles = await this.coingecko.ohlc(security.sourceId, 1);
					const last = candles.at(-1);
					if (last) {
						const prev = this.reference(exchange, stored, null);
						return {
							...fromStore("CoinGecko"),
							price: last.close,
							change: prev ? round(last.close - prev, 6) : stored.change,
							changePct: prev ? round(((last.close - prev) / prev) * 100, 2) : stored.changePct,
							dayHigh: Math.max(...candles.map((c) => c.high)),
							dayLow: Math.min(...candles.map((c) => c.low)),
							asOf: last.time,
							freshness: "live",
							candles,
						};
					}
				} catch (err) {
					logger.debug("live quote from CoinGecko failed", { symbol, error: errorMessage(err) });
				}
			}
		}
		return fromStore("last synced price");
	}

	/**
	 * The price a change is measured from. Stocks: the previous session's close.
	 * Crypto: the price 24 hours before the last sync (the app shows rolling 24h
	 * moves everywhere, not "since midnight").
	 */
	private reference(
		exchange: Exchange,
		stored: { close: number; change: number | null },
		previousClose: number | null,
	): number | null {
		if (exchange !== "CRYPTO") return previousClose;
		return stored.change === null ? null : stored.close - stored.change;
	}
}
