import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { randomUUID } from 'crypto';
import puppeteer from 'puppeteer';
import createEmbeddings from '../lib/llm.js';
import { QdrantService } from './storage/qdrantService.js';


interface Company {
    stock_symbol: string;
    date: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    technical_indicators: any | null;
    sentiment_score: number | null;
    news_summary: string | null;
    company_name: string;
    exchange: string;
    change: number | null;
    price_change_percent: number | null;
    trades: number | null;
    market: string | null;
    sector: string | '';
    value: number | null;
}

export class MarketIngestorService {
    // QdrantService is lazily instantiated when needed to avoid pulling in heavy deps
    private qdrantService: QdrantService | null;
    private client: AxiosInstance;
    private embeddings: any | null = null;
    private isInitialized: boolean = false;

    constructor() {
        // Defer creating QdrantService until it's actually needed by a method that uses Qdrant
        this.qdrantService = null;
        this.client = axios.create({
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        });
    }
    


     // Initialize the service, including the database and Qdrant collection
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return; // Already initialized
    }

    // Lazily create QdrantService to avoid pulling in heavy deps unnecessarily
    if (!this.qdrantService) {
      this.qdrantService = new QdrantService();
    }

    await this.qdrantService.initialize(); // Initialize Qdrant
    this.isInitialized = true;
    console.log('IngestorService initialized.');
  }


  /**
   * Scrape NGX listed companies from a single page
   */
 async scrapeNGXPage(page: number): Promise<Company[]> {
    try {
      const url = page === 1 
        ? 'https://afx.kwayisi.org/ngx/' 
        : `https://afx.kwayisi.org/ngx/?page=${page}`;

      const response = await this.client.get(url);
      const $ = cheerio.load(response.data);
      const table = $('div.t table').first();
      const companies: Company[] = [];

      table.find('tbody tr').each((index, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 5) {
          companies.push({
            stock_symbol: $(cells[0]).text().trim(),
            company_name: $(cells[1]).text().trim(),
            volume: parseInt($(cells[2]).text().trim()) || null,
            close: parseFloat($(cells[3]).text().trim()) || null,
            change: parseFloat($(cells[4]).text().trim()) || null,
            date: new Date().toISOString(),
            open: null,
            high: null,
            low: null,
            technical_indicators: null,
            sentiment_score: null,
            news_summary: null,
            exchange: 'NGX',
            price_change_percent: null,
            trades: null,
            market: null,
            sector: '',
            value: null,
          });
        }
      });

      return companies;
    } catch (error) {
      console.error(`Error scraping page ${page}:`, error);
      throw error;
    }
  }

  

async getNGXPage(page: number): Promise<Company[]> {
    try {
        // The NGX data comes from their REST API
        const endpoint = `https://doclib.ngxgroup.com/REST/api/statistics/equities/?market=&sector=&orderby=&pageSize=300&pageNo=${page - 1}`;
        
        console.log('Fetching from endpoint:', endpoint);
        
        const response = await this.client.get(endpoint, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        });
        
        console.log('Response status:', response.status);
        
        const companies: Company[] = [];
        
        if (response.data && Array.isArray(response.data)) {
            for (const item of response.data) {
                companies.push({
                    stock_symbol: item.Symbol || '',
                    date: item.TradeDate || new Date().toISOString(),
                    open: item.OpeningPrice !== null && item.OpeningPrice !== undefined ? parseFloat(item.OpeningPrice) : null,
                    high: item.HighPrice !== null && item.HighPrice !== undefined ? parseFloat(item.HighPrice) : null,
                    low: item.LowPrice !== null && item.LowPrice !== undefined ? parseFloat(item.LowPrice) : null,
                    close: item.ClosePrice !== null && item.ClosePrice !== undefined ? parseFloat(item.ClosePrice) : null,
                    volume: item.Volume !== null && item.Volume !== undefined ? parseInt(item.Volume) : null,
                    technical_indicators: null,
                    sentiment_score: null,
                    news_summary: null,
                    company_name: item.Company2 || item.Symbol || '',
                    exchange: 'NGX',
                    change: item.Change !== null && item.Change !== undefined ? parseFloat(item.Change) : null,
                    price_change_percent: item.CalculateChangePercent !== null && item.CalculateChangePercent !== undefined ? parseFloat(item.CalculateChangePercent) : null,
                    trades: item.Trades !== null && item.Trades !== undefined ? parseInt(item.Trades) : null,
                    market: item.Market || '',
                    sector: item.Sector || '',
                    value: item.Value !== null && item.Value !== undefined ? parseFloat(item.Value) : null,
                });
            }
        }
        
        console.log(`Found ${companies.length} companies`);

        // Initialize Qdrant and embeddings lazily
        await this.initialize();

        if (!this.embeddings) {
          try {
            this.embeddings = createEmbeddings();
          } catch (err) {
            console.warn('Embeddings provider not available; continuing with zero-vector fallback:', err?.message ?? err);
            this.embeddings = null;
          }
        }

        // Compute per-company embeddings (preferred) or fall back to zero vectors
        let embeddingsArray: number[][];
        if (this.embeddings) {
          try {
            const texts = companies.map((c) => `${c.stock_symbol} ${c.company_name} ${c.close ?? ''}`);
            // Prefer batch embedding for efficiency
            embeddingsArray = await this.embeddings.embedDocuments(texts);
          } catch (err) {
            console.warn('Batch embeddings failed; using zero-vectors:', err?.message ?? err);
            const vecSize = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '1536', 10);
            const zero = new Array(vecSize).fill(0);
            embeddingsArray = companies.map(() => Array.from(zero));
          }
        } else {
          const vecSize = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '1536', 10);
          const zero = new Array(vecSize).fill(0);
          embeddingsArray = companies.map(() => Array.from(zero));
        }

        // Add each company as its own chunk to Qdrant for finer granularity
        for (let i = 0; i < companies.length; i++) {
          const company = companies[i];
          const embeddingVec = embeddingsArray[i];
          const chunkId = randomUUID();
          try {
            await this.qdrantService!.addChunk(chunkId, embeddingVec, [company]);
          } catch (err) {
            console.error('Failed to add company chunk to Qdrant:', company.stock_symbol, err?.message ?? err);
          }
        }

        return companies;
    } catch (error) {
        console.error(`Error scraping page ${page}:`, error);
        if (error instanceof Error && 'response' in error) {
            console.error('Error response:', (error as any).response.status, (error as any).response.data);
        }
        throw error;
    }
}


}
