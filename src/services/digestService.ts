/**
 * Daily digests.
 *
 * - Market digest: breadth and movers for one market, posted to the server's
 *   broadcast channels (TELEGRAM_CHAT_ID, DISCORD_WEBHOOK_URL) after it closes.
 * - Personal digest: only the user's own watchlist, portfolio and alerts, sent
 *   after their default market closes over the channels they enabled.
 *
 * Every send is claimed in `job_state` / `users.last_digest_on`, so restarts and
 * multiple ticks never double-send.
 */
import { marketOverview } from "../analysis/market.js";
import { postDiscordWebhook } from "../integrations/discord.js";
import { type TelegramClient, toTelegramHtml } from "../integrations/telegram.js";
import { errorMessage, logger } from "../lib/logger.js";
import { isoDate } from "../lib/util.js";
import { EXCHANGES, type Exchange, MARKET_NAMES, WEEKDAY_MARKETS } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { User } from "../storage/repositories/users.js";
import type { Notifier } from "./notifier.js";
import type { PortfolioService } from "./portfolioService.js";
import type { WatchlistService } from "./watchlistService.js";

/** When each market's digest goes out (UTC): after NGX's 14:30 WAT close, the US close, and a morning crypto brief. */
export const DIGEST_TIMES: Record<Exchange, { hour: number; minute: number }> = {
	NGX: { hour: 15, minute: 0 },
	US: { hour: 21, minute: 30 },
	CRYPTO: { hour: 7, minute: 0 },
};

export function money(value: number | null | undefined, currency: string): string {
	if (value == null) return "—";
	const symbol = currency === "NGN" ? "₦" : currency === "USD" ? "$" : `${currency} `;
	const abs = Math.abs(value);
	const digits = abs !== 0 && abs < 1 ? 4 : 2;
	return `${value < 0 ? "−" : ""}${symbol}${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

export function pct(value: number | null | undefined): string {
	if (value == null) return "—";
	return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}%`;
}

const arrow = (v: number | null | undefined) => (v == null || v === 0 ? "•" : v > 0 ? "▲" : "▼");

export class DigestService {
	constructor(
		private readonly db: Database,
		private readonly notifier: Notifier,
		private readonly watchlists: WatchlistService,
		private readonly portfolio: PortfolioService,
		private readonly channels: {
			telegram: TelegramClient | null;
			telegramChatId: string | null;
			discordWebhookUrl: string | null;
			appUrl: string;
		},
	) {}

	get hasBroadcastChannels(): boolean {
		return Boolean((this.channels.telegram && this.channels.telegramChatId) || this.channels.discordWebhookUrl);
	}

	/** Market wrap in light markup, or null when there's no data. */
	marketDigest(exchange: Exchange): string | null {
		const o = marketOverview(this.db, exchange, 5);
		if (o.count === 0 || !o.date) return null;
		const currency = exchange === "NGX" ? "NGN" : "USD";
		const line = (q: (typeof o.gainers)[number]) => `${q.symbol} ${money(q.close, currency)} (${pct(q.changePct)})`;
		const best = o.sectors.find((s) => s.advancers + s.decliners > 0);
		const worst = [...o.sectors].reverse().find((s) => s.advancers + s.decliners > 0);
		return [
			`**${MARKET_NAMES[exchange]} — ${exchange === "CRYPTO" ? "24h" : "session"} ${o.date}**`,
			`▲ ${o.advancers} advancers · ▼ ${o.decliners} decliners · ${o.unchanged} unchanged`,
			"",
			`**Top gainers:** ${o.gainers.slice(0, 3).map(line).join(", ") || "none"}`,
			`**Top losers:** ${o.losers.slice(0, 3).map(line).join(", ") || "none"}`,
			`**Most traded:** ${o.mostActive
				.slice(0, 3)
				.map((q) => q.symbol)
				.join(", ")}`,
			best && worst && best !== worst
				? `**Sectors:** ${best.sector} led (${pct(best.avgChangePct)}), ${worst.sector} lagged (${pct(worst.avgChangePct)})`
				: "",
			"",
			`Full dashboard: ${this.channels.appUrl}/app · Not investment advice.`,
		]
			.filter((l, i, all) => l !== "" || (all[i - 1] ?? "") !== "")
			.join("\n");
	}

