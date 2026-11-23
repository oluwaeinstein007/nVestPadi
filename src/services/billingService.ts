/**
 * Subscriptions through Paystack (cards, bank transfer and USSD for Nigerian
 * customers). Checkout redirects to Paystack's hosted page; the webhook is the
 * source of truth for plan changes. Billing is cloud-only.
 *
 * Paystack setup: create a monthly plan, put its code in PAYSTACK_PLAN_CODE,
 * and point the dashboard webhook at `<APP_URL>/api/billing/webhook`.
 */
import type { Config } from "../config.js";
import { hmacSha512Hex, safeEqual } from "../lib/crypto.js";
import { FeatureUnavailableError, ValidationError } from "../lib/errors.js";
import { getJson, postJson } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import type { Database } from "../storage/database.js";
import type { User } from "../storage/repositories/users.js";
import { PLANS, currentPlan } from "./plans.js";

const API = "https://api.paystack.co";

interface PaystackEvent {
	event: string;
	data: {
		customer?: { email?: string; customer_code?: string };
		plan?: { plan_code?: string } | string | null;
		subscription_code?: string;
		next_payment_date?: string | null;
		metadata?: { userId?: number | string } | string | null;
	};
}

export class BillingService {
	constructor(
		private readonly db: Database,
		private readonly config: Config["billing"],
		private readonly appUrl: string,
		private readonly mode: Config["mode"],
	) {}

	get enabled(): boolean {
		return this.mode === "cloud" && this.config !== null;
	}

	private require(): NonNullable<Config["billing"]> {
		if (!this.enabled || !this.config) throw new FeatureUnavailableError("Billing", ["APP_MODE=cloud", "PAYSTACK_*"]);
		return this.config;
	}

	private headers(secret: string) {
		return { Authorization: `Bearer ${secret}` };
	}

	/** Start a Pro subscription; returns the Paystack checkout URL. */
	async checkout(user: User): Promise<string> {
		const config = this.require();
		if (currentPlan(user) === "pro" && user.billingSubscriptionId) throw new ValidationError("You're already on Pro.");
		const res = await postJson<{ status: boolean; data: { authorization_url: string } }>(
			`${API}/transaction/initialize`,
			{
				email: user.email,
				amount: PLANS.pro.amountKobo,
				plan: config.planCode,
				callback_url: `${this.appUrl}/app/settings?billing=success#plan`,
				metadata: { userId: user.id },
			},
			{ headers: this.headers(config.paystackSecretKey) },
		);
		return res.data.authorization_url;
	}

	/** Paystack-hosted page to update the card or cancel. */
	async manageUrl(user: User): Promise<string> {
		const config = this.require();
		if (!user.billingSubscriptionId) throw new ValidationError("You don't have an active subscription.");
		const res = await getJson<{ data: { link: string } }>(
			`${API}/subscription/${encodeURIComponent(user.billingSubscriptionId)}/manage/link`,
			{ headers: this.headers(config.paystackSecretKey) },
		);
		return res.data.link;
	}

	verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
		if (!this.config || !signature) return false;
		return safeEqual(hmacSha512Hex(this.config.paystackSecretKey, rawBody), signature);
	}

	/** Apply a verified webhook event. Unknown events are ignored. */
	handleEvent(event: PaystackEvent): { userId: number; plan: string } | null {
		const config = this.require();
		const d = event.data;
		const planCode = typeof d.plan === "string" ? d.plan : d.plan?.plan_code;
		const user = this.findUser(d);
		if (!user) {
			logger.warn("billing event for unknown customer", { event: event.event });
			return null;
		}

		switch (event.event) {
			case "subscription.create":
			case "charge.success":
			case "invoice.update": {
				if (planCode !== config.planCode) return null; // one-off charges for other products
				this.db.users.update(user.id, {
					plan: "pro",
					planRenewsAt: toSql(d.next_payment_date ?? new Date(Date.now() + 31 * 86_400_000).toISOString()),
					billingCustomerId: d.customer?.customer_code ?? user.billingCustomerId,
					billingSubscriptionId: d.subscription_code ?? user.billingSubscriptionId,
				});
				return { userId: user.id, plan: "pro" };
			}
			// Sent when a cancelled subscription reaches the end of its paid period, or Paystack gives up retrying.
			case "subscription.disable":
				this.db.users.update(user.id, { plan: "free", planRenewsAt: null, billingSubscriptionId: null });
				return { userId: user.id, plan: "free" };
			default:
				return null;
		}
	}

	private findUser(d: PaystackEvent["data"]): User | null {
		const meta = typeof d.metadata === "object" && d.metadata ? d.metadata : null;
		return (
			(meta?.userId ? this.db.users.byId(Number(meta.userId)) : null) ??
			(d.subscription_code ? this.db.users.bySubscription(d.subscription_code) : null) ??
			(d.customer?.customer_code ? this.db.users.byBillingCustomer(d.customer.customer_code) : null) ??
			(d.customer?.email ? this.db.users.byEmail(d.customer.email.toLowerCase()) : null)
		);
	}
}

/** ISO timestamp → SQLite `datetime()` format. */
function toSql(iso: string): string {
	return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}
