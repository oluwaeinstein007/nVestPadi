/** Market data commands: sync, history, quote, analyze, market, screen. */
import { SCREEN_SORTS, type ScreenSort, marketOverview, screen } from "../../analysis/market.js";
import { parseExchange } from "../../markets/types.js";
import { YAHOO_RANGES, type YahooRange } from "../../markets/yahoo.js";
import { Scheduler } from "../../scheduler.js";
import { SymbolNotFoundError } from "../../services/marketService.js";
import { type Command, UsageError, exchangeFlag, exchangesArg, num, out, str } from "../command.js";
import { c, compact, heading, kv, pct, price, signalBadge, sparkline, table } from "../format.js";

export const marketCommands: Record<string, Command> = {
	sync: {
		usage: "sync [ngx|us|crypto|all] [--symbols AAPL,MSFT] [--no-index] [--backfill] [--every <minutes>]",
		summary: "Fetch the latest session's prices, store them, index them and check alerts",
		options: {
			symbols: { type: "string" },
			"no-index": { type: "boolean" },
			backfill: { type: "boolean" },
			every: { type: "string" },
		},
		async run(app, args, flags, json) {
			const exchanges = exchangesArg(args[0]);
			const options = {
				symbols: str(flags.symbols)
					?.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				index: !flags["no-index"],
			};
			const every = num(flags.every, "every");
			if (every) {
				new Scheduler(app).startSync(every, exchanges, options);
				await new Promise(() => undefined); // run until interrupted
			}
			const result = await app.syncAndAlert(exchanges, options);
			if (flags.backfill) {
				for (const r of result.results) {
					const n = await app.market.backfill(r.exchange, { limit: 1000 });
					if (!json) out(`${c.green("✔")} ${c.bold(r.exchange)}  backfilled history for ${n} symbols`);
				}
			}
			if (json) return result;
			for (const r of result.results) {
				out(
					`${c.green("✔")} ${c.bold(r.exchange)}  ${r.bars} prices for ${r.securities} securities` +
						`${r.date ? c.dim(` · session ${r.date}`) : ""}${r.indexed ? c.dim(` · ${r.indexed} indexed`) : ""}`,
				);
				if (r.failed.length) out(`  ${c.yellow("!")} failed: ${r.failed.join(", ")}`);
			}
			for (const e of result.errors) out(`${c.red("✘")} ${c.bold(e.exchange)}  ${e.error}`);
			for (const t of result.triggered) out(`${c.yellow("🔔")} ${t.message}`);
			if (!app.kb.enabled && result.results.length)
				out(c.dim("  Tip: configure AI_PROVIDER + QDRANT_URL to make synced data searchable with `nvest ask`."));
			if (result.errors.length && !result.results.length) process.exitCode = 1;
		},
	},
	history: {
		usage: "history <SYMBOL> [--exchange NGX|US|CRYPTO] [--range 1y]",
		summary: `Backfill daily history (US ranges: ${YAHOO_RANGES.join(" ")})`,
		options: { ...exchangeFlag, range: { type: "string", short: "r" } },
		async run(app, args, flags, json) {
			const symbol = args[0];
			if (!symbol) throw new UsageError("Missing SYMBOL");
			const range = str(flags.range) ?? "1y";
			if (!(YAHOO_RANGES as readonly string[]).includes(range))
				throw new UsageError(`--range must be one of: ${YAHOO_RANGES.join(", ")}`);
			const result = await app.market.loadHistory(symbol, {
				exchange: parseExchange(str(flags.exchange)),
				range: range as YahooRange,
			});
			if (json) return result;
			out(
				`${c.green("✔")} ${result.exchange}:${result.symbol}  ${result.bars} daily bars ${c.dim(`${result.from} → ${result.to}`)}`,
			);
		},
	},
	quote: {
		usage: "quote <SYMBOL...> [--exchange NGX|US|CRYPTO]",
		summary: "Show the latest stored quote for one or more symbols",
		options: exchangeFlag,
		async run(app, args, flags, json) {
			if (args.length === 0) throw new UsageError("Missing SYMBOL");
			const exchange = parseExchange(str(flags.exchange));
			const quotes = await Promise.all(
				args.map(async (s) => {
					const t = await app.market.resolve(s, exchange);
					const q = await app.db.market.latestQuote(t.exchange, t.symbol);
					if (!q) throw new SymbolNotFoundError(t.symbol, t.exchange);
					return q;
				}),
			);
			if (json) return quotes;
			out(
				table(quotes, [
					{ header: "Symbol", value: (q) => c.bold(`${q.symbol}`) },
					{ header: "Name", value: (q) => q.name.slice(0, 32) },
					{ header: "Price", value: (q) => `${price(q.close)} ${c.dim(q.currency)}`, align: "right" },
					{ header: "Change", value: (q) => pct(q.changePct), align: "right" },
					{ header: "Volume", value: (q) => compact(q.volume), align: "right" },
					{ header: "Date", value: (q) => c.dim(q.date) },
				]),
			);
		},
	},
	analyze: {
		usage: "analyze <SYMBOL> [--exchange NGX|US|CRYPTO]",
		summary: "Technical report: trend, RSI, MACD, moving averages, signals, performance",
		options: exchangeFlag,
		async run(app, args, flags, json) {
			const symbol = args[0];
			if (!symbol) throw new UsageError("Missing SYMBOL");
			const r = await app.market.report(symbol, parseExchange(str(flags.exchange)));
			if (json) return r;
			const i = r.indicators;
			const closes = (await app.db.market.history(r.security.exchange, r.security.symbol, 120)).map((b) => b.close);
			out(
				heading(
					`${r.security.name}`,
					`${r.security.exchange}:${r.security.symbol}${r.security.sector ? ` · ${r.security.sector}` : ""}`,
				),
			);
			out(
				`  ${c.bold(`${r.security.currency} ${price(r.latest.close)}`)}  ${pct(r.latest.changePct)}  ${c.dim(r.latest.date)}   ${sparkline(closes)}`,
			);
			if (r.call) {
				const t = r.call.track;
				out(`\n  ${signalBadge(r.call.side, r.call.strength)} ${c.dim(r.call.reason)}`);
				if (r.call.plan) {
					const p = r.call.plan;
					out(
						p.side === "BUY"
							? `  Entry ~${price(p.entry)}  stop ${c.red(price(p.stop))} (−${p.riskPct}%)  target ${c.green(price(p.target))} (+${p.rewardPct}%)  ~${p.horizon} sessions`
							: `  Sell/trim ~${price(p.entry)}  wrong above ${price(p.stop)} (+${p.riskPct}%)  downside ${price(p.target)} (−${p.rewardPct}%)  ~${p.horizon} sessions`,
					);
				}
				out(
					c.dim(
						t.trades
							? `  Past ${t.side} signals: ${t.wins}/${t.trades} worked (${t.winRate}%) · random entry ${t.baseRate}%${t.trades < r.rules.minTrades ? " · too few to rely on" : ""}`
							: `  No past ${t.side} signals to measure yet`,
					),
				);
			}
			out(heading("Performance"));
			out(
				`  ${
					Object.entries(r.performance)
						.map(([k, v]) => `${c.dim(k)} ${pct(v)}`)
						.join("   ") || c.dim("not enough history")
				}`,
			);
			out(heading("Indicators"));
			out(
				kv([
					["Trend", r.trend],
					[
						"RSI (14)",
						i.rsi14 === null
							? "—"
							: `${i.rsi14.toFixed(1)}${i.rsi14 >= 70 ? c.red(" overbought") : i.rsi14 <= 30 ? c.green(" oversold") : ""}`,
					],
					[
						"MACD",
						i.macd
							? `${i.macd.line} / signal ${i.macd.signal} / hist ${i.macd.histogram >= 0 ? c.green(String(i.macd.histogram)) : c.red(String(i.macd.histogram))}`
							: "—",
					],
					["SMA 20 / 50 / 200", [i.sma20, i.sma50, i.sma200].map(price).join(" / ")],
					["Bollinger (20,2)", i.bollinger ? `${price(i.bollinger.lower)} – ${price(i.bollinger.upper)}` : "—"],
					["ATR (14)", price(i.atr14)],
					["Volatility (ann.)", i.volatilityPct === null ? "—" : `${i.volatilityPct}%`],
					[
						"52w range",
						r.range52w
							? `${price(r.range52w.low)} – ${price(r.range52w.high)} ${c.dim(`(at ${r.range52w.positionPct}%)`)}`
							: "—",
					],
				]),
			);
			out(heading("Summary"));
			for (const h of r.highlights) out(`  • ${h}`);
			out(c.dim("\n  Educational analysis, not investment advice."));
		},
	},
	market: {
		usage: "market [--exchange NGX|US|CRYPTO] [--top 5]",
		summary: "Market breadth, top gainers/losers, most traded and sector performance",
		options: { ...exchangeFlag, top: { type: "string" } },
		async run(app, _args, flags, json) {
			const exchange = parseExchange(str(flags.exchange)) ?? "NGX";
			const o = await marketOverview(app.db, exchange, num(flags.top, "top") ?? 5);
			if (json) return o;
			if (o.count === 0) {
				out(`No ${exchange} data yet. Run ${c.bold(`nvest sync ${exchange.toLowerCase()}`)} first.`);
				return;
			}
			out(heading(`${exchange} market`, `session ${o.date}`));
			out(
				`  ${c.green(`▲ ${o.advancers}`)}  ${c.red(`▼ ${o.decliners}`)}  ${c.dim(`■ ${o.unchanged}`)}   ` +
					`${c.dim("volume")} ${compact(o.totalVolume)}   ${c.dim("value")} ${compact(o.totalValue)}`,
			);
			const movers = (title: string, list: typeof o.gainers) => {
				out(heading(title));
				out(
					table(list, [
						{ header: "Symbol", value: (q) => c.bold(q.symbol) },
						{ header: "Name", value: (q) => q.name.slice(0, 28) },
						{ header: "Price", value: (q) => price(q.close), align: "right" },
						{ header: "Change", value: (q) => pct(q.changePct), align: "right" },
						{ header: "Value", value: (q) => compact(q.value ?? (q.volume ?? 0) * q.close), align: "right" },
					]),
				);
			};
			movers("Top gainers", o.gainers);
			movers("Top losers", o.losers);
			movers("Most traded", o.mostActive);
			out(heading("Sectors"));
			out(
				table(o.sectors, [
					{ header: "Sector", value: (s) => s.sector },
					{ header: "Avg change", value: (s) => pct(s.avgChangePct), align: "right" },
					{
						header: "▲/▼",
						value: (s) => `${c.green(String(s.advancers))}/${c.red(String(s.decliners))}`,
						align: "right",
					},
					{ header: "Stocks", value: (s) => String(s.count), align: "right" },
				]),
			);
		},
	},
	screen: {
		usage:
			"screen [--exchange NGX] [--sector banks] [--search dangote] [--sort gainers] [--min-price N] [--max-price N] [--rsi-below 30] [--rsi-above 70] [--limit 20]",
		summary: `Filter and rank stocks (sort: ${SCREEN_SORTS.join(", ")})`,
		options: {
			...exchangeFlag,
			sector: { type: "string" },
			search: { type: "string", short: "q" },
			sort: { type: "string", short: "s" },
			"min-price": { type: "string" },
			"max-price": { type: "string" },
			"rsi-below": { type: "string" },
			"rsi-above": { type: "string" },
			limit: { type: "string", short: "n" },
		},
		async run(app, _args, flags, json) {
			const sort = str(flags.sort) ?? "gainers";
			if (!(SCREEN_SORTS as readonly string[]).includes(sort))
				throw new UsageError(`--sort must be one of: ${SCREEN_SORTS.join(", ")}`);
			const rows = await screen(app.db, {
				exchange: parseExchange(str(flags.exchange)) ?? "NGX",
				sector: str(flags.sector),
				query: str(flags.search),
				sort: sort as ScreenSort,
				minPrice: num(flags["min-price"], "min-price"),
				maxPrice: num(flags["max-price"], "max-price"),
				rsiBelow: num(flags["rsi-below"], "rsi-below"),
				rsiAbove: num(flags["rsi-above"], "rsi-above"),
				limit: num(flags.limit, "limit") ?? 20,
			});
			if (json) return rows;
			const showRsi = rows.some((r) => r.rsi14 !== null);
			out(
				table(rows, [
					{ header: "Symbol", value: (q) => c.bold(q.symbol) },
					{ header: "Name", value: (q) => q.name.slice(0, 28) },
					{ header: "Sector", value: (q) => c.dim((q.sector ?? "").slice(0, 22)) },
					{ header: "Price", value: (q) => price(q.close), align: "right" },
					{ header: "Change", value: (q) => pct(q.changePct), align: "right" },
					{ header: "Value", value: (q) => compact(q.tradedValue), align: "right" },
					...(showRsi
						? [
								{
									header: "RSI",
									value: (q: (typeof rows)[number]) => (q.rsi14 === null ? "—" : String(q.rsi14)),
									align: "right" as const,
								},
							]
						: []),
				]),
			);
			if (rows.length === 0 && (flags["rsi-below"] || flags["rsi-above"]))
				out(
					c.dim(
						"  RSI filters need ≥15 sessions of history per stock (`nvest sync` daily, or `nvest history <SYMBOL>`).",
					),
				);
		},
	},
};
