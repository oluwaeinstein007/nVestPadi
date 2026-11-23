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

	list(user: User): WatchlistItem[] {
		return this.db.watchlist.list(user.id).map((w) => ({
			...w,
			quote: this.db.market.latestQuote(w.exchange, w.symbol),
			spark: this.db.market.history(w.exchange, w.symbol, 30).map((b) => b.close),
		}));
	}

	has(user: User, exchange: Exchange, symbol: string): boolean {
		return this.db.watchlist.has(user.id, exchange, symbol);
	}

	async add(user: User, symbol: string, exchange?: Exchange): Promise<{ exchange: Exchange; symbol: string }> {
		const { watchlist } = limitsFor(user, this.mode);
		if (this.db.watchlist.count(user.id) >= watchlist) {
			throw new PlanLimitError(`Your plan allows ${watchlist} watchlist stocks. Remove one or upgrade to Pro.`);
		}
		const target = await this.market.track(symbol, exchange);
		this.db.watchlist.add(user.id, target.exchange, target.symbol);
		return target;
	}

	remove(user: User, symbol: string, exchange?: Exchange): { exchange: Exchange; symbol: string } {
		const target = this.market.resolve(symbol, exchange);
		if (!this.db.watchlist.remove(user.id, target.exchange, target.symbol)) {
			throw new NotFoundError(`${target.symbol} is not on your watchlist`);
		}
		return target;
	}
}
