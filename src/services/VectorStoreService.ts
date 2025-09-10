import { Pinecone } from '@pinecone-database/pinecone';
import { Vector, QueryResult, VectorStoreError, OpenRAGConfig } from '../types/index.js';

export class VectorStoreService {
  private pinecone: Pinecone;
  private indexName: string;
  private batchSize: number;

  constructor(config: OpenRAGConfig) {
    this.pinecone = new Pinecone({
      apiKey: config.pinecone.apiKey
    });
    this.indexName = config.pinecone.indexName || 'scout-index';
    this.batchSize = config.processing?.batchSize || 100;
  }

  /**
   * Initialize the Pinecone index if it doesn't exist
   */
  async initialize(): Promise<void> {
    try {
      // Check if index exists
      const existingIndexes = await this.pinecone.listIndexes();
      const indexExists = existingIndexes.indexes?.some(idx => idx.name === this.indexName);

      if (!indexExists) {
        // Create index with 1536 dimensions for text-embedding-3-small
        await this.pinecone.createIndex({
          name: this.indexName,
          dimension: 1536,
          metric: 'cosine',
          spec: {
            serverless: {
              cloud: 'aws',
              region: 'us-east-1'
            }
          }
        });

        // Wait for index to be ready
        await this.waitForIndexReady();
      }
    } catch (error) {
      throw new VectorStoreError(
        `Failed to initialize Pinecone index: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { indexName: this.indexName, error }
      );
    }
  }

  /**
   * Wait for index to be ready for operations
   */
  private async waitForIndexReady(maxWaitTime = 60000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const indexStats = await this.pinecone.index(this.indexName).describeIndexStats();
        if (indexStats) {
          return; // Index is ready
        }
      } catch (error) {
        // Continue waiting
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new VectorStoreError('Index failed to become ready within timeout period');
  }

  /**
   * Upsert vectors to Pinecone in batches with retry logic
   */
  async upsertVectors(vectors: Vector[]): Promise<void> {
    if (vectors.length === 0) return;

    const index = this.pinecone.index(this.indexName);
    const batches = this.createBatches(vectors, this.batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          await index.upsert(batch);
          console.log(`Upserted batch ${i + 1}/${batches.length} (${batch.length} vectors)`);
          break; // Success
        } catch (error) {
          retryCount++;
          
          if (retryCount >= maxRetries) {
            throw new VectorStoreError(
              `Failed to upsert batch ${i + 1} after ${maxRetries} retries: ${error instanceof Error ? error.message : 'Unknown error'}`,
              { batchIndex: i, batchSize: batch.length, error }
            );
          }

          // Exponential backoff
          const delay = Math.pow(2, retryCount) * 1000;
          console.warn(`Batch ${i + 1} failed, retrying in ${delay}ms... (attempt ${retryCount}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  /**
   * Query vectors using similarity search
   */
  async queryVectors(
    vector: number[],
    options: {
      topK?: number;
      filter?: Record<string, any>;
      threshold?: number;
      includeMetadata?: boolean;
    } = {}
  ): Promise<QueryResult[]> {
    const {
      topK = 10,
      filter,
      threshold = 0.7,
      includeMetadata = true
    } = options;

    try {
      const index = this.pinecone.index(this.indexName);
      
      const queryResponse = await index.query({
        vector,
        topK,
        filter,
        includeMetadata
      });

      const results: QueryResult[] = [];
      
      if (queryResponse.matches) {
        for (const match of queryResponse.matches) {
          if (match.score && match.score >= threshold) {
            results.push({
              id: match.id,
              score: match.score,
              metadata: match.metadata as Vector['metadata']
            });
          }
        }
      }

      return results.sort((a, b) => b.score - a.score);
    } catch (error) {
      throw new VectorStoreError(
        `Failed to query vectors: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { topK, filter, threshold, error }
      );
    }
  }

  /**
   * Delete vectors by IDs
   */
  async deleteVectors(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    try {
      const index = this.pinecone.index(this.indexName);
      const batches = this.createBatches(ids, this.batchSize);

      for (const batch of batches) {
        await index.deleteMany(batch);
      }
    } catch (error) {
      throw new VectorStoreError(
        `Failed to delete vectors: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { ids, error }
      );
    }
  }

  /**
   * Delete all vectors matching a filter (e.g., by sourceUrl)
   */
  async deleteByFilter(filter: Record<string, any>): Promise<void> {
    try {
      const index = this.pinecone.index(this.indexName);
      await index.deleteMany(filter);
    } catch (error) {
      throw new VectorStoreError(
        `Failed to delete vectors by filter: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { filter, error }
      );
    }
  }

  /**
   * Get index statistics
   */
  async getIndexStats(): Promise<{
    totalVectors: number;
    dimension: number;
    indexFullness: number;
  }> {
    try {
      const index = this.pinecone.index(this.indexName);
      const stats = await index.describeIndexStats();
      
      return {
        totalVectors: stats.totalRecordCount || 0,
        dimension: stats.dimension || 0,
        indexFullness: stats.indexFullness || 0
      };
    } catch (error) {
      throw new VectorStoreError(
        `Failed to get index stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { indexName: this.indexName, error }
      );
    }
  }

  /**
   * List all unique source URLs in the index
   */
  async listSources(): Promise<string[]> {
    try {
      // Since Pinecone doesn't support listing all vectors directly,
      // we'll need to maintain a separate tracking mechanism
      // For now, return an empty array - this would need to be implemented
      // with a separate metadata store or by querying with broad filters
      console.warn('listSources() not fully implemented - requires metadata tracking');
      return [];
    } catch (error) {
      throw new VectorStoreError(
        `Failed to list sources: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error }
      );
    }
  }

  /**
   * Create batches from an array
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    
    return batches;
  }

  /**
   * Generate a unique vector ID based on content
   */
  static async generateVectorId(sourceUrl: string, chunkHash: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256')
      .update(`${sourceUrl}:${chunkHash}`)
      .digest('hex');
  }

  /**
   * Health check for the vector store connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      const stats = await this.getIndexStats();
      return true;
    } catch (error) {
      console.error('Vector store health check failed:', error);
      return false;
    }
  }
}