import OpenAI from 'openai';
import { EmbeddingError, OpenRAGConfig } from '../types/index.js';

export class EmbeddingService {
  private openai: OpenAI;
  private model: string;
  private batchSize: number;
  private rateLimitDelay: number;

  constructor(config: OpenRAGConfig) {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey
    });
    this.model = config.openai.model || 'text-embedding-3-small';
    this.batchSize = Math.min(config.processing?.batchSize || 100, 100); // OpenAI allows max 100 per request
    this.rateLimitDelay = 100; // 100ms between requests to respect rate limits
  }

  /**
   * Generate embeddings for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingError('Cannot generate embedding for empty text');
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: this.preprocessText(text),
        encoding_format: 'float'
      });

      if (!response.data || response.data.length === 0) {
        throw new EmbeddingError('No embedding data received from OpenAI');
      }

      return response.data[0].embedding;
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new EmbeddingError(
          `OpenAI API error: ${error.message}`,
          { 
            status: error.status,
            code: error.code,
            type: error.type,
            textLength: text.length
          }
        );
      }
      
      throw new EmbeddingError(
        `Failed to generate embedding: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { textLength: text.length, error }
      );
    }
  }

  /**
   * Generate embeddings for multiple texts in batches
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Filter out empty texts and track original indices
    const validTexts: { text: string; originalIndex: number }[] = [];
    
    texts.forEach((text, index) => {
      if (text && text.trim().length > 0) {
        validTexts.push({ text: this.preprocessText(text), originalIndex: index });
      }
    });

    if (validTexts.length === 0) {
      throw new EmbeddingError('No valid texts provided for embedding generation');
    }

    const results: number[][] = new Array(texts.length);
    const batches = this.createBatches(validTexts, this.batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      
      try {
        const batchTexts = batch.map(item => item.text);
        const response = await this.openai.embeddings.create({
          model: this.model,
          input: batchTexts,
          encoding_format: 'float'
        });

        if (!response.data || response.data.length !== batch.length) {
          throw new EmbeddingError(
            `Expected ${batch.length} embeddings but received ${response.data?.length || 0}`
          );
        }

        // Map results back to original indices
        response.data.forEach((embedding, batchIndex) => {
          const originalIndex = batch[batchIndex].originalIndex;
          results[originalIndex] = embedding.embedding;
        });

        console.log(`Generated embeddings for batch ${i + 1}/${batches.length} (${batch.length} texts)`);

        // Rate limiting delay
        if (i < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
        }

      } catch (error) {
        if (error instanceof OpenAI.APIError) {
          throw new EmbeddingError(
            `OpenAI API error in batch ${i + 1}: ${error.message}`,
            { 
              batchIndex: i,
              batchSize: batch.length,
              status: error.status,
              code: error.code,
              type: error.type
            }
          );
        }
        
        throw new EmbeddingError(
          `Failed to generate embeddings for batch ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { batchIndex: i, batchSize: batch.length, error }
        );
      }
    }

    return results;
  }

  /**
   * Generate embedding for a query (optimized for search)
   */
  async generateQueryEmbedding(query: string): Promise<number[]> {
    // For queries, we might want to add special preprocessing
    const processedQuery = this.preprocessQuery(query);
    return this.generateEmbedding(processedQuery);
  }

  /**
   * Preprocess text before embedding generation
   */
  private preprocessText(text: string): string {
    // Remove excessive whitespace
    let processed = text.replace(/\s+/g, ' ').trim();
    
    // Truncate to reasonable length (OpenAI has token limits)
    const maxLength = 8000; // Conservative limit for text-embedding-3-small
    if (processed.length > maxLength) {
      processed = processed.substring(0, maxLength);
      
      // Try to end at a sentence boundary
      const lastSentenceEnd = Math.max(
        processed.lastIndexOf('.'),
        processed.lastIndexOf('!'),
        processed.lastIndexOf('?')
      );
      
      if (lastSentenceEnd > maxLength * 0.8) {
        processed = processed.substring(0, lastSentenceEnd + 1);
      }
    }
    
    return processed;
  }

  /**
   * Preprocess query text for better search results
   */
  private preprocessQuery(query: string): string {
    // For queries, we might want to expand abbreviations, fix typos, etc.
    // For now, just basic preprocessing
    return query.replace(/\s+/g, ' ').trim();
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
   * Calculate cosine similarity between two embeddings
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Health check for the embedding service
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.generateEmbedding('test');
      return true;
    } catch (error) {
      console.error('Embedding service health check failed:', error);
      return false;
    }
  }

  /**
   * Get embedding model information
   */
  getModelInfo(): {
    model: string;
    dimensions: number;
    maxTokens: number;
  } {
    // text-embedding-3-small specifications
    const modelSpecs: Record<string, { dimensions: number; maxTokens: number }> = {
      'text-embedding-3-small': { dimensions: 1536, maxTokens: 8191 },
      'text-embedding-3-large': { dimensions: 3072, maxTokens: 8191 },
      'text-embedding-ada-002': { dimensions: 1536, maxTokens: 8191 }
    };

    const spec = modelSpecs[this.model] || modelSpecs['text-embedding-3-small'];
    
    return {
      model: this.model,
      dimensions: spec.dimensions,
      maxTokens: spec.maxTokens
    };
  }
}