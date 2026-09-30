import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import createEmbeddings, { type Embeddings } from '../lib/llm.js';
import { QdrantService, type QdrantPoint } from './storage/qdrantService.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StockQuote {
  stock_symbol: string;
  company_name: string;
  exchange: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  change: number | null;
  price_change_percent: number | null;
  trades: number | null;
  market: string | null;
  sector: string;
  value: number | null;
  technical_indicators: Record<string, unknown> | null;
  sentiment_score: number | null;
  news_summary: string | null;
}

export interface HistoricBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Default US symbols (top 30 S&P 500 by market cap). Override via US_MARKET_SYMBOLS env var.
const DEFAULT_US_SYMBOLS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','BRK-B','LLY','JPM','V',
  'UNH','XOM','TSLA','MA','PG','JNJ','HD','AVGO','MRK','CVX',
  'ABBV','COST','AMD','CRM','NFLX','BAC','PEP','KO','TMO','WMT',
];

const EMBED_BATCH_SIZE = 100;
const QDRANT_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID from a string key — ensures same data → same Qdrant ID. */
function deterministicId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Build a rich text representation for embedding. */
function quoteToText(q: StockQuote): string {
  const parts = [
    `${q.company_name} (${q.stock_symbol}) on ${q.exchange}`,
    `Date: ${q.date}`,
    q.close !== null ? `Close: ${q.close}` : '',
    q.open !== null ? `Open: ${q.open}` : '',
    q.high !== null ? `High: ${q.high}` : '',
    q.low !== null ? `Low: ${q.low}` : '',
    q.volume !== null ? `Volume: ${q.volume}` : '',
    q.change !== null ? `Change: ${q.change}` : '',
    q.price_change_percent !== null ? `Change%: ${q.price_change_percent}%` : '',
    q.sector ? `Sector: ${q.sector}` : '',
    q.market ? `Market: ${q.market}` : '',
  ];
  return parts.filter(Boolean).join('. ');
}

function parseFloatOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MarketIngestorService {
  private qdrantService: QdrantService;
  private client: AxiosInstance;
  private embeddings: Embeddings | null = null;
  private isInitialized = false;

  constructor() {
    this.qdrantService = new QdrantService();
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    await this.qdrantService.initialize();

    try {
      this.embeddings = createEmbeddings();
    } catch (err: any) {
      console.warn('Embeddings unavailable; zero-vector fallback active. Error:', err?.message ?? err);
      this.embeddings = null;
    }

    this.isInitialized = true;
    console.log('MarketIngestorService initialized.');
  }

  // ---------------------------------------------------------------------------
  // NGX — current data
  // ---------------------------------------------------------------------------

  async getNGXQuotes(page = 1): Promise<StockQuote[]> {
    await this.initialize();

    const endpoint = `https://doclib.ngxgroup.com/REST/api/statistics/equities/?market=&sector=&orderby=&pageSize=300&pageNo=${page - 1}`;
    console.log(`Fetching NGX page ${page}...`);

    const response = await this.client.get(endpoint, {
      headers: { Accept: 'application/json' },
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`Unexpected NGX response format on page ${page}`);
    }

    const quotes: StockQuote[] = response.data.map((item: any) => ({
      stock_symbol: item.Symbol || '',
      company_name: item.Company2 || item.Symbol || '',
      exchange: 'NGX',
      date: item.TradeDate || new Date().toISOString().split('T')[0],
      open: parseFloatOrNull(item.OpeningPrice),
      high: parseFloatOrNull(item.HighPrice),
      low: parseFloatOrNull(item.LowPrice),
      close: parseFloatOrNull(item.ClosePrice),
      volume: parseIntOrNull(item.Volume),
      change: parseFloatOrNull(item.Change),
      price_change_percent: parseFloatOrNull(item.CalculateChangePercent),
      trades: parseIntOrNull(item.Trades),
      market: item.Market || null,
      sector: item.Sector || '',
      value: parseFloatOrNull(item.Value),
      technical_indicators: null,
      sentiment_score: null,
      news_summary: null,
    }));

    console.log(`Found ${quotes.length} NGX quotes.`);
    await this.ingestQuotes(quotes);
    return quotes;
  }

  /** Scrape the public NGX page as a fallback (less data). */
  async scrapeNGXPage(page = 1): Promise<StockQuote[]> {
    await this.initialize();

    const url = page === 1
      ? 'https://afx.kwayisi.org/ngx/'
      : `https://afx.kwayisi.org/ngx/?page=${page}`;

    const response = await this.client.get(url);
    const $ = cheerio.load(response.data as string);
    const quotes: StockQuote[] = [];
    const today = new Date().toISOString().split('T')[0];

    $('div.t table').first().find('tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 5) return;
      quotes.push({
        stock_symbol: $(cells[0]).text().trim(),
        company_name: $(cells[1]).text().trim(),
        exchange: 'NGX',
        date: today,
        open: null,
        high: null,
        low: null,
        close: parseFloatOrNull($(cells[3]).text().trim()),
        volume: parseIntOrNull($(cells[2]).text().trim()),
        change: parseFloatOrNull($(cells[4]).text().trim()),
        price_change_percent: null,
        trades: null,
        market: null,
        sector: '',
        value: null,
        technical_indicators: null,
        sentiment_score: null,
        news_summary: null,
      });
    });

    console.log(`Scraped ${quotes.length} NGX quotes from page ${page}.`);
    await this.ingestQuotes(quotes);
    return quotes;
  }

  // ---------------------------------------------------------------------------
  // NGX — historical data
  // ---------------------------------------------------------------------------

  /**
   * Fetch historical end-of-day data for an NGX stock symbol.
   * Uses the afx.kwayisi.org symbol page which provides a historical table.
   */
  async getNGXHistory(symbol: string): Promise<HistoricBar[]> {
    await this.initialize();

    const url = `https://afx.kwayisi.org/ngx/${encodeURIComponent(symbol.toUpperCase())}/`;
    console.log(`Fetching NGX history for ${symbol}...`);

    const response = await this.client.get(url);
    const $ = cheerio.load(response.data as string);
    const bars: HistoricBar[] = [];

    // Historical table: Date | Open | High | Low | Close | Volume
    $('table').each((_, table) => {
      $(table).find('tbody tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 6) return;
        const date = $(cells[0]).text().trim();
        const open = parseFloatOrNull($(cells[1]).text().trim());
        const high = parseFloatOrNull($(cells[2]).text().trim());
        const low = parseFloatOrNull($(cells[3]).text().trim());
        const close = parseFloatOrNull($(cells[4]).text().trim());
        const volume = parseIntOrNull($(cells[5]).text().trim());
        if (date && close !== null) {
          bars.push({ date, open: open ?? 0, high: high ?? 0, low: low ?? 0, close, volume: volume ?? 0 });
        }
      });
    });

    console.log(`Found ${bars.length} historical bars for ${symbol} (NGX).`);
    if (bars.length > 0) await this.ingestHistoricBars(symbol, 'NGX', bars);
    return bars;
  }

  // ---------------------------------------------------------------------------
  // US Market — current data (Yahoo Finance, no API key required)
  // ---------------------------------------------------------------------------

  async getUSQuotes(symbols?: string[]): Promise<StockQuote[]> {
    await this.initialize();

    const targetSymbols = symbols?.length
      ? symbols
      : (process.env.US_MARKET_SYMBOLS || '').split(',').map(s => s.trim()).filter(Boolean);

    const finalSymbols = targetSymbols.length ? targetSymbols : DEFAULT_US_SYMBOLS;
    console.log(`Fetching US quotes for ${finalSymbols.length} symbols...`);

    const quotes: StockQuote[] = [];

    // Yahoo Finance v8 chart endpoint supports individual symbol lookups
    for (const symbol of finalSymbols) {
      try {
        const quote = await this.fetchYahooQuote(symbol);
        if (quote) quotes.push(quote);
      } catch (err: any) {
        console.warn(`Failed to fetch US quote for ${symbol}: ${err.message}`);
      }
    }

    console.log(`Fetched ${quotes.length} US quotes.`);
    await this.ingestQuotes(quotes);
    return quotes;
  }

  private async fetchYahooQuote(symbol: string): Promise<StockQuote | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const response = await this.client.get(url, {
      headers: { Accept: 'application/json' },
    });

    const chart = response.data?.chart?.result?.[0];
    if (!chart) return null;

    const meta = chart.meta ?? {};
    const today = new Date().toISOString().split('T')[0];

    return {
      stock_symbol: meta.symbol || symbol,
      company_name: meta.longName || meta.shortName || symbol,
      exchange: meta.exchangeName || meta.exchange || 'US',
      date: today,
      open: parseFloatOrNull(meta.regularMarketOpen),
      high: parseFloatOrNull(meta.regularMarketDayHigh),
      low: parseFloatOrNull(meta.regularMarketDayLow),
      close: parseFloatOrNull(meta.regularMarketPrice),
      volume: parseIntOrNull(meta.regularMarketVolume),
      change: parseFloatOrNull(meta.regularMarketChange),
      price_change_percent: parseFloatOrNull(meta.regularMarketChangePercent),
      trades: null,
      market: meta.market || null,
      sector: '',
      value: null,
      technical_indicators: null,
      sentiment_score: null,
      news_summary: null,
    };
  }

  // ---------------------------------------------------------------------------
  // US Market — historical data (Yahoo Finance)
  // ---------------------------------------------------------------------------

  async getUSHistory(symbol: string, range = '1y'): Promise<HistoricBar[]> {
    await this.initialize();

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    console.log(`Fetching US history for ${symbol} (range=${range})...`);

    const response = await this.client.get(url, {
      headers: { Accept: 'application/json' },
    });

    const result = response.data?.chart?.result?.[0];
    if (!result) throw new Error(`No chart data for ${symbol}`);

    const timestamps: number[] = result.timestamp ?? [];
    const ohlcv = result.indicators?.quote?.[0] ?? {};
    const opens: number[] = ohlcv.open ?? [];
    const highs: number[] = ohlcv.high ?? [];
    const lows: number[] = ohlcv.low ?? [];
    const closes: number[] = ohlcv.close ?? [];
    const volumes: number[] = ohlcv.volume ?? [];

    const bars: HistoricBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        open: opens[i] ?? 0,
        high: highs[i] ?? 0,
        low: lows[i] ?? 0,
        close: closes[i],
        volume: volumes[i] ?? 0,
      });
    }

    console.log(`Found ${bars.length} historical bars for ${symbol} (US).`);
    if (bars.length > 0) await this.ingestHistoricBars(symbol, result.meta?.exchangeName || 'US', bars);
    return bars;
  }

  // ---------------------------------------------------------------------------
  // Ingestion helpers — batch embed + batch upsert
  // ---------------------------------------------------------------------------

  private async ingestQuotes(quotes: StockQuote[]): Promise<void> {
    if (quotes.length === 0) return;

    const texts = quotes.map(quoteToText);
    const vectors = await this.batchEmbed(texts);

    const points: QdrantPoint[] = quotes.map((q, i) => ({
      // Deterministic ID: same symbol+date+exchange always maps to the same Qdrant point
      id: deterministicId(`quote:${q.exchange}:${q.stock_symbol}:${q.date}`),
      vector: vectors[i],
      payload: q as unknown as Record<string, unknown>,
    }));

    await this.batchUpsert(points);
  }

  private async ingestHistoricBars(symbol: string, exchange: string, bars: HistoricBar[]): Promise<void> {
    if (bars.length === 0) return;

    const texts = bars.map(b =>
      `${symbol} on ${exchange} date ${b.date}: Open ${b.open} High ${b.high} Low ${b.low} Close ${b.close} Volume ${b.volume}`,
    );
    const vectors = await this.batchEmbed(texts);

    const points: QdrantPoint[] = bars.map((b, i) => ({
      id: deterministicId(`history:${exchange}:${symbol}:${b.date}`),
      vector: vectors[i],
      payload: { stock_symbol: symbol, exchange, type: 'historic_bar', ...b } as Record<string, unknown>,
    }));

    await this.batchUpsert(points);
  }

  private async batchEmbed(texts: string[]): Promise<number[][]> {
    const vecSize = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '1536', 10);
    const zeroVec = () => new Array(vecSize).fill(0);

    if (!this.embeddings) return texts.map(zeroVec);

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const vecs = await this.embeddings.embedDocuments(batch);
        results.push(...vecs);
      } catch (err: any) {
        console.warn(`Batch embed failed; using zero-vectors. Error:`, err?.message ?? err);
        results.push(...batch.map(zeroVec));
      }
    }
    return results;
  }

  private async batchUpsert(points: QdrantPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += QDRANT_BATCH_SIZE) {
      const batch = points.slice(i, i + QDRANT_BATCH_SIZE);
      await this.qdrantService.batchUpsert(batch);
    }
  }
}
