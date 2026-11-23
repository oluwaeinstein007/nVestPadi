/**
 * US listing metadata from Nasdaq's public stock screener: sector, industry,
 * market cap and listing venue for every NYSE, Nasdaq and NYSE American stock.
 * Yahoo's chart API (used for prices) doesn't provide sectors.
 */
import { getJson } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { toNumber } from "../lib/util.js";

export interface UsListing {
	sector: string | null;
	industry: string | null;
	marketCap: number | null;
	venue: string;
}

/** The screener leaves a few large listings blank. */
const SECTOR_GAPS: Record<string, { sector: string; industry: string }> = {
	"BRK-A": { sector: "Finance", industry: "Diversified insurance & holdings" },
	"BRK-B": { sector: "Finance", industry: "Diversified insurance & holdings" },
};

const EXCHANGES = { nasdaq: "Nasdaq", nyse: "NYSE", amex: "NYSE American" } as const;

interface ScreenerResponse {
	data?: { rows?: { symbol?: string; sector?: string; industry?: string; marketCap?: string }[] | null } | null;
}

/** Nasdaq uses "/" for share classes ("BRK/B"); Yahoo and our DB use "-" ("BRK-B"). */
export function normalizeUsSymbol(symbol: string): string {
	return symbol.trim().toUpperCase().replace(/[/^]/g, "-");
}

/** Symbol → listing metadata. Exchanges that fail are skipped, so a partial map is possible. */
export async function fetchUsListings(): Promise<Map<string, UsListing>> {
	const out = new Map<string, UsListing>();
	for (const [code, venue] of Object.entries(EXCHANGES)) {
		try {
			const data = await getJson<ScreenerResponse>(
				`https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true&exchange=${code}`,
				// The API rejects requests without a browser-like UA and Accept header.
				{ headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, timeoutMs: 30_000, retries: 1 },
			);
			for (const row of data.data?.rows ?? []) {
				if (!row.symbol) continue;
				const symbol = normalizeUsSymbol(row.symbol);
				out.set(symbol, {
					sector: row.sector?.trim() || SECTOR_GAPS[symbol]?.sector || null,
					industry: row.industry?.trim() || SECTOR_GAPS[symbol]?.industry || null,
					marketCap: toNumber(row.marketCap) || null,
					venue,
				});
			}
		} catch (err) {
			logger.warn(`Nasdaq listings for ${venue} unavailable`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return out;
}
