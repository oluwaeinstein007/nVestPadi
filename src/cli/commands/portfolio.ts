/** Per-account commands: watchlist and alerts (act as `--user <email>` or the owner). */
import { parseExchange } from "../../markets/types.js";
import { ALERT_CONDITIONS, isAlertCondition } from "../../services/alertService.js";
import { type Command, UsageError, cliUser, exchangeFlag, out, str, userFlag } from "../command.js";
import { c, pct, price, sparkline, table } from "../format.js";

export const portfolioCommands: Record<string, Command> = {
	watchlist: {
		usage: "watchlist [list | add <SYMBOL...> | remove <SYMBOL...>] [--exchange NGX|US] [--user email]",
		summary: "Track the stocks you care about",
		options: { ...exchangeFlag, ...userFlag },
		async run(app, args, flags, json) {
			const user = cliUser(app, flags);
			const [action = "list", ...symbols] = args;
			const exchange = parseExchange(str(flags.exchange));
			if (action === "add" || action === "remove") {
				if (symbols.length === 0) throw new UsageError(`watchlist ${action} needs at least one SYMBOL`);
				for (const s of symbols) {
					const t =
						action === "add" ? await app.watchlists.add(user, s, exchange) : app.watchlists.remove(user, s, exchange);
					if (!json) out(`${c.green("✔")} ${action === "add" ? "Added" : "Removed"} ${t.exchange}:${t.symbol}`);
				}
				return json ? app.db.watchlist.list(user.id) : undefined;
			}
			if (action !== "list") throw new UsageError(`Unknown watchlist action "${action}"`);
			const rows = app.watchlists.list(user);
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
					{ header: "Trend", value: (r) => sparkline(r.spark, 20) },
				]),
			);
		},
	},

	alerts: {
		usage:
			"alerts [list [--all] | add <SYMBOL> <condition> <value> [--note text] | remove <ID> | rearm <ID> | check] [--user email]",
		summary: `Price/RSI/volume alerts (conditions: ${Object.keys(ALERT_CONDITIONS).join(", ")})`,
		options: { ...exchangeFlag, ...userFlag, note: { type: "string" }, all: { type: "boolean", short: "a" } },
		async run(app, args, flags, json) {
			const [action = "list", ...rest] = args;
			if (action === "check") {
				// Server-wide: evaluates every account's alerts and delivers them.
				const triggered = await app.alerts.check();
				if (json) return triggered;
				if (triggered.length === 0) return out(c.dim("No alerts triggered."));
				for (const t of triggered) out(t.message);
				return;
			}
			const user = cliUser(app, flags);
			if (action === "add") {
				const [symbol, condition, value] = rest;
				if (!symbol || !condition || value === undefined)
					throw new UsageError("Usage: nvest alerts add <SYMBOL> <condition> <value>");
				if (!isAlertCondition(condition))
					throw new UsageError(
						`Unknown condition "${condition}". Use one of: ${Object.keys(ALERT_CONDITIONS).join(", ")}`,
					);
				const t = app.market.resolve(symbol, parseExchange(str(flags.exchange)));
				const alert = app.alerts.add(user, { ...t, condition, threshold: Number(value), note: str(flags.note) });
				if (json) return alert;
				out(`${c.green("✔")} Alert #${alert.id}: ${t.exchange}:${t.symbol} — ${ALERT_CONDITIONS[condition]} ${value}`);
				if (app.notifier.channelsFor(user).length === 0)
					out(c.dim(`  No delivery channel active; set one up at ${app.config.appUrl}/app/settings#notifications.`));
				return;
			}
			if (action === "remove" || action === "rearm") {
				const id = Number(rest[0]);
				if (action === "rearm") {
					const alert = app.alerts.rearm(user, id);
					return json ? alert : out(`${c.green("✔")} Re-armed alert #${id}`);
				}
				if (!app.alerts.remove(user, id)) throw new UsageError(`No alert with id ${rest[0]}`);
				return json ? { removed: id } : out(`${c.green("✔")} Removed alert #${id}`);
			}
			if (action !== "list") throw new UsageError(`Unknown alerts action "${action}"`);
			const list = app.alerts.list(user, !flags.all);
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
};
