/**
 * Market data orchestration: fetch from sources → persist to SQLite →
 * (optionally) index into the knowledge base.
 *
 * Sources per market:
 * - NGX: NGX statistics API (daily board) + afx.kwayisi.org (names, ~10y closes)
 * - US: Yahoo Finance (prices, venue) + Nasdaq screener (sector, industry, market cap)
 * - CRYPTO: CoinGecko (top coins by market cap, daily closes) + Yahoo (daily candles)
 */
import { type SecurityReport, buildReport } from "../analysis/report.js";
import { NotFoundError } from "../lib/errors.js";
import { HttpError } from "../lib/http.js";
import { errorMessage, logger } from "../lib/logger.js";
import { isoDate, mapLimit } from "../lib/util.js";
import type { CoinGecko } from "../markets/coingecko.js";
import { fetchUsListings } from "../markets/nasdaq.js";
import { fetchNgxHistory, fetchNgxSnapshot } from "../markets/ngx.js";
import { EXCHANGES, type Exchange, type MarketSnapshot, type PriceBar } from "../markets/types.js";
import { type YahooRange, fetchCryptoHistory, fetchUsHistory, fetchUsSnapshot } from "../markets/yahoo.js";
import type { Database } from "../storage/database.js";
import type { KnowledgeBase } from "./knowledgeBase.js";

export interface SyncResult {
	exchange: Exchange;
	securities: number;
	bars: number;
	date: string | null;
	indexed: number;
	failed: string[];
}

/** Sessions needed before every indicator (incl. MACD and SMA 50) is meaningful. */
export const MIN_HISTORY = 60;

export class SymbolNotFoundError extends NotFoundError {
	constructor(symbol: string, exchange?: Exchange) {
		super(
			exchange
				? `${symbol} not found on ${exchange}.`
				: `${symbol} not found on NGX, US or crypto. Check the ticker, or pick a market.`,
		);
	}
}

export class MarketService {
	constructor(
		private readonly db: Database,
		private readonly kb: KnowledgeBase,
		private readonly options: { usSymbols: string[]; coingecko: CoinGecko },
	) {}

	private store(snapshot: MarketSnapshot) {
		this.db.market.upsertSecurities(snapshot.securities);
		this.db.market.upsertPrices(snapshot.bars);
	}

	/** Fetch the latest session for a market and store it. */
	async sync(exchange: Exchange, options: { symbols?: string[]; index?: boolean } = {}): Promise<SyncResult> {
		let snapshot: MarketSnapshot;
		let failed: string[] = [];
		if (exchange === "NGX") {
			snapshot = await fetchNgxSnapshot();
		} else if (exchange === "CRYPTO") {
			snapshot = await this.options.coingecko.snapshot(100);
		} else {
			const symbols = options.symbols?.length ? options.symbols.map((s) => s.toUpperCase()) : this.options.usSymbols;
			const result = await fetchUsSnapshot(symbols);
			snapshot = result;
			failed = result.failed;
		}
		this.store(snapshot);
		if (exchange === "US") await this.enrichUsListings();

		const date = snapshot.bars.reduce<string | null>((max, b) => (max === null || b.date > max ? b.date : max), null);
		let indexed = 0;
		if (options.index !== false && this.kb.enabled) {
			try {
				const latest = this.db.market
					.latestQuotes(exchange)
					.filter((q) => q.date === date && snapshot.securities.some((s) => s.symbol === q.symbol));
				indexed = (await this.kb.indexQuotes(latest)).indexed;
			} catch (err) {
				// Market data is already saved; indexing is a bonus that shouldn't fail the sync.
				logger.warn("quote indexing failed; prices were still saved", { error: errorMessage(err) });
			}
		}
		return { exchange, securities: snapshot.securities.length, bars: snapshot.bars.length, date, indexed, failed };
	}

