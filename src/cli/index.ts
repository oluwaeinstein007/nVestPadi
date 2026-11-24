#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * nvest — command-line interface for nVestPadi.
 * Run `nvest help` (or `pnpm nvest help` from a checkout) for usage.
 */
import { parseArgs } from "node:util";
import { createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { configureLogger, errorMessage, logger } from "../lib/logger.js";
import { onShutdown } from "../lib/shutdown.js";
import { VERSION } from "../version.js";
import { type Command, type Flags, UsageError, out } from "./command.js";
import { marketCommands } from "./commands/market.js";
import { portfolioCommands } from "./commands/portfolio.js";
import { researchCommands } from "./commands/research.js";
import { systemCommands } from "./commands/system.js";
import { c } from "./format.js";

const commands: Record<string, Command> = {
	...marketCommands,
	...portfolioCommands,
	...researchCommands,
	...systemCommands,
};

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
  nvest users create you@example.com ${c.dim("# owner account for the web app")}
  nvest serve --sync-every 30        ${c.dim("# web app at http://127.0.0.1:3000")}

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
	const app = await createApp(config);
	onShutdown(() => app.close());

	try {
		const result = await cmd.run(app, positionals, values as Flags, Boolean(values.json));
		if (values.json && result !== undefined) out(JSON.stringify(result, null, 2));
	} finally {
		await app.close();
	}
}

main().catch((err) => {
	if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
		process.stderr.write(
			`${c.red("Error:")} ${err.message}\nRun ${c.bold(`nvest help ${process.argv[2] ?? ""}`.trim())} for usage.\n`,
		);
		process.exitCode = 2;
	} else if (err instanceof ConfigError || err instanceof AppError) {
		process.stderr.write(`${c.red("Error:")} ${err.message}\n`);
		process.exitCode = 1;
	} else {
		logger.error(errorMessage(err));
		if (process.env.LOG_LEVEL === "debug" || process.argv.includes("--verbose")) console.error(err);
		process.exitCode = 1;
	}
});
