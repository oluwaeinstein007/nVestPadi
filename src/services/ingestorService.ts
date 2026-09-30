import { createHash } from 'crypto';
import path from 'path';
import { WebCrawler } from './ingestion/webCrawler.js';
import { DocumentParser } from './ingestion/documentParser.js';
import { TextSplitter } from './chunking/textSplitter.js';
import createEmbeddings, { type Embeddings } from '../lib/llm.js';
import { QdrantService, type QdrantPoint } from './storage/qdrantService.js';
import { DatabaseService } from './storage/database.js';

/** Generate a deterministic UUID-shaped ID from a string key. */
function deterministicId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const EMBED_BATCH_SIZE = 100;

export class IngestorService {
  private documentParser: DocumentParser;
  private databaseService: DatabaseService;
  private textSplitter: TextSplitter;
  private embeddings: Embeddings | null = null;
  private qdrantService: QdrantService;
  private isInitialized = false;

  private readonly defaultMaxDepth = 2;
  private readonly defaultRateLimitMs = 500;

  constructor() {
    this.documentParser = new DocumentParser();
    this.databaseService = new DatabaseService();
    this.textSplitter = new TextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    this.qdrantService = new QdrantService();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    await this.databaseService.initialize();
    await this.qdrantService.initialize();

    try {
      this.embeddings = createEmbeddings();
    } catch (err: any) {
      console.warn('Embeddings provider unavailable; zero-vector fallback active. Error:', err?.message ?? err);
      this.embeddings = null;
    }

    this.isInitialized = true;
    console.log('IngestorService initialized.');
  }

  // ---------------------------------------------------------------------------
  // URL ingestion
  // ---------------------------------------------------------------------------

  async ingestUrl(url: string): Promise<string[]> {
    await this.initialize();

    const normalizedUrl = this.normalizeUrl(url);

    const crawler = new WebCrawler({
      maxDepth: this.defaultMaxDepth,
      baseUrl: normalizedUrl,
      rateLimitMs: this.defaultRateLimitMs,
    });

    console.log(`Starting web crawl from: ${normalizedUrl}`);
    const crawledPages = await crawler.start(normalizedUrl);

    // Collect all (chunkId, text, metadata) tuples first so we can batch-embed
    type ChunkJob = { chunkId: string; text: string; payload: Record<string, unknown> };
    const jobs: ChunkJob[] = [];

    for (const [pageUrl, pageData] of crawledPages.entries()) {
      if (!pageData.content) continue;
      const chunks = await this.textSplitter.splitText(pageData.content);

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = deterministicId(`url:${pageUrl}:chunk:${i}`);
        const payload: Record<string, unknown> = {
          ...pageData.metadata,
          source: pageData.title || pageUrl,
          type: 'webpage_chunk',
          originalUrl: pageUrl,
          links: pageData.links,
          chunkIndex: i,
          totalChunks: chunks.length,
        };
        jobs.push({ chunkId, text: chunks[i], payload });
      }
    }

    const ingestedIds = await this.processChunkJobs(jobs, 'url');
    console.log(`Finished crawling and ingesting ${ingestedIds.length} chunks.`);
    return ingestedIds;
  }

  // ---------------------------------------------------------------------------
  // File ingestion
  // ---------------------------------------------------------------------------

  async ingestFile(filePath: string): Promise<string | null> {
    await this.initialize();

    const absoluteFilePath = path.resolve(filePath);
    const parsedDoc = await this.documentParser.parse(absoluteFilePath);
    if (!parsedDoc?.content) return null;

    const chunks = await this.textSplitter.splitText(parsedDoc.content);

    type ChunkJob = { chunkId: string; text: string; payload: Record<string, unknown> };
    const jobs: ChunkJob[] = chunks.map((chunk, i) => ({
      chunkId: deterministicId(`file:${absoluteFilePath}:chunk:${i}`),
      text: chunk,
      payload: {
        ...parsedDoc.metadata,
        type: `${parsedDoc.metadata.type}_chunk`,
        chunkIndex: i,
        totalChunks: chunks.length,
      },
    }));

    const ids = await this.processChunkJobs(jobs, 'file');
    return ids[0] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Shared batch processing
  // ---------------------------------------------------------------------------

  private async processChunkJobs(
    jobs: Array<{ chunkId: string; text: string; payload: Record<string, unknown> }>,
    context: string,
  ): Promise<string[]> {
    if (jobs.length === 0) return [];

    // Filter out already-ingested chunks (idempotency check in SQLite)
    const newJobs: typeof jobs = [];
    for (const job of jobs) {
      const exists = await this.databaseService.chunkExists(job.chunkId);
      if (!exists) newJobs.push(job);
    }

    if (newJobs.length === 0) {
      console.log(`[${context}] All ${jobs.length} chunks already ingested — skipping.`);
      return [];
    }

    console.log(`[${context}] Embedding ${newJobs.length} new chunks (${jobs.length - newJobs.length} skipped as duplicates)...`);

    // Batch embed all texts at once
    const texts = newJobs.map(j => j.text);
    const vectors = await this.batchEmbed(texts);

    // Save to SQLite + collect Qdrant points
    const points: QdrantPoint[] = [];
    const ingestedIds: string[] = [];

    for (let i = 0; i < newJobs.length; i++) {
      const { chunkId, text, payload } = newJobs[i];
      const dbId = await this.databaseService.saveDocument(
        String(payload.source ?? ''),
        String(payload.type ?? 'chunk'),
        text,
        payload,
        chunkId,
      );
      if (dbId !== null) {
        points.push({ id: chunkId, vector: vectors[i], payload });
        ingestedIds.push(chunkId);
      }
    }

    await this.qdrantService.batchUpsert(points);
    return ingestedIds;
  }

  // ---------------------------------------------------------------------------
  // Embedding helper
  // ---------------------------------------------------------------------------

  private async batchEmbed(texts: string[]): Promise<number[][]> {
    const vecSize = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '1536', 10);
    const zeroVec = () => new Array(vecSize).fill(0);

    if (!this.embeddings) {
      return texts.map(zeroVec);
    }

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const vecs = await this.embeddings.embedDocuments(batch);
        results.push(...vecs);
      } catch (err: any) {
        console.warn(`Batch embed failed (batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}); using zero-vectors. Error:`, err?.message ?? err);
        results.push(...batch.map(zeroVec));
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Misc helpers
  // ---------------------------------------------------------------------------

  private normalizeUrl(url: string): string {
    let normalized = (url || '').toString().trim()
      .replace(/^[\"'\uFEFF\u200B\u200C\u200D]+|[\"'\uFEFF\u200B\u200C\u200D]+$/g, '')
      .replace(/\s+/g, '%20');

    const isHttp = (s: string) => {
      try {
        const p = new URL(s);
        return p.protocol === 'http:' || p.protocol === 'https:';
      } catch { return false; }
    };

    if (!isHttp(normalized)) {
      const withScheme = `https://${normalized}`;
      if (isHttp(withScheme)) return withScheme;
      throw new Error(`Invalid URL: ${url}`);
    }
    return normalized;
  }

  async getDocument(id: number): Promise<any | null> {
    await this.initialize();
    return this.databaseService.getDocumentById(id);
  }

  async getAllDocuments(): Promise<any[]> {
    await this.initialize();
    return this.databaseService.getAllDocuments();
  }

  async close(): Promise<void> {
    await this.databaseService.close();
    this.textSplitter.free();
  }
}
