/**
 * Chat bot commands, shared by Telegram and Discord.
 *
 * - Anyone (groups, channels, Discord servers, unlinked DMs) gets market data:
 *   /market, /quote, /analyze, /signals and rate-limited /ask.
 * - A Telegram DM linked to an account (Settings → Connect Telegram) also gets
 *   personal commands scoped strictly to that account: /watchlist, /portfolio,
 *   /alerts, /digest — and /ask counts against that account's plan.
 *
 * Replies use light markup (**bold**, `code`) that each adapter converts.
 */
import { type DividendEvent, dividendCalendar, dividendSummary } from "../analysis/dividends.js";
import { signalIdeas, signalSummary } from "../analysis/ideas.js";
import { marketOverview } from "../analysis/market.js";
import type { App } from "../app.js";
import { hashToken, randomToken } from "../lib/crypto.js";
import { AppError, FeatureUnavailableError, RateLimitError } from "../lib/errors.js";
import { errorMessage, logger } from "../lib/logger.js";
import { rateLimiter } from "../lib/rateLimit.js";
import { EXCHANGES, type Exchange, MARKET_NAMES, parseExchange } from "../markets/types.js";
import type { User } from "../storage/repositories/users.js";
import { money, pct } from "./digestService.js";

export interface BotContext {
	platform: "telegram" | "discord";
	/** Stable id of the chat/channel/user, used for rate limits. */
	chatKey: string;
	/** A one-to-one chat with the bot (Telegram DM). */
	isPrivate: boolean;
	/** The nVestPadi account linked to this chat, if any. */
	user: User | null;
	/** Telegram chat id, needed to link an account from /start. */
	chatId?: string;
}

export interface BotCommand {
	name: string;
	description: string;
	/** Name of the single free-text argument, for Discord slash-command options. */
	arg?: { name: string; description: string; required: boolean };
	personal?: boolean;
}

export const BOT_COMMANDS: BotCommand[] = [
	{
		name: "market",
		description: "Market breadth and top movers",
		arg: { name: "market", description: "ngx, us or crypto", required: false },
	},
	{
		name: "quote",
		description: "Latest price for a ticker",
		arg: { name: "symbol", description: "e.g. GTCO, AAPL, BTC", required: true },
	},
	{
		name: "analyze",
		description: "Technical read on a ticker",
		arg: { name: "symbol", description: "e.g. DANGCEM", required: true },
	},
	{
		name: "signals",
		description: "Fresh buy/sell signals with stop, target and success rate",
		arg: { name: "market", description: "ngx, us or crypto, optionally + sell", required: false },
	},
	{
		name: "dividends",
		description: "NGX dividend calendar, or a stock's dividends and yield",
		arg: { name: "symbol", description: "optional, e.g. ZENITHBANK", required: false },
	},
	{
		name: "size",
		description: "How much to buy: units for your capital and risk %",
		arg: { name: "args", description: "symbol capital [risk %], e.g. GTCO 1000000 1", required: true },
	},
	{
		name: "record",
		description: "Live track record of every signal since launch",
		arg: { name: "market", description: "ngx, us or crypto", required: false },
	},
	{
		name: "ask",
		description: "Ask a question about the markets",
		arg: { name: "question", description: "Your question", required: true },
	},
	{ name: "watchlist", description: "Your watchlist (linked accounts)", personal: true },
	{ name: "portfolio", description: "Your portfolio P&L (linked accounts)", personal: true },
	{ name: "alerts", description: "Your alerts (linked accounts)", personal: true },
	{
		name: "digest",
		description: "Turn your daily digest on or off",
		arg: { name: "state", description: "on or off", required: false },
		personal: true,
	},
	{ name: "unlink", description: "Disconnect this chat from your account", personal: true },
	{ name: "help", description: "What this bot can do" },
];

const LINK_TTL_SECONDS = 15 * 60;

export class BotService {
	private readonly publicAsk = rateLimiter(5, 60 * 60_000, "This chat has used its 5 questions for the hour.");

	constructor(private readonly app: App) {}

	/** Create a one-time deep link that connects a Telegram DM to `user`. */
	async telegramLink(user: User): Promise<string> {
		const telegram = this.app.telegram;
		if (!telegram) throw new FeatureUnavailableError("Telegram", ["TELEGRAM_BOT_TOKEN"]);
		const token = randomToken(24);
		await this.app.db.users.createAuthToken(hashToken(token), user.id, "telegram-link", LINK_TTL_SECONDS);
		return `https://t.me/${await telegram.botUsername()}?start=${token}`;
	}

