/**
 * Grounded AI answers ("ask"). Context is assembled from:
 *  1. Technical reports for tickers/companies mentioned in the question
 *  2. Market breadth + movers when the question is about the market
 *  2b. Current BUY/SELL signal lists (with past success rates) for "what should I buy/sell" questions
 *  3. Semantic search over ingested documents and quote history (if Qdrant is set)
 * The model is instructed to answer only from that context and cite it.
 */
import type { AIProvider } from "../ai/provider.js";
import { signalIdeas, signalSummary } from "../analysis/ideas.js";
import { marketOverview } from "../analysis/market.js";
import { reportToText } from "../analysis/report.js";
import { FeatureUnavailableError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { EXCHANGES, type Exchange } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { KnowledgeBase } from "./knowledgeBase.js";
import type { MarketService } from "./marketService.js";

export interface Source {
	n: number;
	title: string;
	source: string;
	kind: string;
	score?: number;
}

export interface Answer {
	question: string;
	answer: string;
	sources: Source[];
	symbols: string[];
	model: string;
}

const SYSTEM_PROMPT = `You are nVestPadi, a research assistant for Nigerian Exchange (NGX) stocks, US stocks and crypto.
Rules:
- Answer ONLY from the numbered context. Never invent prices, dates or figures.
- Cite every factual claim inline with its context number, e.g. "closed at 1,323 [2]".
- If the context doesn't cover the question, say so plainly and suggest what would help (e.g. opening the stock in nVestPadi to load its history, or adding research documents).
- Prefer specifics: numbers, percentages, dates. Use NGN for NGX prices and USD for US stocks and crypto.
- Be concise: a direct answer first, then short supporting bullets.
- When asked what to buy or sell, or when, use the signal lists and snapshots: name the securities, their entry/stop/target levels and each signal's past success rate with how many past signals it's based on. Say plainly that success rates are historical, before fees, and not a guarantee; fewer than 5 past signals is too few to rely on.
- You provide information, not personalised investment advice.`;

const MARKET_WORDS =
	/\b(market|markets|gainers?|losers?|movers?|sectors?|breadth|today|this week|rall(y|ied)|top|best|worst|biggest|index|asi|crypto|coins?)\b/i;
const SIGNAL_WORDS =
	/\b(buy|buying|sell|selling|signals?|recommend\w*|invest in|entry|exit|stop.?loss|target|when to|should i|opportunit\w*|ideas?|picks?)\b/i;
const NAME_SUFFIX = /\s+(plc|inc\.?|corp(oration)?\.?|holdings?|limited|ltd\.?|company|co\.?|group)\b.*$/i;

export class InsightService {
	constructor(
		private readonly db: Database,
		private readonly ai: AIProvider | null,
		private readonly kb: KnowledgeBase,
		private readonly market: MarketService,
	) {}

	/** Find securities referenced by ticker (e.g. "GTCO", "aapl") or company name. */
	async detectSymbols(question: string, max = 3): Promise<{ exchange: Exchange; symbol: string }[]> {
		const found = new Map<string, { exchange: Exchange; symbol: string }>();
		const lower = question.toLowerCase();
		const tokens = new Set(
			(question.match(/\b[A-Za-z][A-Za-z0-9.-]{0,11}\b/g) ?? [])
				// All-caps tokens are tickers; lowercase ones only if long enough to not be English words.
				// Single letters ("I", "A") are almost never meant as tickers.
				.filter((t) => t.length >= 2 && (t === t.toUpperCase() || t.length >= 5))
				.map((t) => t.toUpperCase()),
		);
		for (const s of await this.db.market.allSymbols()) {
			const shortName = s.name.replace(NAME_SUFFIX, "").toLowerCase();
			const byTicker = tokens.has(s.symbol);
			const byName = shortName.length >= 4 && new RegExp(`\\b${escapeRegex(shortName)}\\b`).test(lower);
			if (byTicker || byName) found.set(`${s.exchange}:${s.symbol}`, { exchange: s.exchange, symbol: s.symbol });
			if (found.size >= max) break;
		}
		return [...found.values()];
	}

	async ask(question: string, options: { exchange?: Exchange } = {}): Promise<Answer> {
		if (!this.ai) throw new FeatureUnavailableError("AI answers", ["AI_PROVIDER + AI_API_KEY"]);

		const context: { title: string; source: string; kind: string; text: string; score?: number }[] = [];
		const symbols = await this.detectSymbols(question);

		for (const s of symbols) {
			try {
				const report = await this.market.report(s.symbol, s.exchange);
				context.push({
					title: `${report.security.name} technical snapshot`,
					source: `${s.exchange}:${s.symbol}`,
					kind: "analysis",
					text: reportToText(report),
				});
			} catch (err) {
				logger.debug("report unavailable for context", { symbol: s.symbol, error: String(err) });
			}
		}

		if (MARKET_WORDS.test(question) || symbols.length === 0) {
			const exchanges: Exchange[] = options.exchange ? [options.exchange] : [...EXCHANGES];
			for (const exchange of exchanges) {
				const o = await marketOverview(this.db, exchange, 5);
				if (o.count === 0) continue;
				const fmt = (list: typeof o.gainers) =>
					list.map((q) => `${q.symbol} ${(q.changePct ?? 0) >= 0 ? "+" : ""}${q.changePct}%`).join(", ");
				context.push({
					title: `${exchange} market overview ${o.date}`,
					source: `${exchange}:market`,
					kind: "analysis",
					text:
						`${exchange} session ${o.date}: ${o.advancers} advancers, ${o.decliners} decliners, ${o.unchanged} unchanged of ${o.count}. ` +
						`Top gainers: ${fmt(o.gainers) || "none"}. Top losers: ${fmt(o.losers) || "none"}. ` +
						`Most traded by value: ${o.mostActive.map((q) => q.symbol).join(", ")}. ` +
						`Sector average change: ${o.sectors.map((s) => `${s.sector} ${s.avgChangePct}%`).join("; ")}.`,
				});
			}
		}

		if (SIGNAL_WORDS.test(question)) {
			const exchanges: Exchange[] = options.exchange ? [options.exchange] : [...EXCHANGES];
			for (const exchange of exchanges) {
				for (const side of ["BUY", "SELL"] as const) {
					const ideas = await signalIdeas(this.db, exchange, { side, limit: 8 });
					if (ideas.length === 0) continue;
					const list = ideas
						.map((i) => {
							const p = i.call.plan;
							const t = i.call.track;
							const levels = p ? ` entry ${p.entry}, stop ${p.stop}, target ${p.target}, ~${p.horizon} sessions;` : "";
							const record = t.trades
								? ` past ${side} signals worked ${t.winRate}% of ${t.trades} (random: ${t.baseRate}%)`
								: " no past record";
							return `${i.symbol} (${i.name}) ${i.call.strength} ${side} at ${i.currency} ${i.close} on ${i.call.date}:${levels}${record}`;
						})
						.join("; ");
					const m = (await signalSummary(this.db, exchange))[side];
					const overall = m.trades
						? ` Across the market, past ${side} signals worked ${m.winRate}% of ${m.trades} vs ${m.baseRate}% for a random entry.`
						: "";
					context.push({
						title: `${exchange} current ${side} signals`,
						source: `${exchange}:signals`,
						kind: "analysis",
						text: `${exchange} securities with a fresh ${side} signal (best-evidenced first): ${list}.${overall} Success rates come from replaying past signals, before fees.`,
					});
				}
			}
		}

		if (this.kb.enabled) {
			try {
				const hits = await this.kb.search(question, {
					limit: 8,
					filter: options.exchange ? { exchange: options.exchange } : undefined,
				});
				for (const h of hits) {
					context.push({
						title: h.payload.title,
						source: h.payload.source,
						kind: h.payload.kind,
						text: h.payload.content,
						score: h.score,
					});
				}
			} catch (err) {
				logger.warn("semantic search failed; answering from market data only", { error: String(err) });
			}
		}

		if (context.length === 0) {
			return {
				question,
				answer:
					"I don't have any data to answer that yet. Market data appears after the next sync (self-hosted: run `nvest sync`), and research documents can be added with `nvest ingest`.",
				sources: [],
				symbols: [],
				model: this.ai.chatModel,
			};
		}

		const numbered = context.map((c, i) => `[${i + 1}] ${c.title} (${c.source})\n${c.text}`).join("\n\n");
		const answer = await this.ai.chat([
			{ role: "system", content: SYSTEM_PROMPT },
			{
				role: "user",
				content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nContext:\n${numbered}\n\nQuestion: ${question}`,
			},
		]);

		return {
			question,
			answer: answer || "The model returned an empty answer — try rephrasing the question.",
			sources: context.map((c, i) => ({ n: i + 1, title: c.title, source: c.source, kind: c.kind, score: c.score })),
			symbols: symbols.map((s) => `${s.exchange}:${s.symbol}`),
			model: this.ai.chatModel,
		};
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
