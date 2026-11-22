/**
 * Minimal leveled logger. Writes to stderr so stdout stays clean for command
 * output (e.g. `nvest market --json | jq`). Human-readable on a TTY, JSON
 * lines otherwise (containers, log shippers).
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const TAGS: Record<Level, string> = {
	debug: "\x1b[90mdebug\x1b[0m",
	info: "\x1b[36minfo \x1b[0m",
	warn: "\x1b[33mwarn \x1b[0m",
	error: "\x1b[31merror\x1b[0m",
};

let threshold = LEVELS.info;
let pretty = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

export function configureLogger(options: { level?: Level; pretty?: boolean }) {
	if (options.level) threshold = LEVELS[options.level];
	if (options.pretty !== undefined) pretty = options.pretty;
}

function write(level: Level, message: string, fields?: Record<string, unknown>) {
	if (LEVELS[level] < threshold) return;
	if (pretty) {
		const extra =
			fields && Object.keys(fields).length > 0
				? ` \x1b[90m${Object.entries(fields)
						.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
						.join(" ")}\x1b[0m`
				: "";
		process.stderr.write(`${TAGS[level]} ${message}${extra}\n`);
	} else {
		process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
	}
}

export const logger = {
	debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
	error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