	/** Sector, industry, market cap and venue for US stocks — refreshed at most once a day. */
	async enrichUsListings(force = false): Promise<number> {
		const key = `enrich:US:${isoDate(new Date())}`;
		if (!force && this.db.jobs.get(key)) return 0;
		const listings = await fetchUsListings();
		if (listings.size === 0) return 0;
		const known = new Set(
			this.db.market
				.allSymbols()
				.filter((s) => s.exchange === "US")
				.map((s) => s.symbol),
		);
		const relevant = new Map([...listings].filter(([symbol]) => known.has(symbol)));
		const updated = this.db.market.enrichSecurities("US", relevant);
		this.db.jobs.set(key, String(updated));
		logger.info("US listings enriched", { updated });
		return updated;
	}

	/** Backfill daily history for one symbol. */
	async loadHistory(symbol: string, options: { exchange?: Exchange; range?: YahooRange } = {}) {
		const ticker = symbol.toUpperCase();
		const candidates = options.exchange ? [options.exchange] : this.candidateExchanges(ticker);
		let unexpected: unknown;
		for (const exchange of candidates) {
			try {
				const snapshot = await this.fetchHistory(exchange, ticker, options.range);
				if (snapshot.bars.length === 0) continue;
				// Keep richer names/sectors from the daily sync if we already have them.
				const known = this.db.market.getSecurity(exchange, ticker);
				this.store({ securities: known ? [] : snapshot.securities, bars: snapshot.bars });
				this.db.jobs.set(`history:${exchange}:${ticker}`, isoDate(new Date()));
				return {
					exchange,
					symbol: ticker,
					bars: snapshot.bars.length,
					from: snapshot.bars[0]?.date,
					to: snapshot.bars.at(-1)?.date,
				};
			} catch (err) {
				logger.debug(`history lookup failed on ${exchange}`, { symbol: ticker, error: String(err) });
				if (options.exchange) throw err;
				if (!isNotFound(err)) unexpected = err;
			}
		}
		// A rate limit or outage shouldn't masquerade as "unknown ticker".
		if (unexpected) throw unexpected;
		throw new SymbolNotFoundError(ticker, options.exchange);
	}

	private async fetchHistory(exchange: Exchange, ticker: string, range?: YahooRange): Promise<MarketSnapshot> {
		if (exchange === "NGX") return fetchNgxHistory(ticker);
		if (exchange === "US") return fetchUsHistory(ticker, range ?? "2y");
		const known = this.db.market.getSecurity("CRYPTO", ticker);
		const security = known?.sourceId ? known : await this.options.coingecko.search(ticker);
		if (!security?.sourceId) throw new Error(`Unknown crypto symbol ${ticker}`);
		const ohlc = await this.cryptoOhlc(ticker);
		if (ohlc) return { securities: [security], bars: ohlc };
		const bars: PriceBar[] = await this.options.coingecko.history(security.sourceId, ticker);
		return { securities: [security], bars };
	}

	/**
	 * Daily candles for a coin from Yahoo, which CoinGecko's free API only has as
	 * closes. Tickers aren't unique across coins, so the history is only used when
	 * its latest close is within 5% of the price CoinGecko gave us for this coin.
	 */
	private async cryptoOhlc(ticker: string): Promise<PriceBar[] | null> {
		const reference = this.db.market.latestQuote("CRYPTO", ticker)?.close;
		if (!reference) return null;
		try {
			const { bars } = await fetchCryptoHistory(ticker, "2y");
			const latest = bars.at(-1)?.close;
			if (!latest || Math.abs(latest - reference) / reference > 0.05) {
				logger.debug("Yahoo crypto history doesn't match CoinGecko; using closes", { ticker, latest, reference });
				return null;
			}
			return bars;
		} catch (err) {
			logger.debug("Yahoo crypto history unavailable", { ticker, error: errorMessage(err) });
			return null;
		}
	}

