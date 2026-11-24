/** Per-user watchlists, with plan limits and on-demand history backfill. */
import type { AppMode } from "../config.js";
import { NotFoundError, PlanLimitError } from "../lib/errors.js";
import type { Exchange, Quote } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { User } from "../storage/repositories/users.js";
import type { MarketService } from "./marketService.js";
import { limitsFor } from "./plans.js";

export interface WatchlistItem {
	exchange: Exchange;
	symbol: string;
	addedAt: string;
	quote: Quote | null;
	/** Last 30 closes, oldest first. */
	spark: number[];
}

export class WatchlistService {
	constructor(
		private readonly db: Database,
		private readonly market: MarketService,
		private readonly mode: AppMode,
	) {}

	async list(user: User): Promise<WatchlistItem[]> {
		const entries = await this.db.watchlist.list(user.id);
		return Promise.all(
			entries.map(async (w) => {
				const [quote, bars] = await Promise.all([
					this.db.market.latestQuote(w.exchange, w.symbol),
					this.db.market.history(w.exchange, w.symbol, 30),
				]);
				return { ...w, quote, spark: bars.map((b) => b.close) };
			}),
		);
	}

	has(user: User, exchange: Exchange, symbol: string): Promise<boolean> {
		return this.db.watchlist.has(user.id, exchange, symbol);
	}

	async add(user: User, symbol: string, exchange?: Exchange): Promise<{ exchange: Exchange; symbol: string }> {
		const { watchlist } = limitsFor(user, this.mode);
		if ((await this.db.watchlist.count(user.id)) >= watchlist) {
			throw new PlanLimitError(`Your plan allows ${watchlist} watchlist stocks. Remove one or upgrade to Pro.`);
		}
		const target = await this.market.track(symbol, exchange);
		await this.db.watchlist.add(user.id, target.exchange, target.symbol);
		return target;
	}

	async remove(user: User, symbol: string, exchange?: Exchange): Promise<{ exchange: Exchange; symbol: string }> {
		const target = await this.market.resolve(symbol, exchange);
		if (!(await this.db.watchlist.remove(user.id, target.exchange, target.symbol))) {
			throw new NotFoundError(`${target.symbol} is not on your watchlist`);
		}
		return target;
	}
}
