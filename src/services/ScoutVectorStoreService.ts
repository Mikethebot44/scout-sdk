import { Vector, QueryResult, VectorStoreError, OpenRAGConfig, IVectorStoreService } from '../types/index.js';

export class ScoutVectorStoreService implements IVectorStoreService {
  private apiKey: string;
  private projectId: string;
  private apiUrl: string;
  private batchSize: number;

  constructor(config: OpenRAGConfig) {
    if (!config.scout) throw new VectorStoreError('Scout configuration is required for ScoutVectorStoreService');
    this.apiKey = config.scout.apiKey;
    this.projectId = config.scout.projectId;
    this.apiUrl = config.scout.apiUrl || 'https://scout-mauve-nine.vercel.app';
    this.batchSize = config.processing?.batchSize || 100;
  }

  async initialize(): Promise<void> { await this.healthCheck(); }

  async upsertVectors(vectors: Vector[]): Promise<void> {
    if (!vectors.length) return;
    const batches = this.createBatches(vectors, this.batchSize);
    for (let i = 0; i < batches.length; i++) {
      let retries = 0;
      while (retries < 3) {
        try {
          const res = await fetch(`${this.apiUrl}/api/scout/vector-store?operation=upsert&projectId=${this.projectId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
            body: JSON.stringify({ vectors: batches[i] })
          });
          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new VectorStoreError(`Scout API upsert error: ${res.status} ${res.statusText}`, { errorData, batchIndex: i });
          }
          break;
        } catch (error) {
          retries++;
          if (retries >= 3) throw new VectorStoreError(`Failed to upsert batch ${i + 1} via Scout API after 3 retries`, { error });
          await new Promise(r => setTimeout(r, Math.pow(2, retries) * 1000));
        }
      }
    }
  }

  async queryVectors(vector: number[], options: { topK?: number; filter?: Record<string, any>; threshold?: number; includeMetadata?: boolean } = {}): Promise<QueryResult[]> {
    const { topK = 10, filter, threshold = 0.7, includeMetadata = true } = options;
    const res = await fetch(`${this.apiUrl}/api/scout/vector-store?operation=query&projectId=${this.projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ vector, topK, filter, includeMetadata, includeValues: false })
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new VectorStoreError(`Scout API query error: ${res.status} ${res.statusText}`, { errorData });
    }
    const data = await res.json();
    const results: QueryResult[] = [];
    for (const match of (data.matches || [])) {
      if (match.score && match.score >= threshold) {
        results.push({ id: match.id, score: match.score, metadata: match.metadata });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }

  async deleteVectors(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const batches = this.createBatches(ids, this.batchSize);
    for (const batch of batches) {
      const res = await fetch(`${this.apiUrl}/api/scout/vector-store?operation=delete&projectId=${this.projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({ ids: batch })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new VectorStoreError(`Scout API delete error: ${res.status} ${res.statusText}`, { errorData });
      }
    }
  }

  async deleteByFilter(filter: Record<string, any>): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/scout/vector-store?operation=delete&projectId=${this.projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ filter })
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new VectorStoreError(`Scout API delete by filter error: ${res.status} ${res.statusText}`, { errorData });
    }
  }

  async getIndexStats(): Promise<{ totalVectors: number; dimension: number; indexFullness: number }> {
    const res = await fetch(`${this.apiUrl}/api/scout/vector-store?operation=stats&projectId=${this.projectId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new VectorStoreError(`Scout API stats error: ${res.status} ${res.statusText}`, { errorData });
    }
    const data = await res.json();
    return {
      totalVectors: data.totalRecordCount || 0,
      dimension: data.dimension || 0,
      indexFullness: data.indexFullness || 0
    };
  }

  async listSources(): Promise<string[]> {
    console.warn('listSources() not implemented for Scout API mode');
    return [];
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
    return out;
  }

  async healthCheck(): Promise<boolean> {
    try { await this.getIndexStats(); return true; } catch { return false; }
  }
}
