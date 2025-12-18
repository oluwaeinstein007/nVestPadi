import fs from 'fs';
import path from 'path';

// Simple .env loader (so we don't add dotenv as a dependency here)
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // remove surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Only set env var if not already provided in the environment
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = val;
    }
  }
}

// This script is a small test runner that calls the MarketIngestorService.scrapeNGXPage
import { MarketIngestorService } from '../src/services/marketIngestorService';

// Usage: pnpm exec tsx scripts/run_ingest.ts [page]
const pageArg = process.argv[2];
const page = pageArg ? (parseInt(pageArg, 10) || 1) : 1;

async function run() {
  try {
    console.log(`🔎 Scraping NGX page ${page}...`);

    const svc = new MarketIngestorService();

    // The method is marked `private` in TypeScript, but at runtime we can access it via bracket notation.
    let companies;
    if (typeof svc.getNGXPage === 'function') {
      // Some transpiled outputs may still expose the method directly
      companies = await svc.getNGXPage(page);
    } else if (typeof svc['getNGXPage'] === 'function') {
      companies = await (svc['getNGXPage'] as (page: number) => Promise<any>)(page);
    } else {
      throw new Error('getNGXPage method not found on MarketIngestorService');
    }

    console.log(`✅ Found ${companies.length} companies on page ${page}`);

    if (companies.length > 0) {
      console.log('\nSample results (first 10):');
      console.log(JSON.stringify(companies.slice(0, 10), null, 2));
    }

    // Exit cleanly
    process.exitCode = 0;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('Error scraping NGX page:', errorMessage);
    process.exitCode = 1;
  }
}

run();
