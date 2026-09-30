import { QdrantClient } from '@qdrant/js-client-rest';

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

const QDRANT_BATCH_SIZE = 100;

export class QdrantService {
  private client: QdrantClient;
  private collectionName: string;
  private vectorSize: number;
  private enabled: boolean;

  constructor() {
    const enabledFlag = process.env.QDRANT_ENABLED ?? 'true';
    this.enabled = String(enabledFlag).toLowerCase() !== 'false';

    // Both values fully driven by environment variables
    this.collectionName = process.env.QDRANT_COLLECTION_NAME || 'nvestpadi';
    this.vectorSize = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '1536', 10);

    if (!this.enabled) {
      console.log('Qdrant disabled via QDRANT_ENABLED=false.');
      this.client = {} as QdrantClient;
      return;
    }

    const qdrantHost = process.env.QDRANT_HOST;
    const qdrantKey = process.env.QDRANT_KEY;

    if (!qdrantHost) throw new Error('QDRANT_HOST environment variable is not set.');
    if (!qdrantKey) throw new Error('QDRANT_KEY environment variable is not set.');

    this.client = new QdrantClient({ url: qdrantHost, apiKey: qdrantKey });
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;

    try {
      const { collections } = await this.client.getCollections();
      const exists = collections.some(c => c.name === this.collectionName);

      if (!exists) {
        console.log(`Creating Qdrant collection: ${this.collectionName} (dim=${this.vectorSize})`);
        await this.client.createCollection(this.collectionName, {
          vectors: { size: this.vectorSize, distance: 'Cosine' },
        });
        // Create payload indexes for efficient filtering
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'exchange',
          field_schema: 'keyword',
        });
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'stock_symbol',
          field_schema: 'keyword',
        });
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'date',
          field_schema: 'keyword',
        });
        console.log(`Collection '${this.collectionName}' created with indexes.`);
      } else {
        console.log(`Qdrant collection '${this.collectionName}' already exists.`);
      }
    } catch (error: any) {
      console.error('Error initializing Qdrant:', error.message ?? error);
      throw error;
    }
  }

  /**
   * Upsert a single point. Using a deterministic ID makes this idempotent —
   * re-ingesting the same data just overwrites the existing point.
   */
  async upsertPoint(id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    await this.client.upsert(this.collectionName, {
      wait: true,
      points: [{ id, vector, payload }],
    });
  }

  /**
   * Batch upsert — sends points in chunks of QDRANT_BATCH_SIZE to avoid
   * oversized request payloads. Fully idempotent when using deterministic IDs.
   */
  async batchUpsert(points: QdrantPoint[]): Promise<void> {
    if (!this.enabled || points.length === 0) return;

    for (let i = 0; i < points.length; i += QDRANT_BATCH_SIZE) {
      const batch = points.slice(i, i + QDRANT_BATCH_SIZE);
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: batch,
      });
      console.log(`Upserted batch ${Math.floor(i / QDRANT_BATCH_SIZE) + 1}/${Math.ceil(points.length / QDRANT_BATCH_SIZE)} (${batch.length} points)`);
    }
  }

  /** Search for nearest neighbours, optionally filtered by payload fields. */
  async search(queryVector: number[], limit = 5, filter?: Record<string, unknown>): Promise<any[]> {
    if (!this.enabled) return [];
    return this.client.search(this.collectionName, {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: filter as any,
    });
  }

  /** Check whether a point with the given ID already exists. */
  async pointExists(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const result = await this.client.retrieve(this.collectionName, {
        ids: [id],
        with_payload: false,
        with_vector: false,
      });
      return result.length > 0;
    } catch {
      return false;
    }
  }

  get collection(): string {
    return this.collectionName;
  }
}
