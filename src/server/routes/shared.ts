import { z } from "zod";
import { EXCHANGES } from "../../markets/types.js";

export const exchangeSchema = z
	.string()
	.transform((s) => s.toUpperCase())
	.pipe(z.enum(EXCHANGES));

export const optionalNumber = z.coerce.number().finite().optional();

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);

/** Query params as an object, with empty values dropped so defaults apply. */
export function queryObject(query: URLSearchParams): Record<string, string> {
	return Object.fromEntries([...query.entries()].filter(([, v]) => v !== ""));
}
