import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

export interface CrawlerOptions {
  maxDepth?: number;
  baseUrl: string;
  rateLimitMs?: number;
  respectRobotsTxt?: boolean;
  maxPages?: number;
}

export interface CrawledPage {
  url: string;
  title: string;
  content: string;
  links: string[];
  metadata: Record<string, unknown>;
}

/**
 * Lightweight recursive web crawler using axios + cheerio.
 * Stays within the same origin as the base URL.
 */
export class WebCrawler {
  private options: Required<CrawlerOptions>;
  private client: AxiosInstance;
  private visited: Set<string> = new Set();

  constructor(options: CrawlerOptions) {
    this.options = {
      maxDepth: options.maxDepth ?? 2,
      baseUrl: options.baseUrl,
      rateLimitMs: options.rateLimitMs ?? 500,
      respectRobotsTxt: options.respectRobotsTxt ?? false,
      maxPages: options.maxPages ?? 50,
    };

    this.client = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': 'nVestPadi-Crawler/1.0 (+https://github.com/nvestpadi)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  }

  async start(startUrl: string): Promise<Map<string, CrawledPage>> {
    this.visited.clear();
    const results = new Map<string, CrawledPage>();
    await this.crawl(startUrl, 0, results);
    return results;
  }

  private async crawl(url: string, depth: number, results: Map<string, CrawledPage>): Promise<void> {
    if (depth > this.options.maxDepth) return;
    if (this.visited.size >= this.options.maxPages) return;
    if (this.visited.has(url)) return;

    const origin = new URL(this.options.baseUrl).origin;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== origin) return;
    } catch {
      return;
    }

    this.visited.add(url);

    try {
      const response = await this.client.get(url);
      const $ = cheerio.load(response.data as string);

      // Extract readable text
      $('script, style, nav, footer, header, aside, noscript').remove();
      const title = $('title').text().trim() || url;
      const content = $('body').text().replace(/\s+/g, ' ').trim();

      // Extract links
      const links: string[] = [];
      $('a[href]').each((_, el) => {
        try {
          const href = new URL($(el).attr('href') as string, url).toString();
          if (href.startsWith(origin)) links.push(href);
        } catch {
          // ignore malformed hrefs
        }
      });

      results.set(url, {
        url,
        title,
        content,
        links,
        metadata: {
          crawledAt: new Date().toISOString(),
          depth,
          statusCode: response.status,
        },
      });

      // Rate limit between requests
      if (this.options.rateLimitMs > 0) {
        await sleep(this.options.rateLimitMs);
      }

      // Recurse into unique child links
      for (const link of [...new Set(links)]) {
        await this.crawl(link, depth + 1, results);
      }
    } catch (err: any) {
      console.warn(`WebCrawler: failed to fetch ${url}: ${err.message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