	/**
	 * Fill in history for symbols that have too little to compute indicators
	 * (e.g. NGX symbols seen in only a few daily syncs). Runs in the background
	 * after syncs; each symbol is attempted at most once a day.
	 */
	async backfill(exchange: Exchange, options: { limit?: number; concurrency?: number } = {}): Promise<number> {
		const today = isoDate(new Date());
		// Coins backfilled before candles were available get one try at OHLC history.
		const upgrades =
			exchange === "CRYPTO"
				? this.db.market
						.closeOnlyHistory(exchange, MIN_HISTORY)
						.filter((symbol) => !this.db.jobs.get(`ohlc:${exchange}:${symbol}`))
				: [];
		const due = [...this.db.market.thinHistory(exchange, MIN_HISTORY), ...upgrades]
			.filter((symbol) => upgrades.includes(symbol) || this.db.jobs.get(`history:${exchange}:${symbol}`) !== today)
			.slice(0, options.limit ?? 50);
		for (const symbol of due) if (upgrades.includes(symbol)) this.db.jobs.set(`ohlc:${exchange}:${symbol}`, today);
		if (due.length === 0) return 0;
		// CoinGecko's keyless tier allows only a few calls a minute.
		const concurrency = options.concurrency ?? (exchange === "CRYPTO" ? 1 : 3);
		const loaded = await mapLimit(due, concurrency, async (symbol) => {
			try {
				await this.loadHistory(symbol, { exchange });
				return true;
			} catch (err) {
				this.db.jobs.set(`history:${exchange}:${symbol}`, today);
				logger.debug("backfill failed", { exchange, symbol, error: errorMessage(err) });
				return false;
			}
		});
		const count = loaded.filter(Boolean).length;
		logger.info(`backfilled history for ${count}/${due.length} ${exchange} symbols`);
		return count;
	}

	/** Markets to try for a bare ticker: ones we already know it on first, then NGX, US, crypto. */
	private candidateExchanges(symbol: string): Exchange[] {
		const known = this.db.market.findExchanges(symbol);
		return [...known, ...EXCHANGES.filter((e) => !known.includes(e))];
	}

	/**
	 * Make sure a symbol is known and has enough history for trends and alerts,
	 * fetching it if needed. Used before adding it to a watchlist or portfolio.
	 */
	async track(symbol: string, exchange?: Exchange): Promise<{ exchange: Exchange; symbol: string }> {
		let target: { exchange: Exchange; symbol: string };
		try {
			target = this.resolve(symbol, exchange);
		} catch {
			const loaded = await this.loadHistory(symbol, { exchange });
			target = { exchange: loaded.exchange, symbol: loaded.symbol };
		}
		await this.ensureHistory(target.exchange, target.symbol);
		return target;
	}

	resolve(symbol: string, exchange?: Exchange): { exchange: Exchange; symbol: string } {
		const ticker = symbol.toUpperCase();
		if (exchange) return { exchange, symbol: ticker };
		const known = this.db.market.findExchanges(ticker);
		if (known.length === 0) throw new SymbolNotFoundError(ticker);
		return { exchange: known[0] as Exchange, symbol: ticker };
	}

	/** Fetch deeper history when we hold too little — at most once a day per symbol. */
	private async ensureHistory(exchange: Exchange, symbol: string): Promise<PriceBar[]> {
		const bars = this.db.market.history(exchange, symbol);
		if (bars.length >= MIN_HISTORY || this.db.jobs.get(`history:${exchange}:${symbol}`) === isoDate(new Date())) {
			return bars;
		}
		await this.loadHistory(symbol, { exchange }).catch((err) =>
			logger.warn("history backfill failed", { exchange, symbol, error: errorMessage(err) }),
		);
		return this.db.market.history(exchange, symbol);
	}

	/** Technical report for a symbol, backfilling history first if we hold too little. */
	async report(symbol: string, exchange?: Exchange): Promise<SecurityReport> {
		let target: { exchange: Exchange; symbol: string };
		try {
			target = this.resolve(symbol, exchange);
		} catch {
			const loaded = await this.loadHistory(symbol, { exchange });
			target = { exchange: loaded.exchange, symbol: loaded.symbol };
		}
		const bars = await this.ensureHistory(target.exchange, target.symbol);
		const security = this.db.market.getSecurity(target.exchange, target.symbol);
		if (!security || bars.length === 0) throw new SymbolNotFoundError(target.symbol, target.exchange);
		return buildReport(security, bars);
	}
}

function isNotFound(err: unknown): boolean {
	if (err instanceof HttpError) return err.status === 404;
	return err instanceof Error && /not found|unknown (us|crypto) symbol|no .*(data|history)/i.test(err.message);
}
