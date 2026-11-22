/**
 * Qdrant vector store. The collection is created lazily on first write, sized
 * from the actual embedding length — no vector-size setting to keep in sync.
 * If an existing collection has a different size, writes fail with a clear
 * message instead of silently corrupting the index.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import type { QdrantConfig } from "../config.js";
import { logger } from "../lib/logger.js";
import { chunk } from "../lib/util.js";

// A type alias (not interface) so it is assignable to Qdrant's Record<string, unknown> payload.
export type VectorPayload = {
	kind: "quote" | "web" | "file";
	source: string;
	title: string;
	content: string;
	exchange?: string;
	symbol?: string;
	date?: string;
	chunkIndex?: number;
	format?: string;
	indexedAt: string;
};

export interface VectorPoint {
	id: string;
	vector: number[];
	payload: VectorPayload;
}

export interface SearchFilter {
	kind?: VectorPayload["kind"];
	exchange?: string;
	symbol?: string;
}

export interface SearchHit {
	id: string;
	score: number;
	payload: VectorPayload;
}

const INDEXED_FIELDS = ["kind", "exchange", "symbol", "source"] as const;

export class VectorStore {
	private readonly client: QdrantClient;
	private readonly collection: string;
	private dimension: number | null = null;

	constructor(config: QdrantConfig) {
		this.client = new QdrantClient({ url: config.url, apiKey: config.apiKey, checkCompatibility: false });
		this.collection = config.collection;
	}

	get collectionName() {
		return this.collection;
	}

	/** Returns the collection's vector size, or null if it doesn't exist yet. */
	async describe(): Promise<{ dimension: number; points: number } | null> {
		const { exists } = await this.client.collectionExists(this.collection);
		if (!exists) return null;
		const info = await this.client.getCollection(this.collection);
		const vectors = info.config.params.vectors;
		const size = vectors && "size" in vectors ? Number(vectors.size) : Number.NaN;
		return { dimension: size, points: info.points_count ?? 0 };
	}

	private async ensureCollection(dimension: number) {
		if (this.dimension === dimension) return;
		const existing = await this.describe();
		if (!existing) {
			logger.info("creating Qdrant collection", { collection: this.collection, dimension });
			await this.client.createCollection(this.collection, {
				vectors: { size: dimension, distance: "Cosine" },
			});
			for (const field of INDEXED_FIELDS) {
				await this.client.createPayloadIndex(this.collection, { field_name: field, field_schema: "keyword" });
			}
		} else if (existing.dimension !== dimension) {
			throw new Error(
				`Qdrant collection "${this.collection}" stores ${existing.dimension}-dim vectors but the embedding model produced ${dimension}. Set QDRANT_COLLECTION to a new name, or set AI_EMBEDDING_DIMENSIONS to match the existing collection.`,
			);
		}
		this.dimension = dimension;
	}

	async upsert(points: VectorPoint[]) {
		if (points.length === 0) return;
		await this.ensureCollection((points[0] as VectorPoint).vector.length);
		for (const batch of chunk(points, 100)) {
			await this.client.upsert(this.collection, { wait: true, points: batch });
		}
	}

	async search(vector: number[], limit: number, filter: SearchFilter = {}): Promise<SearchHit[]> {
		const must = Object.entries(filter)
			.filter(([, v]) => v !== undefined)
			.map(([key, value]) => ({ key, match: { value: value as string } }));
		try {
			const hits = await this.client.search(this.collection, {
				vector,
				limit,
				with_payload: true,
				...(must.length > 0 && { filter: { must } }),
			});
			return hits.map((h) => ({ id: String(h.id), score: h.score, payload: h.payload as unknown as VectorPayload }));
		} catch (err) {
			// Searching before anything was indexed is not an error from the user's point of view.
			if ((err as { status?: number }).status === 404) return [];
			throw err;
		}
	}
}
