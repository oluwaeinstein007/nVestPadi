/**
 * Regular trading hours, used to decide when to refresh prices quickly and how
 * to label them. Public holidays aren't modelled: on a holiday the market just
 * looks "open" with no new trades.
 *
 * - NGX: Monday–Friday 10:00–14:30 Africa/Lagos (UTC+1, no daylight saving)
 * - US: Monday–Friday 09:30–16:00 America/New_York
 * - Crypto: always
 */
import type { Exchange } from "./types.js";

const SESSIONS: Record<Exclude<Exchange, "CRYPTO">, { tz: string; open: number; close: number }> = {
	NGX: { tz: "Africa/Lagos", open: 10 * 60, close: 14 * 60 + 30 },
	US: { tz: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 },
};

function localTime(now: Date, tz: string): { weekday: string; minutes: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isMarketOpen(exchange: Exchange, now = new Date()): boolean {
	if (exchange === "CRYPTO") return true;
	const s = SESSIONS[exchange];
	const t = localTime(now, s.tz);
	if (t.weekday === "Sat" || t.weekday === "Sun") return false;
	return t.minutes >= s.open && t.minutes < s.close;
}

/** Human description of the session, e.g. "Mon–Fri 10:00–14:30 WAT". */
export const SESSION_LABEL: Record<Exchange, string> = {
	NGX: "Mon–Fri 10:00–14:30 WAT",
	US: "Mon–Fri 9:30–16:00 New York time",
	CRYPTO: "24/7",
};
