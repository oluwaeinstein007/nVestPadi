/**
 * Portfolio tracking: positions with average cost, valued at the latest close.
 * Totals are per currency — NGN and USD positions are never summed together.
 */
import type { AppMode } from "../config.js";
import { NotFoundError, PlanLimitError, ValidationError } from "../lib/errors.js";
import { round } from "../lib/util.js";
import type { Exchange } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { Holding } from "../storage/repositories/holdings.js";
import type { User } from "../storage/repositories/users.js";
import type { MarketService } from "./marketService.js";
import { limitsFor } from "./plans.js";

export interface Position extends Holding {
	name: string;
	currency: string;
	price: number | null;
	priceDate: string | null;
	changePct: number | null;
	cost: number;
	value: number | null;
	pnl: number | null;
	pnlPct: number | null;
	/** Today's gain/loss from the latest session's move. */
	dayPnl: number | null;
	/** Share of the portfolio's value in this currency, in %. */
	weightPct: number | null;
}

export interface PortfolioTotals {
	currency: string;
	value: number;
	cost: number;
	pnl: number;
	pnlPct: number | null;
	dayPnl: number;
	positions: number;
}

export interface Portfolio {
	positions: Position[];
	totals: PortfolioTotals[];
}

function validate(quantity: number, avgCost: number) {
	if (!Number.isFinite(quantity) || quantity <= 0) throw new ValidationError("Quantity must be greater than 0.");
	if (!Number.isFinite(avgCost) || avgCost < 0) throw new ValidationError("Cost per unit can't be negative.");
}

export class PortfolioService {
	constructor(
		private readonly db: Database,
		private readonly market: MarketService,
		private readonly mode: AppMode,
	) {}

	get(user: User): Portfolio {
		const positions: Position[] = this.db.holdings.list(user.id).map((h) => {
			const quote = this.db.market.latestQuote(h.exchange, h.symbol);
			const security = quote ?? this.db.market.getSecurity(h.exchange, h.symbol);
			const cost = round(h.quantity * h.avgCost, 2);
			const value = quote ? round(h.quantity * quote.close, 2) : null;
			const pnl = value === null ? null : round(value - cost, 2);
			return {
				...h,
				name: security?.name ?? h.symbol,
				currency: security?.currency ?? "",
				price: quote?.close ?? null,
				priceDate: quote?.date ?? null,
				changePct: quote?.changePct ?? null,
				cost,
				value,
				pnl,
				pnlPct: pnl !== null && cost > 0 ? round((pnl / cost) * 100, 2) : null,
				dayPnl: quote?.change != null ? round(h.quantity * quote.change, 2) : null,
				weightPct: null,
			};
		});

		const totals = new Map<string, PortfolioTotals>();
		for (const p of positions) {
			const t = totals.get(p.currency) ?? {
				currency: p.currency,
				value: 0,
				cost: 0,
				pnl: 0,
				pnlPct: null,
				dayPnl: 0,
				positions: 0,
			};
			t.value += p.value ?? p.cost;
			t.cost += p.cost;
			t.pnl += p.pnl ?? 0;
			t.dayPnl += p.dayPnl ?? 0;
			t.positions++;
			totals.set(p.currency, t);
		}
		for (const t of totals.values()) {
			t.value = round(t.value, 2);
			t.cost = round(t.cost, 2);
			t.pnl = round(t.pnl, 2);
			t.dayPnl = round(t.dayPnl, 2);
			t.pnlPct = t.cost > 0 ? round((t.pnl / t.cost) * 100, 2) : null;
		}
		for (const p of positions) {
			const total = totals.get(p.currency)?.value ?? 0;
			p.weightPct = total > 0 ? round(((p.value ?? p.cost) / total) * 100, 1) : null;
		}
		positions.sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost));
		return { positions, totals: [...totals.values()] };
	}

	/** Record a buy. Buying more of a held security averages the cost. */
	async add(
		user: User,
		input: { symbol: string; exchange?: Exchange; quantity: number; avgCost: number; note?: string },
	): Promise<Holding> {
		validate(input.quantity, input.avgCost);
		const target = await this.market.track(input.symbol, input.exchange);
		const existing = this.db.holdings.find(user.id, target.exchange, target.symbol);
		if (existing) {
			const quantity = existing.quantity + input.quantity;
			const avgCost = (existing.quantity * existing.avgCost + input.quantity * input.avgCost) / quantity;
			return this.db.holdings.update(user.id, existing.id, {
				quantity: round(quantity, 8),
				avgCost: round(avgCost, 6),
				note: input.note,
			}) as Holding;
		}
		const { holdings } = limitsFor(user, this.mode);
		if (this.db.holdings.count(user.id) >= holdings) {
			throw new PlanLimitError(`Your plan tracks up to ${holdings} positions. Remove one or upgrade to Pro.`);
		}
		return this.db.holdings.insert(user.id, {
			...target,
			quantity: input.quantity,
			avgCost: input.avgCost,
			note: input.note,
		});
	}

	update(user: User, id: number, input: { quantity: number; avgCost: number; note?: string | null }): Holding {
		validate(input.quantity, input.avgCost);
		const updated = this.db.holdings.update(user.id, id, input);
		if (!updated) throw new NotFoundError("Position not found");
		return updated;
	}

	remove(user: User, id: number) {
		if (!this.db.holdings.delete(user.id, id)) throw new NotFoundError("Position not found");
	}
}
