/**
 * Market data orchestration: fetch from sources → persist to SQLite →
 * (optionally) index into the knowledge base.
 */
import { type SecurityReport, buildReport } from "../analysis/report.js";
import { logger } from "../lib/logger.js";
import { fetchNgxHistory, fetchNgxSnapshot } from "../markets/ngx.js";
import { EXCHANGES, type Exchange, type MarketSnapshot } from "../markets/types.js";
import { type YahooRange, fetchUsHistory, fetchUsSnapshot } from "../markets/yahoo.js";
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

export class SymbolNotFoundError extends Error {
	constructor(symbol: string, exchange?: Exchange) {
		super(
			exchange
				? `${symbol} not found on ${exchange}.`
				: `${symbol} not found on NGX or US. Check the ticker, or pass --exchange.`,
		);
		this.name = "SymbolNotFoundError";
	}
}

export class MarketService {
	constructor(
		private readonly db: Database,
		private readonly kb: KnowledgeBase,
		private readonly usSymbols: string[],
	) {}

	private store(snapshot: MarketSnapshot) {
		this.db.upsertSecurities(snapshot.securities);
		this.db.upsertPrices(snapshot.bars);
	}

	/** Fetch the latest session for an exchange and store it. */
	async sync(exchange: Exchange, options: { symbols?: string[]; index?: boolean } = {}): Promise<SyncResult> {
		let snapshot: MarketSnapshot;
		let failed: string[] = [];
		if (exchange === "NGX") {
			snapshot = await fetchNgxSnapshot();
		} else {
			const symbols = options.symbols?.length ? options.symbols.map((s) => s.toUpperCase()) : this.usSymbols;
			const result = await fetchUsSnapshot(symbols);
			snapshot = result;
			failed = result.failed;
		}
		this.store(snapshot);

		const date = snapshot.bars.reduce<string | null>((max, b) => (max === null || b.date > max ? b.date : max), null);
		let indexed = 0;
		if (options.index !== false && this.kb.enabled) {
			try {
				const latest = this.db
					.latestQuotes(exchange)
					.filter((q) => q.date === date && snapshot.securities.some((s) => s.symbol === q.symbol));
				indexed = (await this.kb.indexQuotes(latest)).indexed;
			} catch (err) {
				// Market data is already saved; indexing is a bonus that shouldn't fail the sync.
				logger.warn("quote indexing failed; prices were still saved", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return {
			exchange,
			securities: snapshot.securities.length,
			bars: snapshot.bars.length,
			date,
			indexed,
			failed,
		};
	}

	/** Backfill daily history for one symbol. */
	async loadHistory(symbol: string, options: { exchange?: Exchange; range?: YahooRange } = {}) {
		const ticker = symbol.toUpperCase();
		const candidates = options.exchange ? [options.exchange] : this.candidateExchanges(ticker);
		for (const exchange of candidates) {
			try {
				const snapshot =
					exchange === "NGX" ? await fetchNgxHistory(ticker) : await fetchUsHistory(ticker, options.range ?? "1y");
				if (snapshot.bars.length === 0) continue;
				// Keep richer names/sectors from the daily sync if we already have them.
				const known = this.db.getSecurity(exchange, ticker);
				this.store({ securities: known ? [] : snapshot.securities, bars: snapshot.bars });
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
			}
		}
		throw new SymbolNotFoundError(ticker, options.exchange);
	}

	/** Exchanges to try for a bare ticker: ones we already know it on first, then NGX, then US. */
	private candidateExchanges(symbol: string): Exchange[] {
		const known = this.db.findExchanges(symbol);
		return [...known, ...EXCHANGES.filter((e) => !known.includes(e))];
	}

	/** Add to the watchlist, backfilling history so trends/alerts work immediately. */
	async watch(symbol: string, exchange?: Exchange): Promise<{ exchange: Exchange; symbol: string }> {
		let target: { exchange: Exchange; symbol: string };
		try {
			target = this.resolve(symbol, exchange);
		} catch {
			const loaded = await this.loadHistory(symbol, { exchange });
			target = { exchange: loaded.exchange, symbol: loaded.symbol };
		}
		if (this.db.history(target.exchange, target.symbol, 30).length < 10) {
			await this.loadHistory(target.symbol, { exchange: target.exchange }).catch((err) =>
				logger.warn("history backfill failed", { symbol: target.symbol, error: String(err) }),
			);
		}
		this.db.addToWatchlist(target.exchange, target.symbol);
		return target;
	}

	resolve(symbol: string, exchange?: Exchange): { exchange: Exchange; symbol: string } {
		const ticker = symbol.toUpperCase();
		if (exchange) return { exchange, symbol: ticker };
		const known = this.db.findExchanges(ticker);
		if (known.length === 0) throw new SymbolNotFoundError(ticker);
		return { exchange: known[0] as Exchange, symbol: ticker };
	}

	/**
	 * Technical report for a symbol. If we hold too little history, fetch more first
	 * (one network round-trip, then cached in SQLite).
	 */
	async report(symbol: string, exchange?: Exchange): Promise<SecurityReport> {
		let target: { exchange: Exchange; symbol: string };
		try {
			target = this.resolve(symbol, exchange);
		} catch {
			const loaded = await this.loadHistory(symbol, { exchange });
			target = { exchange: loaded.exchange, symbol: loaded.symbol };
		}
		let bars = this.db.history(target.exchange, target.symbol);
		if (bars.length < 60 && target.exchange === "US") {
			await this.loadHistory(target.symbol, { exchange: "US" }).catch((err) =>
				logger.warn("history backfill failed", { symbol: target.symbol, error: String(err) }),
			);
			bars = this.db.history(target.exchange, target.symbol);
		} else if (bars.length < 10 && target.exchange === "NGX") {
			await this.loadHistory(target.symbol, { exchange: "NGX" }).catch(() => undefined);
			bars = this.db.history(target.exchange, target.symbol);
		}
		const security = this.db.getSecurity(target.exchange, target.symbol);
		if (!security || bars.length === 0) throw new SymbolNotFoundError(target.symbol, target.exchange);
		return buildReport(security, bars);
	}
}