	/** Parse "/cmd@BotName args" (or a bare question in a DM) and run it. */
	async handleText(text: string, ctx: BotContext): Promise<string | null> {
		const trimmed = text.trim();
		const match = /^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i.exec(trimmed);
		if (!match) return ctx.isPrivate && trimmed ? this.handle("ask", trimmed, ctx) : null;
		return this.handle((match[1] as string).toLowerCase(), (match[2] ?? "").trim(), ctx);
	}

	async handle(command: string, arg: string, ctx: BotContext): Promise<string> {
		try {
			return await this.dispatch(command, arg, ctx);
		} catch (err) {
			if (err instanceof AppError) return err.message;
			logger.warn("bot command failed", { command, error: errorMessage(err) });
			return "Something went wrong on our side. Please try again in a minute.";
		}
	}

	private async dispatch(command: string, arg: string, ctx: BotContext): Promise<string> {
		const spec = BOT_COMMANDS.find((c) => c.name === command);
		if (spec?.personal && !ctx.user) return this.linkHint(ctx);
		const user = ctx.user as User;

		switch (command) {
			case "start":
				return arg ? this.link(arg, ctx) : this.help(ctx);
			case "help":
				return this.help(ctx);
			case "market":
			case "movers":
				return this.market(parseExchange(arg || undefined) ?? ctx.user?.defaultExchange ?? "NGX");
			case "quote":
				return this.quote(arg);
			case "analyze":
				return this.analyze(arg);
			case "signals":
				return this.signals(arg, ctx);
			case "dividends":
				return this.dividends(arg.trim().toUpperCase());
			case "size":
				return this.size(arg);
			case "record":
				return this.record(parseExchange(arg || undefined) ?? ctx.user?.defaultExchange ?? "NGX");
			case "ask":
				return this.ask(arg, ctx);
			case "watchlist":
				return this.watchlist(user);
			case "portfolio":
				return this.portfolio(user);
			case "alerts":
				return this.alerts(user);
			case "digest":
				return this.digest(user, arg);
			case "unlink":
				await this.app.db.users.update(user.id, { telegramChatId: null });
				return "Disconnected. This chat won't receive your alerts or digests any more.";
			default:
				return `Unknown command /${command}. Send /help to see what I can do.`;
		}
	}

	private help(ctx: BotContext): string {
		const lines = BOT_COMMANDS.filter((c) => !c.personal || ctx.user).map(
			(c) => `/${c.name}${c.arg ? ` <${c.arg.name}>` : ""} — ${c.description}`,
		);
		return [
			"**nVestPadi** — Nigerian, US and crypto market research.",
			"",
			...lines,
			"",
			ctx.user
				? `Linked to ${ctx.user.email}. Your alerts and daily digest arrive here.`
				: ctx.isPrivate && ctx.platform === "telegram"
					? `Get your own alerts and portfolio updates here: ${this.app.config.appUrl}/app/settings#notifications → Connect Telegram.`
					: `Sign up for watchlists, alerts and a portfolio tracker: ${this.app.config.appUrl}`,
			"Information only — not investment advice.",
		].join("\n");
	}

	private linkHint(ctx: BotContext): string {
		return ctx.platform === "telegram" && ctx.isPrivate
			? `That's for linked accounts. Open ${this.app.config.appUrl}/app/settings#notifications and tap **Connect Telegram**.`
			: "Personal commands only work in a private Telegram chat linked to your nVestPadi account.";
	}

	private async link(token: string, ctx: BotContext): Promise<string> {
		if (ctx.platform !== "telegram" || !ctx.isPrivate || !ctx.chatId) {
			return "Open the link from a private chat with the bot, not a group.";
		}
		const userId = await this.app.db.users.consumeAuthToken(hashToken(token), "telegram-link");
		if (!userId) return "That link has expired. Generate a new one in Settings → Alert delivery.";
		// One chat per account, and one account per chat.
		const previous = await this.app.db.users.byTelegramChat(ctx.chatId);
		if (previous && previous.id !== userId) await this.app.db.users.update(previous.id, { telegramChatId: null });
		const user = await this.app.db.users.update(userId, { telegramChatId: ctx.chatId });
		return `✅ Connected to **${user.email}**. Your alerts and daily digest will arrive here.\nTry /watchlist or /portfolio.`;
	}