	/** The user's own wrap-up: watchlist moves, portfolio P&L, alerts. Null when there's nothing personal to say. */
	userDigest(user: User, day = isoDate(new Date())): { subject: string; paragraphs: string[] } | null {
		const paragraphs: string[] = [];

		const watch = this.watchlists
			.list(user)
			.filter((w) => w.quote)
			.sort((a, b) => Math.abs(b.quote?.changePct ?? 0) - Math.abs(a.quote?.changePct ?? 0))
			.slice(0, 12);
		if (watch.length) {
			paragraphs.push(
				`**Your watchlist**\n${watch
					.map(
						(w) =>
							`${arrow(w.quote?.changePct)} ${w.symbol} ${money(w.quote?.close, w.quote?.currency ?? "")} ${pct(w.quote?.changePct)}`,
					)
					.join("\n")}`,
			);
		}

		const { totals, positions } = this.portfolio.get(user);
		if (totals.length) {
			const top = [...positions]
				.filter((p) => p.dayPnl !== null)
				.sort((a, b) => Math.abs(b.dayPnl ?? 0) - Math.abs(a.dayPnl ?? 0))[0];
			paragraphs.push(
				`**Your portfolio**\n${totals
					.map(
						(t) =>
							`${t.currency}: ${money(t.value, t.currency)} · today ${money(t.dayPnl, t.currency)} · total ${money(t.pnl, t.currency)} (${pct(t.pnlPct)})`,
					)
					.join("\n")}${top ? `\nBiggest mover: ${top.symbol} ${money(top.dayPnl, top.currency)} today` : ""}`,
			);
		}

		const alerts = this.db.alerts.listForUser(user.id);
		const firedToday = alerts.filter((a) => a.triggeredAt?.startsWith(day));
		const active = alerts.filter((a) => !a.triggeredAt).length;
		if (firedToday.length || active) {
			paragraphs.push(
				`**Alerts** — ${active} active${firedToday.length ? `, fired today: ${firedToday.map((a) => `${a.symbol} ${a.condition} ${a.threshold}`).join(", ")}` : ""}`,
			);
		}

		if (paragraphs.length === 0) return null;
		const o = marketOverview(this.db, user.defaultExchange, 1);
		if (o.date) {
			paragraphs.unshift(
				`${MARKET_NAMES[user.defaultExchange]} ${o.date}: ▲ ${o.advancers} ▼ ${o.decliners}${o.gainers[0] ? ` · top gainer ${o.gainers[0].symbol} ${pct(o.gainers[0].changePct)}` : ""}`,
			);
		}
		return { subject: `Your ${MARKET_NAMES[user.defaultExchange]} wrap-up`, paragraphs };
	}

	/** Post to the server's Telegram chat and Discord channel. */
	async broadcast(text: string): Promise<string[]> {
		const sent: string[] = [];
		const { telegram, telegramChatId, discordWebhookUrl } = this.channels;
		if (telegram && telegramChatId) {
			await telegram
				.sendMessage(telegramChatId, toTelegramHtml(text))
				.then(() => sent.push("telegram"))
				.catch((err) => logger.warn("telegram broadcast failed", { error: errorMessage(err) }));
		}
		if (discordWebhookUrl) {
			await postDiscordWebhook(discordWebhookUrl, text)
				.then(() => sent.push("discord"))
				.catch((err) => logger.warn("discord broadcast failed", { error: errorMessage(err) }));
		}
		return sent;
	}

	async sendUserDigests(exchange: Exchange, day: string): Promise<number> {
		let sent = 0;
		for (const user of this.db.users.digestRecipients(exchange, day)) {
			// Claim first so a crash mid-send can't produce duplicates on the next tick.
			this.db.users.update(user.id, { lastDigestOn: day });
			if (this.notifier.channelsFor(user).length === 0) continue;
			const digest = this.userDigest(user, day);
			if (!digest) continue;
			const results = await this.notifier.deliver(user, digest.paragraphs, { subject: digest.subject });
			if (results.some((r) => r.ok)) sent++;
		}
		return sent;
	}

	/**
	 * Called every minute by the scheduler. For each market whose digest time has
	 * passed today: refresh its data, then (once per day) broadcast the market
	 * digest and send personal digests. Weekday markets skip weekends and holidays.
	 */
	async runDue(
		now: Date,
		refresh: (exchange: Exchange) => Promise<void>,
	): Promise<{ exchange: Exchange; broadcast: string[]; users: number }[]> {
		const day = isoDate(now);
		const results: { exchange: Exchange; broadcast: string[]; users: number }[] = [];
		for (const exchange of EXCHANGES) {
			const at = DIGEST_TIMES[exchange];
			if (now.getUTCHours() * 60 + now.getUTCMinutes() < at.hour * 60 + at.minute) continue;
			const weekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
			if (WEEKDAY_MARKETS.has(exchange) && weekend) continue;
			const key = `digest:${exchange}:${day}`;
			if (this.db.jobs.get(key)) continue;

			await refresh(exchange).catch((err) =>
				logger.warn(`pre-digest sync failed for ${exchange}`, { error: errorMessage(err) }),
			);
			const session = marketOverview(this.db, exchange, 1).date;
			if (WEEKDAY_MARKETS.has(exchange) && session !== day) {
				// Public holiday or data not published: nothing new to report today.
				this.db.jobs.claim(key, "no-session");
				continue;
			}
			if (!this.db.jobs.claim(key, "sent")) continue;
			const text = this.marketDigest(exchange);
			const broadcast = text ? await this.broadcast(text) : [];
			const users = await this.sendUserDigests(exchange, day);
			logger.info(`${exchange} digest sent`, { broadcast: broadcast.join(",") || "none", users });
			results.push({ exchange, broadcast, users });
		}
		return results;
	}
}
