/**
 * Crypto via CoinGecko's public API (works without a key; set
 * COINGECKO_API_KEY for a free "demo" key's higher rate limit).
 *
 * - Snapshot: the top coins by market cap with price, 24h change and volume.
 * - History: daily closes and volumes for up to a year, fetched on demand.
 * Crypto trades around the clock, so a "session" is a UTC calendar day.
 */
import { getJson } from "../lib/http.js";
import { isoDate, round } from "../lib/util.js";
import { CURRENCY, type MarketSnapshot, type PriceBar, type Security, withChanges } from "./types.js";

const API = "https://api.coingecko.com/api/v3";

interface MarketRow {
	id: string;
	symbol: string;
	name: string;
	current_price: number | null;
	market_cap: number | null;
	total_volume: number | null;
	high_24h: number | null;
	low_24h: number | null;
	price_change_24h: number | null;
	price_change_percentage_24h: number | null;
	last_updated?: string;
}

/** Broad categories for well-known coins; everything else is "Other". */
const CATEGORIES: Record<string, string> = {
	bitcoin: "Bitcoin",
	ethereum: "Smart contracts",
	solana: "Smart contracts",
	cardano: "Smart contracts",
	"avalanche-2": "Smart contracts",
	tron: "Smart contracts",
	polkadot: "Smart contracts",
	near: "Smart contracts",
	sui: "Smart contracts",
	aptos: "Smart contracts",
	"internet-computer": "Smart contracts",
	"hedera-hashgraph": "Smart contracts",
	toncoin: "Smart contracts",
	"the-open-network": "Smart contracts",
	algorand: "Smart contracts",
	cosmos: "Smart contracts",
	stellar: "Payments",
	ripple: "Payments",
	litecoin: "Payments",
	"bitcoin-cash": "Payments",
	monero: "Payments",
	tether: "Stablecoins",
	"usd-coin": "Stablecoins",
	dai: "Stablecoins",
	"ethena-usde": "Stablecoins",
	"first-digital-usd": "Stablecoins",
	usds: "Stablecoins",
	"paypal-usd": "Stablecoins",
	binancecoin: "Exchange tokens",
	"crypto-com-chain": "Exchange tokens",
	okb: "Exchange tokens",
	"leo-token": "Exchange tokens",
	"bitget-token": "Exchange tokens",
	dogecoin: "Meme coins",
	"shiba-inu": "Meme coins",
	pepe: "Meme coins",
	bonk: "Meme coins",
	dogwifcoin: "Meme coins",
	"official-trump": "Meme coins",
	chainlink: "DeFi & infrastructure",
	uniswap: "DeFi & infrastructure",
	aave: "DeFi & infrastructure",
	"lido-dao": "DeFi & infrastructure",
	maker: "DeFi & infrastructure",
	"the-graph": "DeFi & infrastructure",
	"render-token": "DeFi & infrastructure",
	filecoin: "DeFi & infrastructure",
	"matic-network": "Layer 2",
	"polygon-ecosystem-token": "Layer 2",
	arbitrum: "Layer 2",
	optimism: "Layer 2",
	mantle: "Layer 2",
	"wrapped-bitcoin": "Wrapped assets",
	"staked-ether": "Wrapped assets",
	"wrapped-steth": "Wrapped assets",
	weth: "Wrapped assets",
};

export class CoinGecko {
	constructor(private readonly apiKey: string | null = null) {}

	private get headers(): Record<string, string> {
		return this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : {};
	}

	/** Top coins by market cap as today's bar. Duplicate tickers keep the larger coin. */
	async snapshot(limit = 100): Promise<MarketSnapshot> {
		const rows = await getJson<MarketRow[]>(
			`${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&price_change_percentage=24h`,
			{ headers: this.headers, retries: 3 },
		);
		const seen = new Set<string>();
		const securities: Security[] = [];
		const bars: PriceBar[] = [];
		for (const r of rows) {
			const symbol = r.symbol.toUpperCase();
			if (seen.has(symbol) || r.current_price == null) continue;
			seen.add(symbol);
			securities.push(toSecurity(r));
			bars.push({
				exchange: "CRYPTO",
				symbol,
				date: isoDate(r.last_updated ? new Date(r.last_updated) : new Date()),
				open: null,
				high: r.high_24h,
				low: r.low_24h,
				close: r.current_price,
				volume: r.total_volume !== null && r.current_price ? round(r.total_volume / r.current_price, 2) : null,
				change: r.price_change_24h !== null ? round(r.price_change_24h, 8) : null,
				changePct: r.price_change_percentage_24h !== null ? round(r.price_change_percentage_24h, 2) : null,
				trades: null,
				// CoinGecko reports volume in USD — that's traded value.
				value: r.total_volume,
			});
		}
		return { securities, bars };
	}

