/**
 * run_ingest.ts — CLI entry point for market data ingestion.
 *
 * Usage:
 *   pnpm exec tsx scripts/run_ingest.ts [command] [args...]
 *
 * Commands:
 *   ngx                          Fetch current NGX quotes (all NGX_PAGES pages)
 *   ngx-history <SYMBOL>         Fetch NGX historical bars for a symbol (e.g. DANGCEM)
 *   us [SYMBOL...]               Fetch current US quotes (symbols from env or defaults)
 *   us-history <SYMBOL> [range]  Fetch US historical bars (range default: 1y)
 *   url <URL>                    Crawl and ingest a web page
 *   file <PATH>                  Parse and ingest a local file
 */

import fs from 'fs';
import path from 'path';

// Minimal .env loader (no dotenv dependency)
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

import { MarketIngestorService } from '../src/services/marketIngestorService.js';
import { IngestorService } from '../src/services/ingestorService.js';

const [,, command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'ngx': {
      const svc = new MarketIngestorService();
      const pages = parseInt(process.env.NGX_PAGES || '1', 10);
      let total = 0;
      for (let p = 1; p <= pages; p++) {
        const quotes = await svc.getNGXQuotes(p);
        total += quotes.length;
        if (quotes.length === 0) break;
      }
      console.log(`NGX ingestion complete. Total quotes: ${total}`);
      break;
    }

    case 'ngx-history': {
      const symbol = args[0];
      if (!symbol) { console.error('Usage: run_ingest.ts ngx-history <SYMBOL>'); process.exitCode = 1; return; }
      const svc = new MarketIngestorService();
      const bars = await svc.getNGXHistory(symbol);
      console.log(`NGX history for ${symbol}: ${bars.length} bars ingested.`);
      break;
    }

    case 'us': {
      const svc = new MarketIngestorService();
      const symbols = args.length > 0 ? args : undefined;
      const quotes = await svc.getUSQuotes(symbols);
      console.log(`US ingestion complete. Total quotes: ${quotes.length}`);
      break;
    }

    case 'us-history': {
      const symbol = args[0];
      if (!symbol) { console.error('Usage: run_ingest.ts us-history <SYMBOL> [range]'); process.exitCode = 1; return; }
      const range = args[1] || process.env.US_HISTORY_RANGE || '1y';
      const svc = new MarketIngestorService();
      const bars = await svc.getUSHistory(symbol, range);
      console.log(`US history for ${symbol} (${range}): ${bars.length} bars ingested.`);
      break;
    }

    case 'url': {
      const url = args[0];
      if (!url) { console.error('Usage: run_ingest.ts url <URL>'); process.exitCode = 1; return; }
      const svc = new IngestorService();
      const ids = await svc.ingestUrl(url);
      console.log(`URL ingestion complete. Chunks ingested: ${ids.length}`);
      await svc.close();
      break;
    }

    case 'file': {
      const filePath = args[0];
      if (!filePath) { console.error('Usage: run_ingest.ts file <PATH>'); process.exitCode = 1; return; }
      const svc = new IngestorService();
      const id = await svc.ingestFile(filePath);
      console.log(id ? `File ingested. First chunk ID: ${id}` : 'File ingestion returned no data.');
      await svc.close();
      break;
    }

    default: {
      console.log(`
nVestPadi ingestion CLI

Commands:
  ngx                          Ingest current NGX quotes (set NGX_PAGES env for multiple pages)
  ngx-history <SYMBOL>         Ingest NGX historical bars for a symbol
  us [SYMBOL...]               Ingest current US quotes (optional symbol list)
  us-history <SYMBOL> [range]  Ingest US historical bars (range default: 1y)
  url <URL>                    Crawl and ingest a web page
  file <PATH>                  Parse and ingest a local file

Examples:
  pnpm exec tsx scripts/run_ingest.ts ngx
  pnpm exec tsx scripts/run_ingest.ts ngx-history DANGCEM
  pnpm exec tsx scripts/run_ingest.ts us AAPL MSFT TSLA
  pnpm exec tsx scripts/run_ingest.ts us-history AAPL 2y
  pnpm exec tsx scripts/run_ingest.ts url https://example.com
  pnpm exec tsx scripts/run_ingest.ts file ./data/report.csv
      `.trim());
      if (command) { console.error(`\nUnknown command: ${command}`); process.exitCode = 1; }
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
