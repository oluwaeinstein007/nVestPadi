import path from 'path';
import { fileURLToPath } from 'url';

interface DocumentRow {
  id: number;
  chunkId: string | null;
  source: string;
  type: string;
  content: string | null;
  metadata: string;
  ingested_at: string;
}

interface ParsedDocumentRow extends Omit<DocumentRow, 'metadata'> {
  metadata: Record<string, unknown>;
}

export class DatabaseService {
  private db: any = null;
  private dbPath: string;
  private usingInMemory = false;
  private inMemoryStore = new Map<number, DocumentRow>();
  private inMemoryByChunkId = new Map<string, number>();
  private nextInMemoryId = 1;

  constructor(dbName = 'ingestor.db') {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.dbPath = path.join(__dirname, '..', '..', dbName);
  }

  async initialize(): Promise<void> {
    const { createRequire } = await import('module');
    const requireFunc = createRequire(import.meta.url);

    try {
      const BetterSqlite3 = requireFunc('better-sqlite3');
      this.db = new BetterSqlite3(this.dbPath);
    } catch (err: any) {
      console.warn('Could not load better-sqlite3; using in-memory fallback. Reason:', err?.message ?? err);
      this.usingInMemory = true;
      return;
    }

    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chunkId    TEXT UNIQUE,
        source     TEXT NOT NULL,
        type       TEXT NOT NULL,
        content    TEXT,
        metadata   TEXT,
        ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_source ON documents(source);
      CREATE INDEX IF NOT EXISTS idx_type   ON documents(type);
    `);

    console.log(`Database initialized at ${this.dbPath}`);
  }

  /**
   * Upsert a document by chunkId.
   * If a row with the same chunkId already exists, it is updated in-place —
   * preventing duplicate embeddings for the same content.
   */
  async saveDocument(
    source: string,
    type: string,
    content: string | null,
    metadata: Record<string, unknown>,
    chunkId?: string,
  ): Promise<number | null> {
    const metadataJson = JSON.stringify(metadata);

    if (this.usingInMemory) {
      if (chunkId && this.inMemoryByChunkId.has(chunkId)) {
        // Update existing
        const existingId = this.inMemoryByChunkId.get(chunkId)!;
        const row = this.inMemoryStore.get(existingId)!;
        this.inMemoryStore.set(existingId, { ...row, source, type, content, metadata: metadataJson });
        return existingId;
      }
      const id = this.nextInMemoryId++;
      this.inMemoryStore.set(id, {
        id, chunkId: chunkId ?? null, source, type, content, metadata: metadataJson,
        ingested_at: new Date().toISOString(),
      });
      if (chunkId) this.inMemoryByChunkId.set(chunkId, id);
      return id;
    }

    if (!this.db) throw new Error('Database not initialized.');

    try {
      // INSERT OR REPLACE (SQLite upsert via UNIQUE constraint on chunkId)
      const stmt = this.db.prepare(`
        INSERT INTO documents (chunkId, source, type, content, metadata)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chunkId) DO UPDATE SET
          source     = excluded.source,
          type       = excluded.type,
          content    = excluded.content,
          metadata   = excluded.metadata,
          ingested_at = CURRENT_TIMESTAMP
      `);
      const result = stmt.run(chunkId ?? null, source, type, content, metadataJson);
      return result.lastInsertRowid as number;
    } catch (error: any) {
      console.error(`Error saving document: ${error.message}`);
      return null;
    }
  }

  async chunkExists(chunkId: string): Promise<boolean> {
    if (this.usingInMemory) return this.inMemoryByChunkId.has(chunkId);
    if (!this.db) return false;
    const row = this.db.prepare('SELECT id FROM documents WHERE chunkId = ?').get(chunkId);
    return !!row;
  }

  async getDocumentById(id: number): Promise<ParsedDocumentRow | null> {
    if (this.usingInMemory) {
      const row = this.inMemoryStore.get(id);
      if (!row) return null;
      return { ...row, metadata: JSON.parse(row.metadata) };
    }
    if (!this.db) throw new Error('Database not initialized.');
    try {
      const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
      return row ? { ...row, metadata: JSON.parse(row.metadata) } : null;
    } catch (error: any) {
      console.error(`Error getting document ${id}: ${error.message}`);
      return null;
    }
  }

  async getAllDocuments(): Promise<ParsedDocumentRow[]> {
    if (this.usingInMemory) {
      return Array.from(this.inMemoryStore.values()).map(row => ({
        ...row, metadata: JSON.parse(row.metadata),
      }));
    }
    if (!this.db) throw new Error('Database not initialized.');
    try {
      const rows = this.db.prepare('SELECT * FROM documents').all() as DocumentRow[];
      return rows.map(row => ({ ...row, metadata: JSON.parse(row.metadata) }));
    } catch (error: any) {
      console.error(`Error getting all documents: ${error.message}`);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.usingInMemory) {
      this.inMemoryStore.clear();
      this.inMemoryByChunkId.clear();
      this.usingInMemory = false;
      return;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('Database connection closed.');
    }
  }
}
