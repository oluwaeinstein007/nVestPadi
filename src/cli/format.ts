/** Terminal output helpers: colour (TTY-aware), tables, numbers, sparklines. */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
	bold: wrap(1, 22),
	dim: wrap(2, 22),
	red: wrap(31, 39),
	green: wrap(32, 39),
	yellow: wrap(33, 39),
	cyan: wrap(36, 39),
	gray: wrap(90, 39),
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => s.replace(ANSI, "").length;

export function compact(n: number | null | undefined, digits = 1): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "—";
	const abs = Math.abs(n);
	for (const [v, s] of [
		[1e12, "T"],
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	] as const) {
		if (abs >= v) return `${(n / v).toFixed(digits)}${s}`;
	}
	return n.toFixed(abs < 10 && n % 1 !== 0 ? 2 : 0);
}

export function price(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
}

/** Signed, coloured percentage: +2.31% (green) / -1.05% (red). */
export function pct(n: number | null | undefined, colour = true): string {
	if (n === null || n === undefined) return c.gray("—");
	const s = `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
	if (!colour || n === 0) return s;
	return n > 0 ? c.green(s) : c.red(s);
}

const SPARKS = "▁▂▃▄▅▆▇█";
export function sparkline(values: number[], width = 30): string {
	if (values.length < 2) return "";
	const step = Math.max(1, Math.floor(values.length / width));
	const sampled = values.filter((_, i) => i % step === 0 || i === values.length - 1).slice(-width);
	const min = Math.min(...sampled);
	const max = Math.max(...sampled);
	const line = sampled.map((v) => SPARKS[max === min ? 3 : Math.round(((v - min) / (max - min)) * 7)]).join("");
	const up = (sampled.at(-1) as number) >= (sampled[0] as number);
	return up ? c.green(line) : c.red(line);
}

export interface Column<T> {
	header: string;
	value: (row: T) => string;
	align?: "left" | "right";
}

export function table<T>(rows: T[], columns: Column<T>[]): string {
	if (rows.length === 0) return c.dim("  (no rows)");
	const cells = rows.map((r) => columns.map((col) => col.value(r)));
	const widths = columns.map((col, i) =>
		Math.max(col.header.length, ...cells.map((row) => visibleLength(row[i] as string))),
	);
	const pad = (s: string, i: number) => {
		const gap = " ".repeat((widths[i] as number) - visibleLength(s));
		return columns[i]?.align === "right" ? gap + s : s + gap;
	};
	const header = columns.map((col, i) => c.bold(pad(col.header, i))).join("  ");
	const rule = c.dim(widths.map((w) => "─".repeat(w)).join("  "));
	return [header, rule, ...cells.map((row) => row.map(pad).join("  "))].map((l) => `  ${l}`).join("\n");
}

export function heading(text: string, sub?: string): string {
	return `\n${c.bold(c.cyan(text))}${sub ? `  ${c.dim(sub)}` : ""}\n`;
}

export function kv(pairs: [string, string][]): string {
	const width = Math.max(...pairs.map(([k]) => k.length));
	return pairs.map(([k, v]) => `  ${c.dim(k.padEnd(width))}  ${v}`).join("\n");
}

export function signalBadge(signal: "BUY" | "SELL" | "HOLD", strength: string): string {
	const text = ` ${strength.toUpperCase()} ${signal} `;
	if (!useColor) return `[${text.trim()}]`;
	const bg = signal === "BUY" ? 42 : signal === "SELL" ? 41 : 43;
	return `\x1b[${bg};30m${text}\x1b[0m`;
}