	/** Daily closes for a coin id (e.g. "bitcoin"), oldest first. */
	async history(coinId: string, symbol: string, days = 365): Promise<PriceBar[]> {
		const data = await getJson<{ prices?: [number, number][]; total_volumes?: [number, number][] }>(
			`${API}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
			{ headers: this.headers, retries: 3 },
		);
		const volumes = new Map((data.total_volumes ?? []).map(([t, v]) => [isoDate(new Date(t)), v]));
		const byDate = new Map<string, PriceBar>();
		for (const [t, close] of data.prices ?? []) {
			const date = isoDate(new Date(t));
			const value = volumes.get(date) ?? null;
			// The last point is "now"; a later point for the same day wins.
			byDate.set(date, {
				exchange: "CRYPTO",
				symbol: symbol.toUpperCase(),
				date,
				open: null,
				high: null,
				low: null,
				close,
				volume: value !== null && close ? round(value / close, 2) : null,
				change: null,
				changePct: null,
				trades: null,
				value,
			});
		}
		return withChanges([...byDate.values()]);
	}

	/** Candles for the last `days` (1 day → 30-minute candles), oldest first. */
	async ohlc(
		coinId: string,
		days: 1 | 7 | 14 | 30 = 1,
	): Promise<{ time: string; open: number; high: number; low: number; close: number; volume: null }[]> {
		const rows = await getJson<[number, number, number, number, number][]>(
			`${API}/coins/${encodeURIComponent(coinId)}/ohlc?vs_currency=usd&days=${days}`,
			{ headers: this.headers, retries: 2 },
		);
		// CoinGecko stamps each candle with its close time; report the start like Yahoo does.
		const step = rows.length > 1 ? (rows[1] as number[])[0] - (rows[0] as number[])[0] : 30 * 60_000;
		return rows.map(([t, open, high, low, close]) => ({
			time: new Date(t - step).toISOString(),
			open,
			high,
			low,
			close,
			volume: null,
		}));
	}

	/** Find a coin id by ticker or name (for coins outside the synced top list). */
	async search(query: string): Promise<Security | null> {
		const data = await getJson<{
			coins?: { id: string; symbol: string; name: string; market_cap_rank: number | null }[];
		}>(`${API}/search?query=${encodeURIComponent(query)}`, { headers: this.headers });
		const upper = query.toUpperCase();
		const coin =
			data.coins?.filter((c) => c.symbol.toUpperCase() === upper).sort(byRank)[0] ??
			data.coins?.filter((c) => c.name.toUpperCase() === upper)[0];
		return coin
			? {
					exchange: "CRYPTO",
					symbol: coin.symbol.toUpperCase(),
					name: coin.name,
					sector: CATEGORIES[coin.id] ?? "Other",
					currency: CURRENCY.CRYPTO,
					venue: "Crypto",
					sourceId: coin.id,
				}
			: null;
	}
}

const byRank = (a: { market_cap_rank: number | null }, b: { market_cap_rank: number | null }) =>
	(a.market_cap_rank ?? Number.POSITIVE_INFINITY) - (b.market_cap_rank ?? Number.POSITIVE_INFINITY);

function toSecurity(r: MarketRow): Security {
	return {
		exchange: "CRYPTO",
		symbol: r.symbol.toUpperCase(),
		name: r.name,
		sector: CATEGORIES[r.id] ?? "Other",
		currency: CURRENCY.CRYPTO,
		venue: "Crypto",
		marketCap: r.market_cap,
		sourceId: r.id,
	};
}