	private async market(exchange: Exchange): Promise<string> {
		const o = await marketOverview(this.app.db, exchange, 5);
		if (o.count === 0) return `No ${MARKET_NAMES[exchange]} data yet.`;
		const currency = exchange === "NGX" ? "NGN" : "USD";
		const fmt = (list: typeof o.gainers) =>
			list.map((q) => `${q.symbol} ${money(q.close, currency)} ${pct(q.changePct)}`).join("\n") || "none";
		return [
			`**${MARKET_NAMES[exchange]}** · ${o.date}`,
			`▲ ${o.advancers}  ▼ ${o.decliners}  • ${o.unchanged}`,
			"",
			`**Gainers**\n${fmt(o.gainers)}`,
			"",
			`**Losers**\n${fmt(o.losers)}`,
			"",
			`Other markets: ${EXCHANGES.filter((e) => e !== exchange)
				.map((e) => `/market ${e.toLowerCase()}`)
				.join(" · ")}`,
		].join("\n");
	}

	private parseSymbolArg(arg: string): { symbol: string; exchange?: Exchange } {
		const [first, second] = arg.split(/\s+/);
		if (!first) throw new AppError("Which ticker? e.g. /quote GTCO", 400);
		const [maybeEx, maybeSym] = first.includes(":") ? first.split(":") : [second, first];
		return { symbol: (maybeSym as string).toUpperCase(), exchange: parseExchange(maybeEx) };
	}

	private async quote(arg: string): Promise<string> {
		const { symbol, exchange } = this.parseSymbolArg(arg);
		const r = await this.app.market.report(symbol, exchange);
		const q = r.latest;
		return [
			`**${r.security.name}** (${r.security.exchange}:${r.security.symbol}${r.security.venue && r.security.venue !== r.security.exchange ? ` · ${r.security.venue}` : ""})`,
			`${money(q.close, r.security.currency)} ${pct(q.changePct)} · ${q.date}`,
			Object.entries(r.performance)
				.map(([k, v]) => `${k} ${pct(v)}`)
				.join(" · "),
			`More: /analyze ${r.security.symbol}`,
		]
			.filter(Boolean)
			.join("\n");
	}

	private async analyze(arg: string): Promise<string> {
		const { symbol, exchange } = this.parseSymbolArg(arg);
		const r = await this.app.market.report(symbol, exchange);
		return [
			`**${r.security.name}** (${r.security.exchange}:${r.security.symbol}) — ${money(r.latest.close, r.security.currency)} ${pct(r.latest.changePct)}`,
			r.call
				? `Signal: **${r.call.strength} ${r.call.side}**${r.call.track.trades ? ` · past success ${r.call.track.winRate}% of ${r.call.track.trades}` : ""}`
				: "Signal: none right now (hold / wait)",
			// The highlights already spell out the signal, its plan and its track record.
			...r.highlights.map((h) => `• ${h}`),
			"Educational analysis; success rates are past results, not predictions. Not investment advice.",
		]
			.filter(Boolean)
			.join("\n");
	}

	/** "/signals", "/signals us", "/signals ngx sell": evidence-backed ideas first, with the market's record. */
	private async signals(arg: string, ctx: BotContext): Promise<string> {
		const words = arg.toLowerCase().split(/\s+/).filter(Boolean);
		const side = words.includes("sell") ? "SELL" : "BUY";
		const exchange =
			parseExchange(words.find((w) => w !== "sell" && w !== "buy")) ?? ctx.user?.defaultExchange ?? "NGX";
		const [ideas, market] = await Promise.all([
			signalIdeas(this.app.db, exchange, { side, limit: 30 }),
			signalSummary(this.app.db, exchange),
		]);
		const m = market[side];
		const verdict =
			m.verdict === "better"
				? "better than chance"
				: m.verdict === "worse"
					? "worse than chance"
					: "not clearly better than chance";
		const record = m.trades
			? `Past ${side} signals here made money after costs ${m.winRate}% of ${m.trades} times vs ${m.baseRate}% for a random ${side === "BUY" ? "entry" : "exit"}: ${verdict}.`
			: "";
		const backed = ideas.filter((i) => i.evidence === "backed").slice(0, 8);
		const lines = backed.map((i) => {
			const p = i.call.plan;
			const levels = p ? ` · stop ${money(p.stop, i.currency)} · target ${money(p.target, i.currency)}` : "";
			const c = i.confidence;
			return `${side === "BUY" ? "🟢" : "🔴"} **${i.symbol}** ${money(i.close, i.currency)}${levels} · ${c.probability}% chance (${c.low}–${c.high}%, ${c.level}) · ${i.call.track.wins}/${i.call.track.trades} past`;
		});
		const others = ideas.length - backed.length;
		return [
			`**${MARKET_NAMES[exchange]} ${side} signals**`,
			record,
			"",
			lines.length
				? lines.join("\n")
				: `No fresh ${side.toLowerCase()} signal with a track record that beats chance right now.`,
			others ? `${others} more with a thin or poor record — see ${this.app.config.appUrl}/app` : "",
			"",
			"Chance = estimated odds of a profit after trading costs, from past signals on that stock and across the market. Live record: /record. Not investment advice.",
		]
			.filter((l, i, all) => l !== "" || (all[i - 1] ?? "") !== "")
			.join("\n")
			.trim();
	}

