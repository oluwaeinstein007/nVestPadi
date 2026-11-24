/**
 * Knowledge base: embeds text into Qdrant and retrieves it for search and
 * grounded answers. Requires both an AI provider and Qdrant.
 *
 * Idempotent: every chunk has a deterministic ID, and the SQLite ledger stores
 * a content hash, so unchanged chunks are skipped and changed ones re-embedded.
 */
import type { AIProvider } from "../ai/provider.js";
import { parseDocument } from "../ingestion/documentParser.js";
import { TextSplitter } from "../ingestion/textSplitter.js";
import { type CrawlOptions, crawl } from "../ingestion/webCrawler.js";
import { FeatureUnavailableError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { deterministicId, sha256 } from "../lib/util.js";
import type { Quote } from "../markets/types.js";
import type { Database } from "../storage/database.js";
import type { SearchFilter, SearchHit, VectorPayload, VectorPoint, VectorStore } from "../storage/vectorStore.js";

export interface IndexItem {
	id: string;
	text: string;
	payload: Omit<VectorPayload, "content" | "indexedAt">;
}

export interface IndexResult {
	indexed: number;
	unchanged: number;
}

export class KnowledgeBase {
	private readonly splitter = new TextSplitter({ chunkSize: 1200, chunkOverlap: 150 });

	constructor(
		private readonly db: Database,
		private readonly ai: AIProvider | null,
		private readonly vectors: VectorStore | null,
	) {}

	get enabled(): boolean {
		return this.ai !== null && this.vectors !== null;
	}

	private require(feature: string): { ai: AIProvider; vectors: VectorStore } {
		if (this.ai && this.vectors) return { ai: this.ai, vectors: this.vectors };
		const missing = [!this.ai && "AI_PROVIDER + AI_API_KEY", !this.vectors && "QDRANT_URL"].filter(Boolean) as string[];
		throw new FeatureUnavailableError(feature, missing);
	}

	async index(items: IndexItem[]): Promise<IndexResult> {
		const { ai, vectors } = this.require("Indexing");
		if (items.length === 0) return { indexed: 0, unchanged: 0 };

		const existing = await this.db.ledger.indexedHashes(items.map((i) => i.id));
		const changed = items
			.map((item) => ({ item, hash: sha256(item.text) }))
			.filter(({ item, hash }) => existing.get(item.id) !== hash);
		if (changed.length === 0) return { indexed: 0, unchanged: items.length };

		logger.info(`embedding ${changed.length} chunk(s)`, {
			model: ai.embeddingModel,
			unchanged: items.length - changed.length,
		});
		const embeddings = await ai.embed(
			changed.map(({ item }) => item.text),
			"document",
		);
		const indexedAt = new Date().toISOString();
		const points: VectorPoint[] = changed.map(({ item }, i) => ({
			id: item.id,
			vector: embeddings[i] as number[],
			payload: { ...item.payload, content: item.text, indexedAt },
		}));
		await vectors.upsert(points);
		this.db.ledger.recordIndexed(
			changed.map(({ item, hash }) => ({
				id: item.id,
				kind: item.payload.kind,
				source: item.payload.source,
				title: item.payload.title,
				contentHash: hash,
			})),
		);
		return { indexed: changed.length, unchanged: items.length - changed.length };
	}

	async search(
		query: string,
		options: { limit?: number; filter?: SearchFilter; minScore?: number } = {},
	): Promise<SearchHit[]> {
		const { ai, vectors } = this.require("Semantic search");
		const [vector] = await ai.embed([query], "query");
		const hits = await vectors.search(vector as number[], options.limit ?? 8, options.filter);
		// Ignore points without text (e.g. written by older versions) — they can't ground an answer.
		return hits.filter((h) => h.score >= (options.minScore ?? 0.3) && typeof h.payload?.content === "string");
	}

	// ---------------------------------------------------------------------------
	// Sources
	// ---------------------------------------------------------------------------

	async ingestUrl(url: string, options: CrawlOptions = {}): Promise<IndexResult & { pages: number; chunks: number }> {
		this.require("URL ingestion");
		const pages = await crawl(url, options);
		const items = pages.flatMap((page) =>
			this.splitter.split(page.content).map((text, i) => ({
				id: deterministicId(`web:${page.url}:${i}`),
				text: `${page.title}\n\n${text}`,
				payload: { kind: "web" as const, source: page.url, title: page.title, chunkIndex: i },
			})),
		);
		const result = await this.index(items);
		return { ...result, pages: pages.length, chunks: items.length };
	}

	async ingestFile(filePath: string): Promise<IndexResult & { title: string; chunks: number }> {
		this.require("File ingestion");
		const doc = await parseDocument(filePath);
		if (!doc.content) throw new Error(`No extractable text in ${filePath}`);
		const items = this.splitter.split(doc.content).map((text, i) => ({
			id: deterministicId(`file:${doc.path}:${i}`),
			text: `${doc.title}\n\n${text}`,
			payload: { kind: "file" as const, source: doc.path, title: doc.title, chunkIndex: i, format: doc.format },
		}));
		const result = await this.index(items);
		return { ...result, title: doc.title, chunks: items.length };
	}

	/** Daily quote snapshots, so questions like "which banks rallied this week?" can be answered. */
	async indexQuotes(quotes: Quote[]): Promise<IndexResult> {
		if (!this.enabled || quotes.length === 0) return { indexed: 0, unchanged: 0 };
		return this.index(
			quotes.map((q) => ({
				id: deterministicId(`quote:${q.exchange}:${q.symbol}:${q.date}`),
				text: quoteToText(q),
				payload: {
					kind: "quote",
					source: `${q.exchange}:${q.symbol}`,
					title: `${q.name} (${q.symbol}) ${q.date}`,
					exchange: q.exchange,
					symbol: q.symbol,
					date: q.date,
				},
			})),
		);
	}
}

export function quoteToText(q: Quote): string {
	const parts = [
		`${q.name} (${q.exchange}:${q.symbol}) market data for ${q.date}.`,
		q.sector && `Sector: ${q.sector}.`,
		`Close ${q.currency} ${q.close}`,
		q.changePct !== null && `(${q.changePct >= 0 ? "+" : ""}${q.changePct}% on the day)`,
		q.open !== null && `open ${q.open}`,
		q.high !== null && q.low !== null && `range ${q.low}–${q.high}`,
		q.volume !== null && `volume ${q.volume}`,
		q.value !== null && `value traded ${q.currency} ${q.value}`,
		q.trades !== null && `${q.trades} deals`,
	];
	return parts.filter(Boolean).join(", ").replace(/\., /g, ". ");
}
