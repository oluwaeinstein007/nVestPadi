/** Market data commands: sync, history, quote, analyze, signals, size, record, market, screen. */
import { signalIdeas, signalSummary } from "../../analysis/ideas.js";
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
			for (const u of result.ledger)
				if (u.logged || u.closed)
					out(c.dim(`  ${u.exchange} track record: ${u.logged} new signals logged, ${u.closed} scored`));
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
							? `  Past ${t.side} signals: ${t.wins}/${t.trades} worked (${t.winRate}%) · random ${t.side === "BUY" ? "entry" : "exit"} ${t.baseRate}%${t.trades < r.rules.minTrades ? " · too few to rely on" : ""}`
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
	signals: {
		usage: "signals [--exchange NGX|US|CRYPTO] [--side BUY|SELL] [--all]",
		summary: "Fresh buy/sell signals with entry, stop, target and each one's past success rate",
		options: { ...exchangeFlag, side: { type: "string" }, all: { type: "boolean" } },
		async run(app, _args, flags, json) {
			const exchange = parseExchange(str(flags.exchange)) ?? "NGX";
			const sideFlag = str(flags.side)?.toUpperCase();
			if (sideFlag && sideFlag !== "BUY" && sideFlag !== "SELL") throw new UsageError("--side must be BUY or SELL");
			const side = (sideFlag ?? "BUY") as "BUY" | "SELL";
			const [ideas, market] = await Promise.all([
				signalIdeas(app.db, exchange, { side }),
				signalSummary(app.db, exchange),
			]);
			if (json) return { ideas, market };
			const shown = flags.all ? ideas : ideas.filter((i) => i.evidence === "backed");
			const m = market[side];
			out(heading(`${exchange} ${side} signals`, `${ideas.length} fresh`));
			if (m.trades) {
				const verdict = {
					better: c.green("better than chance"),
					worse: c.red("worse than chance"),
					unclear: c.yellow("not clearly better than chance"),
				}[m.verdict];
				out(
					`  Across ${m.symbols} securities, past ${side} signals made money after costs ${m.winRate}% of ${m.trades} times (${m.grossWinRate}% before) vs ${m.baseRate}% for a random ${side === "BUY" ? "entry" : "exit"} — ${verdict}.`,
				);
			}
			if (shown.length === 0) {
				out(
					c.dim(
						ideas.length
							? `\n  None with a track record that beats chance. ${ideas.length} more with --all.`
							: "\n  No fresh signals right now.",
					),
				);
				return;
			}
			out(
				table(shown, [
					{ header: "Symbol", value: (i) => `${c.bold(i.symbol)} ${c.dim(i.call.strength)}` },
					{ header: "Price", value: (i) => price(i.close), align: "right" },
					{ header: side === "BUY" ? "Stop" : "Wrong above", value: (i) => price(i.call.plan?.stop), align: "right" },
					{ header: side === "BUY" ? "Target" : "Down to", value: (i) => price(i.call.plan?.target), align: "right" },
					{
						header: "Chance",
						value: (i) => `${i.confidence.probability}% ${c.dim(`${i.confidence.low}–${i.confidence.high}`)}`,
						align: "right",
					},
					{
						header: "Past",
						value: (i) => (i.call.track.trades ? `${i.call.track.wins}/${i.call.track.trades}` : "—"),
						align: "right",
					},
					{
						header: "Confidence",
						value: (i) => ({ high: c.green, medium: c.yellow, low: c.red })[i.confidence.level](i.confidence.level),
					},
					{ header: "Evidence", value: (i) => (i.evidence === "backed" ? c.green(i.evidence) : c.yellow(i.evidence)) },
				]),
			);
			if (!flags.all && ideas.length > shown.length)
				out(c.dim(`\n  ${ideas.length - shown.length} more with a thin or poor record: --all`));
			out(
				c.dim(
					"\n  Chance = estimated odds of a profit after trading costs (90% range), from this security's past signals,\n  the market's and live results. Live record: nvest record. Not advice.",
				),
			);
		},
	},
	size: {
		usage:
			"size <SYMBOL> --capital <amount> [--risk 1] [--max-position 25] [--stop <price>] [--entry <price>] [--target <price>]",
		summary: "How much to buy: units sized so a stop-out loses --risk % of --capital, after fees",
		options: {
			...exchangeFlag,
			capital: { type: "string", short: "c" },
			risk: { type: "string", short: "r" },
			"max-position": { type: "string" },
			stop: { type: "string" },
			entry: { type: "string" },
			target: { type: "string" },
		},
		async run(app, args, flags, json) {
			const symbol = args[0];
			const capital = num(flags.capital, "capital");
			if (!symbol || capital === undefined) throw new UsageError("Usage: nvest size GTCO --capital 1000000 [--risk 1]");
			const r = await app.sizing.size({
				symbol,
				exchange: parseExchange(str(flags.exchange)),
				capital,
				riskPct: num(flags.risk, "risk"),
				maxPositionPct: num(flags["max-position"], "max-position"),
				stop: num(flags.stop, "stop"),
				entry: num(flags.entry, "entry"),
				target: num(flags.target, "target"),
			});
			if (json) return r;
			const z = r.sizing;
			const units = r.exchange === "CRYPTO" ? String(z.units) : z.units.toLocaleString("en-US");
			out(heading(`${r.exchange}:${r.symbol} position size`, r.name));
			out(
				kv([
					[
						"Levels",
						`entry ${price(r.levels.entry)} · stop ${price(r.levels.stop)}${r.levels.target ? ` · target ${price(r.levels.target)}` : ""} ${c.dim(`(${r.levels.source === "signal" ? "from the BUY signal" : "your levels"})`)}`,
					],
					["Buy", `${c.bold(units)} units ≈ ${r.currency} ${price(z.outlay)} with fees (${z.positionPct}% of capital)`],
					[
						"If stopped",
						`−${r.currency} ${price(z.lossAtStop)} (${z.lossAtStopPct}% of capital, risk budget ${r.riskPct}%)`,
					],
					[
						"At target",
						z.gainAtTarget === null
							? "—"
							: `+${r.currency} ${price(z.gainAtTarget)} (${z.gainAtTargetPct}%) · reward/risk ${z.rewardRisk}`,
					],
					["Limited by", z.limitedBy],
					[
						"Turnover",
						z.shareOfDailyValue === null
							? "unknown"
							: `${z.shareOfDailyValue < 0.1 ? "<0.1" : z.shareOfDailyValue}% of an average day's trading`,
					],
				]),
			);
			for (const w of z.warnings) out(`  ${c.yellow("!")} ${w}`);
			out(
				c.dim(
					`\n  Fees: buy ${r.costs.buyPct}%, sell ${r.costs.sellPct}%. A price can gap through a stop, so losses can exceed the budget. Not advice.`,
				),
			);
		},
	},
	record: {
		usage: "record [--exchange NGX|US|CRYPTO] [--recent 15]",
		summary: "Live track record: every signal shown since launch and how it played out after costs",
		options: { ...exchangeFlag, recent: { type: "string" } },
		async run(app, _args, flags, json) {
			const exchange = parseExchange(str(flags.exchange)) ?? "NGX";
			const r = await app.ledger.report({ exchange, recent: num(flags.recent, "recent") ?? 15 });
			if (json) return r;
			out(heading(`${exchange} live track record`, r.since ? `since ${r.since.slice(0, 10)}` : "nothing logged yet"));
			const mine = r.exchanges.find((e) => e.exchange === exchange);
			for (const side of ["BUY", "SELL"] as const) {
				const t = mine?.[side];
				if (!t?.signals) {
					out(`  ${side}: no signals logged yet`);
					continue;
				}
				const result = t.trades
					? `${t.wins}/${t.trades} made money after costs (${t.winRate}%, avg ${pct(t.avgNetReturnPct)}; ${t.grossWinRate}% before costs) vs ${t.baseRate ?? "—"}% random — ${t.verdict}`
					: "none finished yet";
				out(`  ${c.bold(side)}: ${t.signals} logged, ${t.open} open · ${result}`);
			}
			const cal = r.calibration;
			if (cal.brier !== null) {
				out(
					`\n  Stated chance vs outcome (all markets) · Brier ${cal.brier} vs ${cal.baselineBrier ?? "—"} for the random rate`,
				);
				for (const b of cal.buckets.filter((x) => x.trades))
					out(
						`    ${b.label.padEnd(12)} ${String(b.trades).padStart(4)} signals · said ${b.predicted}% · got ${b.actual}%`,
					);
			}
			if (r.recent.length) {
				out("");
				out(
					table(r.recent, [
						{
							header: "Signal",
							value: (s) => `${s.side === "BUY" ? c.green(s.side) : c.red(s.side)} ${c.bold(s.symbol)}`,
						},
						{ header: "Fired", value: (s) => s.signalDate },
						{ header: "Chance", value: (s) => (s.probability === null ? "—" : `${s.probability}%`), align: "right" },
						{ header: "Entry", value: (s) => price(s.entryPrice), align: "right" },
						{ header: "Last/exit", value: (s) => price(s.exitPrice ?? s.lastPrice), align: "right" },
						{ header: "Net", value: (s) => pct(s.netReturnPct), align: "right" },
						{ header: "Status", value: (s) => (s.status === "closed" ? (s.exitReason ?? "") : s.status) },
					]),
				);
			}
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