	/** "/dividends": upcoming NGX payouts you can still qualify for; "/dividends MTNN": one stock's record. */
	private async dividends(symbol: string): Promise<string> {
		const line = (d: DividendEvent) => {
			const amount = `${d.currency === "NGN" ? "₦" : "$"}${d.amount}`;
			const yieldText = d.payoutYieldPct === null ? "" : ` (${d.payoutYieldPct}%)`;
			const dates = d.qualificationDate
				? `buy by ${d.buyBy}, qualify ${d.qualificationDate}, paid ${d.paymentDate ?? "TBA"}`
				: "dates not announced";
			return `${amount} ${d.kind}${yieldText} · ${dates}`;
		};
		if (symbol) {
			const s = await dividendSummary(this.app.db, "NGX", symbol);
			if (!s.history.length) return `No dividends on record for ${symbol} (NGX notices since about a year ago).`;
			return [
				`**${symbol} dividends**`,
				s.trailingCount
					? `Past 12 months: ₦${s.trailingAmount} per share${s.trailingYieldPct === null ? "" : ` · yield ${s.trailingYieldPct}%`}`
					: "",
				s.next ? `Next: ${line(s.next)}` : "No upcoming payout announced.",
				"",
				...s.history.slice(0, 5).map((d) => `• ${d.qualificationDate ?? d.announcedAt.slice(0, 10)}: ${line(d)}`),
			]
				.filter((l, i, all) => l !== "" || (all[i - 1] ?? "") !== "")
				.join("\n");
		}
		const open = (await dividendCalendar(this.app.db, "NGX")).filter((d) => d.status === "open").slice(0, 10);
		return [
			"**NGX dividends you can still qualify for**",
			...(open.length ? open.map((d) => `🟢 **${d.symbol}** ${line(d)}`) : ["None open right now."]),
			"",
			"Buy by = 2 trading days before qualification (T+2), holidays not counted: confirm with your broker. /dividends SYMBOL for one stock.",
		].join("\n");
	}

	/** "/size GTCO 1000000 1": units to buy so a stop-out costs 1% of ₦1m, using the current BUY signal's stop. */
	private async size(arg: string): Promise<string> {
		const [symbol, capitalText, riskText] = arg.split(/\s+/).filter(Boolean);
		const capital = Number(capitalText?.replace(/[,_₦$]/g, ""));
		const riskPct = riskText === undefined ? undefined : Number(riskText.replace(/%$/, ""));
		if (!symbol || !(capital > 0) || (riskPct !== undefined && !(riskPct > 0))) {
			return "Usage: /size SYMBOL CAPITAL [RISK%], e.g. /size GTCO 1000000 1 (risk 1% of ₦1,000,000 at the signal's stop).";
		}
		const r = await this.app.sizing.size({ symbol, capital, riskPct });
		const z = r.sizing;
		const amount = (v: number) => money(v, r.currency);
		return [
			`**${r.symbol} position size** (${r.riskPct}% risk on ${amount(capital)})`,
			z.units > 0
				? `Buy **${r.exchange === "CRYPTO" ? z.units : z.units.toLocaleString("en-US")}** units ≈ ${amount(z.outlay)} with fees (${z.positionPct}% of capital).`
				: "Nothing: one unit is more than this risk budget allows.",
			`Stop ${money(r.levels.stop, r.currency)} → lose ${amount(z.lossAtStop)} (${z.lossAtStopPct}%).${z.gainAtTarget !== null ? ` Target ${money(r.levels.target, r.currency)} → gain ${amount(z.gainAtTarget)} (reward/risk ${z.rewardRisk}).` : ""}`,
			...z.warnings.map((w) => `⚠️ ${w}`),
			"A price can gap through a stop, so losses can be bigger. Not investment advice.",
		].join("\n");
	}

