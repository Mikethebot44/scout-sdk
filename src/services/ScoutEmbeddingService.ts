import { EmbeddingError, OpenRAGConfig, IEmbeddingService } from '../types/index.js';

export class ScoutEmbeddingService implements IEmbeddingService {
  private apiKey: string;
  private projectId: string;
  private apiUrl: string;
  private batchSize: number;
  private rateLimitDelay: number;
  private model: string;

  constructor(config: OpenRAGConfig) {
    if (!config.scout) {
      throw new EmbeddingError('Scout configuration is required for ScoutEmbeddingService');
    }
    this.apiKey = config.scout.apiKey;
    this.projectId = config.scout.projectId;
    this.apiUrl = config.scout.apiUrl || 'https://scout-mauve-nine.vercel.app';
    this.batchSize = Math.min(config.processing?.batchSize || 100, 100);
    this.rateLimitDelay = 100;
    this.model = config.openai?.model || 'text-embedding-3-small';
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingError('Cannot generate embedding for empty text');
    }
    try {
      const res = await fetch(`${this.apiUrl}/api/scout/embeddings?projectId=${this.projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({ input: this.preprocessText(text), model: this.model, encoding_format: 'float' })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new EmbeddingError(`Scout API error: ${res.status} ${res.statusText}`, { errorData });
      }
      const data = await res.json();
      if (!data.data?.length) throw new EmbeddingError('No embedding data received from Scout API');
      return data.data[0].embedding;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError(`Failed to generate embedding via Scout API: ${error instanceof Error ? error.message : 'Unknown error'}`, { error });
    }
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const valid: { text: string; i: number }[] = [];
    texts.forEach((t, i) => { if (t?.trim()) valid.push({ text: this.preprocessText(t), i }); });
    if (valid.length === 0) throw new EmbeddingError('No valid texts provided for embedding generation');

    const out: number[][] = new Array(texts.length);
    const batches = this.createBatches(valid, this.batchSize);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const res = await fetch(`${this.apiUrl}/api/scout/embeddings?projectId=${this.projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({ input: batch.map(b => b.text), model: this.model, encoding_format: 'float' })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new EmbeddingError(`Scout API error in batch ${i + 1}: ${res.status} ${res.statusText}`, { errorData });
      }
      const data = await res.json();
      if (!data.data || data.data.length !== batch.length) {
        throw new EmbeddingError(`Expected ${batch.length} embeddings but received ${data.data?.length || 0}`);
      }
      data.data.forEach((emb: any, j: number) => { out[batch[j].i] = emb.embedding; });
      if (i < batches.length - 1) await new Promise(r => setTimeout(r, this.rateLimitDelay));
    }
    return out;
  }

  async generateQueryEmbedding(query: string): Promise<number[]> {
    return this.generateEmbedding(this.preprocessQuery(query));
  }

  private preprocessText(text: string): string {
    let s = text.replace(/\s+/g, ' ').trim();
    const max = 8000;
    if (s.length > max) {
      s = s.substring(0, max);
      const end = Math.max(s.lastIndexOf('.'), s.lastIndexOf('!'), s.lastIndexOf('?'));
      if (end > max * 0.8) s = s.substring(0, end + 1);
    }
    return s;
  }

  private preprocessQuery(q: string): string {
    return q.replace(/\s+/g, ' ').trim();
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
    return out;
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error('Embeddings must have the same length');
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
    na = Math.sqrt(na); nb = Math.sqrt(nb);
    return (na === 0 || nb === 0) ? 0 : dot / (na * nb);
  }

  async healthCheck(): Promise<boolean> {
    try { await this.generateEmbedding('test'); return true; }
    catch { return false; }
  }

  getModelInfo(): { model: string; dimensions: number; maxTokens: number } {
    const specs: Record<string, { dimensions: number; maxTokens: number }> = {
      'text-embedding-3-small': { dimensions: 1536, maxTokens: 8191 },
      'text-embedding-3-large': { dimensions: 3072, maxTokens: 8191 },
      'text-embedding-ada-002': { dimensions: 1536, maxTokens: 8191 }
    };
    const spec = specs[this.model] || specs['text-embedding-3-small'];
    return { model: this.model, dimensions: spec.dimensions, maxTokens: spec.maxTokens };
  }
}
