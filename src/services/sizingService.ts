/**
 * Position sizing for a security: uses its current BUY signal's entry, stop and target unless the user gives their
 * own levels, the market's trading costs, and recent turnover for the liquidity check.
 */
import { costsFor } from "../analysis/costs.js";
import { SIZING_DEFAULTS, type Sizing, sizePosition } from "../analysis/sizing.js";
import { ValidationError } from "../lib/errors.js";
import type { Exchange, PriceBar } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { MarketService } from "./marketService.js";

export interface SizingRequest {
	symbol: string;
	exchange?: Exchange;
	capital: number;
	riskPct?: number;
	maxPositionPct?: number;
	/** Override the signal's levels (e.g. your own stop). */
	entry?: number;
	stop?: number;
	target?: number;
}

export interface SizingResult {
	exchange: Exchange;
	symbol: string;
	name: string;
	currency: string;
	/** Where the levels came from: the current BUY signal, the user, or a mix. */
	levels: { entry: number; stop: number; target: number | null; source: "signal" | "custom" };
	riskPct: number;
	maxPositionPct: number;
	costs: { buyPct: number; sellPct: number };
	sizing: Sizing;
}

/** Sessions averaged for the liquidity check. */
const TURNOVER_SESSIONS = 20;

export class SizingService {
	constructor(
		private readonly db: Database,
		private readonly market: MarketService,
	) {}

	async size(req: SizingRequest): Promise<SizingResult> {
		const report = await this.market.report(req.symbol, req.exchange);
		const { security } = report;
		const plan = report.call?.side === "BUY" ? report.call.plan : null;
		const entry = req.entry ?? plan?.entry ?? report.latest.close;
		const stop = req.stop ?? plan?.stop;
		if (stop === undefined) {
			throw new ValidationError(
				`${security.symbol} has no BUY signal right now, so there's no stop to size from. Give your own stop price.`,
			);
		}
		const target = req.target ?? plan?.target ?? null;
		const riskPct = req.riskPct ?? SIZING_DEFAULTS.riskPct;
		const maxPositionPct = req.maxPositionPct ?? SIZING_DEFAULTS.maxPositionPct;
		const costs = costsFor(security.exchange);
		const custom = req.entry !== undefined || req.stop !== undefined || req.target !== undefined;
		return {
			exchange: security.exchange,
			symbol: security.symbol,
			name: security.name,
			currency: security.currency,
			levels: { entry, stop, target, source: custom || !plan ? "custom" : "signal" },
			riskPct,
			maxPositionPct,
			costs,
			sizing: sizePosition({
				capital: req.capital,
				riskPct,
				maxPositionPct,
				entry,
				stop,
				target,
				costs,
				fractional: security.exchange === "CRYPTO",
				avgDailyValue: avgDailyValue(
					await this.db.market.history(security.exchange, security.symbol, TURNOVER_SESSIONS),
				),
			}),
		};
	}
}

/** Average traded value over the last sessions (reported value, else close × volume); null when unknown. */
export function avgDailyValue(bars: PriceBar[]): number | null {
	const values = bars
		.slice(-TURNOVER_SESSIONS)
		.map((b) => b.value ?? (b.volume !== null ? b.volume * b.close : null))
		.filter((v): v is number => v !== null && v > 0);
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
