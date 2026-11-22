#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * nvest — command-line interface for nVestPadi.
 * Run `nvest help` (or `pnpm nvest help` from a checkout) for usage.
 */
import { parseArgs } from "node:util";
import { SCREEN_SORTS, type ScreenSort, marketOverview, screen } from "../analysis/market.js";
import { type App, createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { configureLogger, errorMessage, logger } from "../lib/logger.js";
import { onShutdown } from "../lib/shutdown.js";
import { EXCHANGES, type Exchange, parseExchange } from "../markets/types.js";
import { YAHOO_RANGES, type YahooRange } from "../markets/yahoo.js";
import { startScheduler } from "../scheduler.js";
import { startServer } from "../server/server.js";
import { ALERT_CONDITIONS, isAlertCondition } from "../services/alertService.js";
import { FeatureUnavailableError } from "../services/knowledgeBase.js";
import { SymbolNotFoundError } from "../services/marketService.js";
import { c, compact, heading, kv, pct, price, signalBadge, sparkline, table } from "./format.js";

const VERSION = "2.0.0";

type Flags = Record<string, string | boolean | undefined>;
interface Command {
	usage: string;
	summary: string;
	options?: Record<string, { type: "string" | "boolean"; short?: string }>;
	run(app: App, args: string[], flags: Flags, json: boolean): Promise<unknown>;
}

class UsageError extends Error {}

const out = (s = "") => process.stdout.write(`${s}\n`);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown, name: string) => {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
	return n;
};
const exchangeFlag = { exchange: { type: "string" as const, short: "e" } };
const exchangesArg = (arg: string | undefined): Exchange[] =>
	!arg || arg.toLowerCase() === "all" ? [...EXCHANGES] : [parseExchange(arg) as Exchange];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands: Record<string, Command> = {
	sync: {
		usage: "sync [ngx|us|all] [--symbols AAPL,MSFT] [--no-index] [--every <minutes>]",
		summary: "Fetch the latest session's prices, store them, index them and check alerts",
		options: { symbols: { type: "string" }, "no-index": { type: "boolean" }, every: { type: "string" } },
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
				startScheduler(app, every, exchanges, options);
				await new Promise(() => undefined); // run until interrupted
			}
			const result = await app.syncAndAlert(exchanges, options);
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
		usage: "history <SYMBOL> [--exchange NGX|US] [--range 1y]",
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
			if (result.exchange === "NGX")
				out(c.dim("  NGX public history covers ~10 sessions; it grows each day you run `nvest sync`."));
		},
	},

	quote: {
		usage: "quote <SYMBOL...> [--exchange NGX|US]",
		summary: "Show the latest stored quote for one or more symbols",
		options: exchangeFlag,
		async run(app, args, flags, json) {
			if (args.length === 0) throw new UsageError("Missing SYMBOL");
			const exchange = parseExchange(str(flags.exchange));
			const quotes = args.map((s) => {
				const t = app.market.resolve(s, exchange);
				const q = app.db.latestQuote(t.exchange, t.symbol);
				if (!q) throw new SymbolNotFoundError(t.symbol, t.exchange);
				return q;
			});
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
		usage: "analyze <SYMBOL> [--exchange NGX|US]",
		summary: "Technical report: trend, RSI, MACD, moving averages, signals, performance",
		options: exchangeFlag,
		async run(app, args, flags, json) {
			const symbol = args[0];
			if (!symbol) throw new UsageError("Missing SYMBOL");
			const r = await app.market.report(symbol, parseExchange(str(flags.exchange)));
			if (json) return r;
			const i = r.indicators;
			const closes = app.db.history(r.security.exchange, r.security.symbol, 120).map((b) => b.close);
			out(
				heading(
					`${r.security.name}`,
					`${r.security.exchange}:${r.security.symbol}${r.security.sector ? ` · ${r.security.sector}` : ""}`,
				),
			);
			out(
				`  ${c.bold(`${r.security.currency} ${price(r.latest.close)}`)}  ${pct(r.latest.changePct)}  ${c.dim(r.latest.date)}   ${sparkline(closes)}`,
			);
			if (r.signal) out(`\n  ${signalBadge(r.signal.signal, r.signal.strength)} ${c.dim(r.signal.reason)}`);
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
		usage: "market [--exchange NGX|US] [--top 5]",
		summary: "Market breadth, top gainers/losers, most traded and sector performance",
		options: { ...exchangeFlag, top: { type: "string" } },
		async run(app, _args, flags, json) {
			const exchange = parseExchange(str(flags.exchange)) ?? "NGX";
			const o = marketOverview(app.db, exchange, num(flags.top, "top") ?? 5);
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
			const rows = screen(app.db, {
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

	watchlist: {
		usage: "watchlist [list | add <SYMBOL...> | remove <SYMBOL...>] [--exchange NGX|US]",
		summary: "Track the stocks you care about",
		options: exchangeFlag,
		async run(app, args, flags, json) {
			const [action = "list", ...symbols] = args;
			const exchange = parseExchange(str(flags.exchange));
			if (action === "add" || action === "remove") {
				if (symbols.length === 0) throw new UsageError(`watchlist ${action} needs at least one SYMBOL`);
				for (const s of symbols) {
					if (action === "add") {
						const t = await app.market.watch(s, exchange);
						if (!json) out(`${c.green("✔")} Added ${t.exchange}:${t.symbol}`);
						continue;
					}
					const t = app.market.resolve(s, exchange);
					if (!app.db.removeFromWatchlist(t.exchange, t.symbol))
						throw new UsageError(`${t.symbol} is not on your watchlist`);
					if (!json) out(`${c.green("✔")} Removed ${t.exchange}:${t.symbol}`);
				}
				return json ? app.db.watchlist() : undefined;
			}
			if (action !== "list") throw new UsageError(`Unknown watchlist action "${action}"`);
			const rows = app.db.watchlist().map((w) => ({ ...w, quote: app.db.latestQuote(w.exchange, w.symbol) }));
			if (json) return rows;
			if (rows.length === 0)
				return out(`Your watchlist is empty. Add one with ${c.bold("nvest watchlist add DANGCEM")}.`);
			out(
				table(rows, [
					{ header: "Symbol", value: (r) => c.bold(`${r.symbol}`) },
					{ header: "Exch", value: (r) => c.dim(r.exchange) },
					{ header: "Name", value: (r) => (r.quote?.name ?? "").slice(0, 28) },
					{ header: "Price", value: (r) => price(r.quote?.close), align: "right" },
					{ header: "Change", value: (r) => pct(r.quote?.changePct), align: "right" },
					{
						header: "Trend",
						value: (r) =>
							sparkline(
								app.db.history(r.exchange, r.symbol, 60).map((b) => b.close),
								20,
							),
					},
				]),
			);
		},
	},

	alerts: {
		usage: "alerts [list | add <SYMBOL> <condition> <value> [--note text] | remove <ID> | check]",
		summary: `Price/RSI/volume alerts via Telegram or Discord (conditions: ${Object.keys(ALERT_CONDITIONS).join(", ")})`,
		options: { ...exchangeFlag, note: { type: "string" }, all: { type: "boolean", short: "a" } },
		async run(app, args, flags, json) {
			const [action = "list", ...rest] = args;
			if (action === "add") {
				const [symbol, condition, value] = rest;
				if (!symbol || !condition || value === undefined)
					throw new UsageError("Usage: nvest alerts add <SYMBOL> <condition> <value>");
				if (!isAlertCondition(condition))
					throw new UsageError(
						`Unknown condition "${condition}". Use one of: ${Object.keys(ALERT_CONDITIONS).join(", ")}`,
					);
				const t = app.market.resolve(symbol, parseExchange(str(flags.exchange)));
				const alert = app.alerts.add({ ...t, condition, threshold: Number(value), note: str(flags.note) });
				if (json) return alert;
				out(`${c.green("✔")} Alert #${alert.id}: ${t.exchange}:${t.symbol} — ${ALERT_CONDITIONS[condition]} ${value}`);
				if (app.notifier.channels.length === 0)
					out(c.dim("  No delivery channel set; configure TELEGRAM_* or DISCORD_WEBHOOK_URL to get notified."));
				return;
			}
			if (action === "remove") {
				const id = Number(rest[0]);
				if (!app.alerts.remove(id)) throw new UsageError(`No alert with id ${rest[0]}`);
				return json ? { removed: id } : out(`${c.green("✔")} Removed alert #${id}`);
			}
			if (action === "check") {
				const triggered = await app.alerts.check();
				if (json) return triggered;
				if (triggered.length === 0) return out(c.dim("No alerts triggered."));
				for (const t of triggered) out(t.message);
				return;
			}
			if (action !== "list") throw new UsageError(`Unknown alerts action "${action}"`);
			const list = app.alerts.list(!flags.all);
			if (json) return list;
			if (list.length === 0)
				return out(
					`No ${flags.all ? "" : "active "}alerts. Create one with ${c.bold("nvest alerts add GTCO above 100")}.`,
				);
			out(
				table(list, [
					{ header: "ID", value: (a) => c.dim(`#${a.id}`), align: "right" },
					{ header: "Symbol", value: (a) => c.bold(`${a.exchange}:${a.symbol}`) },
					{ header: "Condition", value: (a) => `${a.condition} ${a.threshold}` },
					{
						header: "Status",
						value: (a) =>
							a.triggeredAt ? c.yellow(`triggered ${a.triggeredAt} @ ${a.triggerValue}`) : c.green("active"),
					},
					{ header: "Note", value: (a) => c.dim(a.note ?? "") },
				]),
			);
		},
	},

	ingest: {
		usage: "ingest url <URL> [--depth 2] [--max-pages 50] | ingest file <PATH...> | ingest list",
		summary: "Add research (web pages, PDFs, CSV, Markdown…) to the AI knowledge base",
		options: { depth: { type: "string" }, "max-pages": { type: "string" } },
		async run(app, args, flags, json) {
			const [kind, ...targets] = args;
			if (kind === "list") {
				const sources = app.db.listSources();
				if (json) return sources;
				return out(
					table(sources, [
						{ header: "Kind", value: (s) => c.dim(s.kind) },
						{ header: "Title", value: (s) => (s.title ?? "").slice(0, 50) },
						{ header: "Chunks", value: (s) => String(s.chunks), align: "right" },
						{ header: "Indexed", value: (s) => c.dim(s.indexedAt) },
					]),
				);
			}
			if ((kind !== "url" && kind !== "file") || targets.length === 0)
				throw new UsageError("Usage: nvest ingest url <URL> | ingest file <PATH...>");
			const results = [];
			for (const target of targets) {
				const r =
					kind === "url"
						? await app.kb.ingestUrl(target, {
								maxDepth: num(flags.depth, "depth"),
								maxPages: num(flags["max-pages"], "max-pages"),
							})
						: await app.kb.ingestFile(target);
				results.push({ target, ...r });
				if (!json) {
					const what = "pages" in r ? `${r.pages} pages, ${r.chunks} chunks` : `${r.chunks} chunks`;
					out(`${c.green("✔")} ${target}  ${what} ${c.dim(`· ${r.indexed} embedded, ${r.unchanged} unchanged`)}`);
				}
			}
			return json ? results : undefined;
		},
	},

	search: {
		usage: "search <query...> [--exchange NGX|US] [--limit 8]",
		summary: "Semantic search across ingested documents and market history",
		options: { ...exchangeFlag, limit: { type: "string", short: "n" } },
		async run(app, args, flags, json) {
			const query = args.join(" ").trim();
			if (!query) throw new UsageError("Missing query");
			const exchange = parseExchange(str(flags.exchange));
			const hits = await app.kb.search(query, {
				limit: num(flags.limit, "limit") ?? 8,
				filter: exchange ? { exchange } : undefined,
			});
			if (json) return hits;
			if (hits.length === 0)
				return out(c.dim("No relevant results. Ingest documents with `nvest ingest` or run `nvest sync`."));
			for (const h of hits) {
				out(`${c.bold(h.payload.title)} ${c.dim(`· ${h.payload.kind} · ${(h.score * 100).toFixed(0)}% match`)}`);
				out(`  ${c.cyan(h.payload.source)}`);
				out(`  ${h.payload.content.replace(/\s+/g, " ").slice(0, 220)}…\n`);
			}
		},
	},

	ask: {
		usage: 'ask "<question>" [--exchange NGX|US]',
		summary: "Ask a question; get an answer grounded in your data, with citations",
		options: exchangeFlag,
		async run(app, args, flags, json) {
			const question = args.join(" ").trim();
			if (!question) throw new UsageError('Missing question, e.g. nvest ask "How did banking stocks do today?"');
			const a = await app.insights.ask(question, { exchange: parseExchange(str(flags.exchange)) });
			if (json) return a;
			out(`\n${a.answer.replace(/\[(\d+)\]/g, (m) => c.cyan(m))}\n`);
			if (a.sources.length) {
				out(c.dim("Sources"));
				for (const s of a.sources) out(c.dim(`  [${s.n}] ${s.title} — ${s.source}`));
			}
			out(c.dim(`\n${a.model} · information only, not investment advice`));
		},
	},

	serve: {
		usage: "serve [--port 3000] [--sync-every <minutes>]",
		summary: "Start the web dashboard + REST API",
		options: { port: { type: "string", short: "p" }, "sync-every": { type: "string" } },
		async run(app, _args, flags) {
			const port = num(flags.port, "port") ?? app.config.server.port;
			await startServer(app, { port });
			const every = num(flags["sync-every"], "sync-every");
			if (every) startScheduler(app, every, [...EXCHANGES], {});
			await new Promise(() => undefined);
		},
	},

	doctor: {
		usage: "doctor",
		summary: "Check configuration and connectivity",
		async run(app, _args, _flags, json) {
			const checks = await app.doctor();
			if (json) return checks;
			const icon = { ok: c.green("✔"), warn: c.yellow("!"), off: c.dim("○"), error: c.red("✘") };
			out(heading("nVestPadi doctor", `v${VERSION}`));
			for (const ch of checks) out(`  ${icon[ch.status]} ${c.bold(ch.name.padEnd(15))} ${ch.detail}`);
			out();
			if (checks.some((ch) => ch.status === "error")) process.exitCode = 1;
		},
	},
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function help(name?: string) {
	const cmd = name ? commands[name] : undefined;
	if (cmd) {
		out(`\n${c.bold("Usage:")} nvest ${cmd.usage}\n\n  ${cmd.summary}\n`);
		return;
	}
	out(`
${c.bold(c.cyan("nVestPadi"))} ${c.dim(`v${VERSION}`)} — market intelligence for NGX and US equities

${c.bold("Usage:")} nvest <command> [options]   ${c.dim("(global: --json, --verbose, --help)")}

${Object.entries(commands)
	.map(([n, cmd]) => `  ${c.bold(n.padEnd(10))} ${cmd.summary}`)
	.join("\n")}

${c.bold("Examples:")}
  nvest sync                         ${c.dim("# today's NGX + US prices")}
  nvest market                       ${c.dim("# NGX breadth, movers, sectors")}
  nvest analyze DANGCEM              ${c.dim("# technical report")}
  nvest screen --sector bank --sort active
  nvest alerts add GTCO above 100
  nvest ingest file ./reports/zenith-2025-annual.pdf
  nvest ask "Which NGX banks are oversold?"
  nvest serve --sync-every 30        ${c.dim("# dashboard at http://127.0.0.1:3000")}

Run ${c.bold("nvest help <command>")} for details.
`);
}

async function main() {
	const argv = process.argv.slice(2);
	const name = argv[0];
	if (!name || name === "help" || name === "--help" || name === "-h") return help(argv[1]);
	if (name === "--version" || name === "-v") return out(VERSION);
	const cmd = commands[name];
	if (!cmd) {
		process.exitCode = 2;
		out(`${c.red("Unknown command:")} ${name}\n`);
		return help();
	}

	const { values, positionals } = parseArgs({
		args: argv.slice(1),
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: "boolean" },
			verbose: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			...cmd.options,
		},
	});
	if (values.help) return help(name);

	const config = loadConfig();
	configureLogger({ level: values.verbose ? "debug" : config.logLevel });
	const app = createApp(config);
	onShutdown(() => app.close());

	try {
		const result = await cmd.run(app, positionals, values as Flags, Boolean(values.json));
		if (values.json && result !== undefined) out(JSON.stringify(result, null, 2));
	} finally {
		app.close();
	}
}

main().catch((err) => {
	if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
		process.stderr.write(
			`${c.red("Error:")} ${err.message}\nRun ${c.bold(`nvest help ${process.argv[2] ?? ""}`.trim())} for usage.\n`,
		);
		process.exitCode = 2;
	} else if (
		err instanceof ConfigError ||
		err instanceof FeatureUnavailableError ||
		err instanceof SymbolNotFoundError
	) {
		process.stderr.write(`${c.red("Error:")} ${err.message}\n`);
		process.exitCode = 1;
	} else {
		logger.error(errorMessage(err));
		if (process.env.LOG_LEVEL === "debug" || process.argv.includes("--verbose")) console.error(err);
		process.exitCode = 1;
	}
});
