/**
 * "How much should I buy?" — size a position so that being stopped out costs a chosen share of the account.
 *
 *   risk budget   = capital × risk %
 *   loss per unit = (entry − stop) + buying costs at the entry + selling costs at the stop
 *   units         = risk budget ÷ loss per unit, then capped so that no single position takes more than
 *                   `maxPositionPct` of the account and the purchase (with costs) fits in the capital
 *
 * The stop is where the idea is wrong, so a wider stop means a smaller position for the same risk. Stops are not
 * guaranteed: a price can gap through one (common on thinly traded NGX stocks), so the loss can exceed the budget.
 * Thin trading also makes exits slow, so the position is compared with the stock's average daily turnover.
 */
import { ValidationError } from "../lib/errors.js";
import { round } from "../lib/util.js";
import type { TradingCosts } from "./costs.js";

export interface SizingInput {
	/** Money available for this account, in the security's currency. */
	capital: number;
	/** Share of capital (%) to lose if the stop is hit. */
	riskPct: number;
	entry: number;
	stop: number;
	target?: number | null;
	costs: TradingCosts;
	/** Largest share of capital (%) one position may take (default 25). */
	maxPositionPct?: number;
	/** Whether fractions of a unit can be bought (crypto, some US brokers). */
	fractional?: boolean;
	/** Average value traded per session recently, for the liquidity check. */
	avgDailyValue?: number | null;
}

export interface Sizing {
	units: number;
	/** Price × units. */
	value: number;
	/** What buying costs, fees included. */
	outlay: number;
	/** Share of capital the position takes (%). */
	positionPct: number;
	/** Money lost if the stop is hit, fees included (more if the price gaps through the stop). */
	lossAtStop: number;
	lossAtStopPct: number;
	/** Money made if the target is hit, after fees. */
	gainAtTarget: number | null;
	gainAtTargetPct: number | null;
	/** Gain at target ÷ loss at stop, both after fees. */
	rewardRisk: number | null;
	/** What limited the size: the risk budget, the per-position cap, the cash available, or nothing could be bought. */
	limitedBy: "risk" | "concentration" | "cash" | "too-small";
	/** Position value as a share of the average day's turnover (%), when known. */
	shareOfDailyValue: number | null;
	warnings: string[];
}

export const SIZING_DEFAULTS = { riskPct: 1, maxPositionPct: 25 } as const;
/** Above this share of a day's turnover, getting out at the stop may take more than a session. */
const ILLIQUID_PCT = 10;

export function sizePosition(input: SizingInput): Sizing {
	const { capital, riskPct, entry, stop, costs } = input;
	const maxPositionPct = input.maxPositionPct ?? SIZING_DEFAULTS.maxPositionPct;
	if (!(capital > 0)) throw new ValidationError("Capital must be greater than 0.");
	if (!(riskPct > 0 && riskPct <= 100)) throw new ValidationError("Risk must be between 0 and 100% of capital.");
	if (!(maxPositionPct > 0 && maxPositionPct <= 100))
		throw new ValidationError("The position cap must be between 0 and 100% of capital.");
	if (!(entry > 0)) throw new ValidationError("Entry price must be greater than 0.");
	if (!(stop >= 0 && stop < entry)) throw new ValidationError("The stop must be below the entry price.");

	const buy = costs.buyPct / 100;
	const sell = costs.sellPct / 100;
	const unitCost = entry * (1 + buy);
	const lossPerUnit = unitCost - stop * (1 - sell);
	const budget = capital * (riskPct / 100);
	const floorUnits = (n: number) => (input.fractional ? Math.floor(n * 1e6) / 1e6 : Math.floor(n));

	const byRisk = budget / lossPerUnit;
	const byConcentration = (capital * (maxPositionPct / 100)) / unitCost;
	const byCash = capital / unitCost;
	const raw = Math.min(byRisk, byConcentration, byCash);
	const units = floorUnits(raw);
	const limitedBy: Sizing["limitedBy"] =
		units <= 0 ? "too-small" : raw === byRisk ? "risk" : raw === byConcentration ? "concentration" : "cash";

	const value = units * entry;
	const outlay = units * unitCost;
	const lossAtStop = units * lossPerUnit;
	const target = input.target ?? null;
	const gainAtTarget = target !== null && target > entry ? units * (target * (1 - sell) - unitCost) : null;
	const shareOfDailyValue = input.avgDailyValue ? (value / input.avgDailyValue) * 100 : null;

	const warnings: string[] = [];
	if (limitedBy === "too-small") {
		warnings.push(
			`One unit would risk ${round(lossPerUnit, 2)} (more than the ${round(budget, 2)} budget) or cost more than the position cap allows. Raise the capital or risk, or skip this one.`,
		);
	} else if (limitedBy === "concentration") {
		warnings.push(
			`Capped at ${maxPositionPct}% of capital: the stop is close enough that the risk budget alone would put too much in one stock.`,
		);
	}
	if (gainAtTarget !== null && gainAtTarget <= 0)
		warnings.push("After fees, reaching the target barely breaks even. The move is too small for the costs.");
	if (shareOfDailyValue !== null && shareOfDailyValue > ILLIQUID_PCT)
		warnings.push(
			`This is ${round(shareOfDailyValue, 0)}% of a typical day's trading in it, so selling at the stop could take days and cost more than planned.`,
		);
	if (riskPct > 2) warnings.push(`Risking ${riskPct}% per trade means a run of a few losses takes a big bite.`);

	const pct = (v: number) => round((v / capital) * 100, 2);
	return {
		units,
		value: round(value, 2),
		outlay: round(outlay, 2),
		positionPct: pct(outlay),
		lossAtStop: round(lossAtStop, 2),
		lossAtStopPct: pct(lossAtStop),
		gainAtTarget: gainAtTarget === null ? null : round(gainAtTarget, 2),
		gainAtTargetPct: gainAtTarget === null ? null : pct(gainAtTarget),
		rewardRisk: gainAtTarget !== null && lossAtStop > 0 ? round(gainAtTarget / lossAtStop, 2) : null,
		limitedBy,
		shareOfDailyValue: shareOfDailyValue === null ? null : round(shareOfDailyValue, 1),
		warnings,
	};
}