	/** "/record", "/record us": how logged signals have actually played out since launch. */
	private async record(exchange: Exchange): Promise<string> {
		const r = await this.app.ledger.report({ exchange, recent: 5 });
		const mine = r.exchanges.find((e) => e.exchange === exchange);
		const lines = (["BUY", "SELL"] as const).map((side) => {
			const t = mine?.[side];
			if (!t?.signals) return `${side}: no signals logged yet.`;
			if (!t.trades) return `${side}: ${t.signals} logged, none finished yet.`;
			return `${side}: ${t.wins} of ${t.trades} finished signals made money after costs (${t.winRate}%, avg ${pct(t.avgNetReturnPct)}) vs ${t.baseRate ?? "—"}% for a random entry · ${t.open} open`;
		});
		const recent = r.recent
			.filter((s) => s.status === "closed")
			.map(
				(s) =>
					`${s.side === "BUY" ? "🟢" : "🔴"} ${s.symbol} ${s.signalDate}: ${pct(s.netReturnPct)} after costs (${s.exitReason})`,
			);
		return [
			`**${MARKET_NAMES[exchange]} live track record**${r.since ? ` since ${r.since.slice(0, 10)}` : ""}`,
			...lines,
			recent.length ? `\nLatest finished:\n${recent.join("\n")}` : "",
			`\nEvery signal is logged when first shown and scored from the next session. Full record: ${this.app.config.appUrl}/track-record`,
		]
			.filter(Boolean)
			.join("\n");
	}

	private async ask(question: string, ctx: BotContext): Promise<string> {
		if (question.length < 3) return "Ask me something, e.g. /ask How did Nigerian banks trade today?";
		if (!this.app.ai) return "AI answers aren't enabled on this server yet.";
		let refund: () => Promise<void> = async () => undefined;
		if (ctx.user) refund = await this.app.accounts.meterAiQuestion(ctx.user);
		else {
			try {
				this.publicAsk(`${ctx.platform}:${ctx.chatKey}`);
			} catch (err) {
				if (err instanceof RateLimitError)
					return `${err.message} Sign up for your own daily allowance: ${this.app.config.appUrl}`;
				throw err;
			}
		}
		try {
			const a = await this.app.insights.ask(question.slice(0, 1000), { exchange: ctx.user?.defaultExchange });
			const sources = a.sources.length ? `\n\nSources: ${a.sources.map((s) => `[${s.n}] ${s.title}`).join("; ")}` : "";
			return `${a.answer}${sources}\n\nInformation only, not investment advice.`;
		} catch (err) {
			await refund().catch(() => undefined);
			throw err;
		}
	}

	private async watchlist(user: User): Promise<string> {
		const list = await this.app.watchlists.list(user);
		if (list.length === 0) return `Your watchlist is empty. Add stocks at ${this.app.config.appUrl}/app`;
		return [
			"**Your watchlist**",
			...list.map((w) => `${w.symbol} ${money(w.quote?.close, w.quote?.currency ?? "")} ${pct(w.quote?.changePct)}`),
		].join("\n");
	}

	private async portfolio(user: User): Promise<string> {
		const { positions, totals } = await this.app.portfolio.get(user);
		if (positions.length === 0) return `No positions yet. Add them at ${this.app.config.appUrl}/app`;
		return [
			"**Your portfolio**",
			...totals.map(
				(t) =>
					`${t.currency}: ${money(t.value, t.currency)} · today ${money(t.dayPnl, t.currency)} · total ${money(t.pnl, t.currency)} (${pct(t.pnlPct)})`,
			),
			"",
			...positions
				.slice(0, 15)
				.map((p) => `${p.symbol} ×${p.quantity} — ${money(p.value, p.currency)} (${pct(p.pnlPct)})`),
		].join("\n");
	}

	private async alerts(user: User): Promise<string> {
		const list = await this.app.alerts.list(user);
		if (list.length === 0) return `No alerts yet. Create them at ${this.app.config.appUrl}/app`;
		return [
			"**Your alerts**",
			...list.map((a) => `${a.triggeredAt ? "🔔 fired" : "⏳ active"} · ${a.symbol} ${a.condition} ${a.threshold}`),
		].join("\n");
	}

	private async digest(user: User, arg: string): Promise<string> {
		const on = arg ? /^(on|yes|true|1)$/i.test(arg) : !user.dailyDigest;
		await this.app.db.users.update(user.id, { dailyDigest: on });
		return on
			? `Daily digest **on** — it arrives after the ${MARKET_NAMES[user.defaultExchange]} close.`
			: "Daily digest **off**. Alerts still arrive as usual.";
	}
}
