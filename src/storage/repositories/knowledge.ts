import type { Database } from "../database.js";

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
	indexedHashes(ids: string[]): Map<string, string> {
		const out = new Map<string, string>();
		const stmt = this.db.prepare("SELECT content_hash FROM indexed_chunks WHERE id = ?");
		for (const id of ids) {
			const row = stmt.get(id) as { content_hash: string } | undefined;
			if (row) out.set(id, row.content_hash);
		}
		return out;
	}

	recordIndexed(chunks: IndexedChunk[]) {
		const stmt = this.db.prepare(`
			INSERT INTO indexed_chunks (id, kind, source, title, content_hash)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				content_hash = excluded.content_hash, title = excluded.title, indexed_at = datetime('now')
		`);
		this.db.transaction(() => {
			for (const c of chunks) stmt.run(c.id, c.kind, c.source, c.title, c.contentHash);
		});
	}

	listSources(
		limit = 100,
	): { source: string; kind: string; title: string | null; chunks: number; indexedAt: string }[] {
		return this.db
			.prepare(`
				SELECT source, kind, MAX(title) AS title, COUNT(*) AS chunks, MAX(indexed_at) AS indexedAt
				FROM indexed_chunks WHERE kind != 'quote'
				GROUP BY source, kind ORDER BY indexedAt DESC LIMIT ?
			`)
			.all(limit) as { source: string; kind: string; title: string | null; chunks: number; indexedAt: string }[];
	}
}
