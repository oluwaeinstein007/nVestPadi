import type { Database } from "../database.js";
import { placeholders, slices, timestamp, valuesList } from "../driver.js";
import { str } from "../rows.js";

export interface IndexedChunk {
	id: string;
	kind: string;
	source: string;
	title: string | null;
	contentHash: string;
}

/** Ledger of chunks embedded into Qdrant, used to skip re-embedding unchanged content. */
export class KnowledgeLedger {
	constructor(private readonly db: Database) {}

	/** Map of id → content hash for the given chunk IDs that are already indexed. */
	async indexedHashes(ids: string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		for (const batch of slices(ids, 500)) {
			const rows = await this.db.all(
				`SELECT id, content_hash FROM indexed_chunks WHERE id IN (${placeholders(batch.length)})`,
				batch,
			);
			for (const r of rows) out.set(String(r.id), String(r.content_hash));
		}
		return out;
	}

	async recordIndexed(chunks: IndexedChunk[]): Promise<void> {
		// A multi-row insert can't contain one id twice; the last occurrence wins.
		const unique = [...new Map(chunks.map((c) => [c.id, c])).values()];
		if (unique.length === 0) return;
		const now = timestamp();
		await this.db.transaction(async () => {
			for (const batch of slices(unique, 200)) {
				await this.db.run(
					`INSERT INTO indexed_chunks (id, kind, source, title, content_hash)
					 VALUES ${valuesList(batch.length, 5)}
					 ON CONFLICT (id) DO UPDATE SET
						content_hash = excluded.content_hash, title = excluded.title, indexed_at = ?`,
					[...batch.flatMap((c) => [c.id, c.kind, c.source, c.title, c.contentHash]), now],
				);
			}
		});
	}

	async listSources(
		limit = 100,
	): Promise<{ source: string; kind: string; title: string | null; chunks: number; indexedAt: string }[]> {
		const rows = await this.db.all(
			`SELECT source, kind, MAX(title) AS title, COUNT(*) AS chunks, MAX(indexed_at) AS last_indexed
			 FROM indexed_chunks WHERE kind != 'quote'
			 GROUP BY source, kind ORDER BY last_indexed DESC LIMIT ?`,
			[limit],
		);
		return rows.map((r) => ({
			source: String(r.source),
			kind: String(r.kind),
			title: str(r.title),
			chunks: Number(r.chunks),
			indexedAt: String(r.last_indexed),
		}));
	}
}
