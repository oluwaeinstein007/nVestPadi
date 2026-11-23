/**
 * Plans and what each one allows. Cloud accounts are on Free or Pro; a
 * self-hosted server has no limits at all (you're paying for the hardware).
 */
import type { AppMode } from "../config.js";
import type { PlanId, User } from "../storage/repositories/users.js";

export interface PlanLimits {
	watchlist: number;
	activeAlerts: number;
	aiQuestionsPerDay: number;
	discordAlerts: boolean;
}

export interface Plan {
	id: PlanId;
	name: string;
	/** Display price; the charged amount comes from the Paystack plan. */
	priceLabel: string;
	/** Used as the initial charge amount for Paystack checkout (overridden by the plan). */
	amountKobo: number;
	tagline: string;
	limits: PlanLimits;
}

export const PLANS: Record<PlanId, Plan> = {
	free: {
		id: "free",
		name: "Free",
		priceLabel: "₦0",
		amountKobo: 0,
		tagline: "Follow the market and a handful of stocks.",
		limits: { watchlist: 10, activeAlerts: 3, aiQuestionsPerDay: 5, discordAlerts: false },
	},
	pro: {
		id: "pro",
		name: "Pro",
		priceLabel: "₦4,500/month",
		amountKobo: 450_000,
		tagline: "For active investors who research every day.",
		limits: { watchlist: 100, activeAlerts: 50, aiQuestionsPerDay: 100, discordAlerts: true },
	},
};

const UNLIMITED: PlanLimits = {
	watchlist: Number.POSITIVE_INFINITY,
	activeAlerts: Number.POSITIVE_INFINITY,
	aiQuestionsPerDay: Number.POSITIVE_INFINITY,
	discordAlerts: true,
};

/** How long a lapsed Pro renewal keeps working while Paystack retries the charge. */
const RENEWAL_GRACE_MS = 7 * 86_400_000;

/** The plan a user is effectively on right now. */
export function currentPlan(user: User, now = Date.now()): PlanId {
	if (user.plan !== "pro") return "free";
	if (user.planRenewsAt && Date.parse(`${user.planRenewsAt.replace(" ", "T")}Z`) + RENEWAL_GRACE_MS < now) {
		return "free";
	}
	return "pro";
}

export function limitsFor(user: User, mode: AppMode): PlanLimits {
	return mode === "self-hosted" ? UNLIMITED : PLANS[currentPlan(user)].limits;
}
