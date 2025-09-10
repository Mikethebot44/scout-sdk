import { 
  OpenRAGConfig,
  IndexOptions,
  IndexResult,
  SearchOptions,
  SearchResult,
  BatchIndexRequest,
  BatchIndexResult,
  SourceInfo,
  HealthStatus,
  RAGStats,
  FormattedContext,
  FormatOptions,
  validateConfig,
  detectSourceType,
  isGitHubUrl,
  ConfigurationError,
  IndexingError,
  SearchError,
  OpenRAGError
} from './types/index.js';

import { VectorStoreService } from './services/VectorStoreService.js';
import { EmbeddingService } from './services/EmbeddingService.js';
import { GitHubService } from './services/GitHubService.js';
import { WebScrapingService } from './services/WebScrapingService.js';
import { ContentProcessor } from './services/ContentProcessor.js';

/**
 * Main SDK client for RAG-enhanced AI applications
 * 
 * @example
 * ```typescript
 * const client = new OpenRAGClient({
 *   pinecone: { apiKey: 'your-key' },
 *   openai: { apiKey: 'your-key' }
 * });
 * 
 * // Index a repository
 * await client.indexSource('https://github.com/facebook/react');
 * 
 * // Search for context
 * const results = await client.search('how to use hooks');
 * ```
 */
export class OpenRAGClient {
  private config: OpenRAGConfig;
  private vectorStoreService: VectorStoreService;
  private embeddingService: EmbeddingService;
  private githubService: GitHubService;
  private webScrapingService: WebScrapingService;
  private contentProcessor: ContentProcessor;
  private initialized = false;

  constructor(config: OpenRAGConfig) {
    validateConfig(config);
    
    // Apply defaults
    this.config = {
      ...config,
      pinecone: {
        environment: 'us-east-1',
        indexName: 'scout-index',
        ...config.pinecone
      },
      openai: {
        model: 'text-embedding-3-small',
        ...config.openai
      },
      processing: {
        maxFileSize: 1048576, // 1MB
        maxChunkSize: 8192,
        chunkOverlap: 200,
        batchSize: 100,
        ...config.processing
      }
    };

    // Initialize services
    this.vectorStoreService = new VectorStoreService(this.config);
    this.embeddingService = new EmbeddingService(this.config);
    this.githubService = new GitHubService(this.config);
    this.webScrapingService = new WebScrapingService();
    this.contentProcessor = new ContentProcessor(this.config);
  }

  /**
   * Initialize the client (must be called before other operations)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log('Initializing OpenRAG client...');
      
      // Initialize vector store (creates index if needed)
      await this.vectorStoreService.initialize();
      
      // Initialize web scraping service
      await this.webScrapingService.initialize();
      
      // Run health checks
      const health = await this.healthCheck();
      if (!health.healthy) {
        throw new ConfigurationError(`Health check failed: ${health.errors?.join(', ')}`);
      }

      this.initialized = true;
      console.log('OpenRAG client initialized successfully');
    } catch (error) {
      throw new ConfigurationError(
        `Failed to initialize client: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error }
      );
    }
  }

  /**
   * Index a source (GitHub repository or documentation website)
   */
  async indexSource(url: string, options: IndexOptions = {}): Promise<IndexResult> {
    await this.ensureInitialized();
    
    const startTime = Date.now();
    
    try {
      console.log(`Starting to index source: ${url}`);
      
      // Detect source type
      const sourceType = options.sourceType === 'auto' || !options.sourceType 
        ? detectSourceType(url) 
        : options.sourceType;
      
      console.log(`Detected source type: ${sourceType}`);

      // Process content based on source type
      let chunks;
      let sourceTitle = '';

      if (sourceType === 'github') {
        const githubContent = await this.githubService.processRepository(url, {
          includePatterns: options.includePatterns,
          excludePatterns: options.excludePatterns,
          maxFileSize: options.maxFileSize || this.config.processing!.maxFileSize
        });

        sourceTitle = githubContent.repository;
        chunks = this.contentProcessor.processGitHubContent(githubContent);
        console.log(`Processed GitHub repository: ${chunks.length} chunks created`);

      } else {
        // Documentation processing
        const docContent = await this.webScrapingService.processDocumentation(url, {
          maxDepth: options.maxDepth || 3,
          onlyMainContent: options.onlyMainContent !== false,
          maxPages: 1000
        });

        sourceTitle = new URL(url).hostname;
        chunks = this.contentProcessor.processDocumentationContent(docContent);
        console.log(`Processed documentation site: ${chunks.length} chunks created from ${docContent.pages.length} pages`);
      }

      if (chunks.length === 0) {
        return {
          success: false,
          message: 'No content found to index. Check URL and filters.',
          processingTime: Date.now() - startTime
        };
      }

      // Generate embeddings for all chunks
      console.log('Generating embeddings...');
      const texts = chunks.map(chunk => chunk.content);
      const embeddings = await this.embeddingService.generateEmbeddings(texts);

      // Prepare vectors for Pinecone
      const vectors = chunks.map((chunk, index) => ({
        id: chunk.id,
        values: embeddings[index],
        metadata: {
          content: chunk.content.substring(0, 40000), // Pinecone metadata limit
          type: chunk.type,
          sourceUrl: chunk.source.url,
          sourcePath: chunk.source.path,
          sourceTitle: chunk.source.title || sourceTitle,
          language: chunk.metadata.language,
          size: chunk.metadata.size,
          hash: chunk.metadata.hash,
          headingLevel: chunk.metadata.headingLevel,
          section: chunk.metadata.section,
          dependencies: chunk.metadata.dependencies?.join(',') || undefined
        }
      }));

      // Store in vector database
      console.log('Storing vectors in Pinecone...');
      await this.vectorStoreService.upsertVectors(vectors);

      const processingTime = Date.now() - startTime;
      const sourceId = await this.generateSourceId(url);

      return {
        success: true,
        message: `Successfully indexed ${chunks.length} chunks from ${sourceType === 'github' ? 'repository' : 'documentation site'}: ${sourceTitle}`,
        sourceId,
        chunksIndexed: chunks.length,
        processingTime
      };

    } catch (error) {
      console.error('Error indexing source:', error);
      
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof OpenRAGError 
        ? error.message 
        : `Unexpected error: ${error instanceof Error ? error.message : 'Unknown error'}`;

      return {
        success: false,
        message: `Failed to index source: ${errorMessage}`,
        processingTime
      };
    }
  }

  /**
   * Search indexed sources for relevant context
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const startTime = Date.now();

    try {
      console.log(`Searching for: "${query}"`);

      // Generate query embedding
      const queryEmbedding = await this.embeddingService.generateQueryEmbedding(query);

      // Build filter for vector search
      const filter = this.buildSearchFilter(options);

      // Perform vector similarity search
      const vectorResults = await this.vectorStoreService.queryVectors(queryEmbedding, {
        topK: options.maxResults || 10,
        threshold: options.threshold || 0.7,
        filter,
        includeMetadata: true
      });

      // Convert vector results to search results
      const searchResults = this.convertToSearchResults(vectorResults);

      // Re-rank results by relevance and diversify
      const rankedResults = this.rankAndDiversifyResults(searchResults, query);

      const searchTime = Date.now() - startTime;
      console.log(`Search completed in ${searchTime}ms, found ${rankedResults.length} results`);

      return rankedResults;

    } catch (error) {
      console.error('Error searching context:', error);
      
      const errorMessage = error instanceof Error 
        ? error.message 
        : 'Unknown error occurred during search';

      throw new SearchError(`Search failed: ${errorMessage}`, { query, options, error });
    }
  }

  /**
   * Index multiple sources in batch
   */
  async indexBatch(requests: BatchIndexRequest[]): Promise<BatchIndexResult> {
    await this.ensureInitialized();
    
    const startTime = Date.now();
    const results: BatchIndexResult['results'] = [];
    let successCount = 0;
    let failureCount = 0;

    for (const request of requests) {
      try {
        const result = await this.indexSource(request.url, request.options);
        
        if (result.success) {
          successCount++;
          results.push({
            url: request.url,
            success: true,
            sourceId: result.sourceId,
            chunksIndexed: result.chunksIndexed
          });
        } else {
          failureCount++;
          results.push({
            url: request.url,
            success: false,
            error: result.message
          });
        }
      } catch (error) {
        failureCount++;
        results.push({
          url: request.url,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return {
      success: successCount > 0,
      totalSources: requests.length,
      successfulIndexes: successCount,
      failedIndexes: failureCount,
      results,
      totalTime: Date.now() - startTime
    };
  }

  /**
   * List all indexed sources
   */
  async listSources(): Promise<SourceInfo[]> {
    await this.ensureInitialized();
    
    // This would require implementing a metadata tracking system
    // For now, return empty array as a placeholder
    console.warn('listSources() requires metadata tracking system - returning empty array');
    return [];
  }

  /**
   * Delete an indexed source
   */
  async deleteSource(sourceId: string): Promise<boolean> {
    await this.ensureInitialized();
    
    try {
      // Delete vectors by filter (sourceUrl or sourceId)
      await this.vectorStoreService.deleteByFilter({ sourceId });
      return true;
    } catch (error) {
      console.error('Error deleting source:', error);
      return false;
    }
  }

  /**
   * Format search results for different AI providers
   */
  formatForAI(results: SearchResult[], options: FormatOptions = {}): FormattedContext {
    const {
      maxLength = 16000,
      includeCitations = true,
      format = 'generic'
    } = options;

    let formattedText = '';
    const sources: FormattedContext['sources'] = [];
    let currentLength = 0;

    for (const result of results) {
      const citation = includeCitations 
        ? `\n\nSource: ${result.source.title || result.source.url} (Score: ${(result.score * 100).toFixed(1)}%)`
        : '';
      
      const resultText = `${result.content}${citation}\n\n---\n\n`;
      
      if (currentLength + resultText.length > maxLength) {
        break;
      }

      formattedText += resultText;
      currentLength += resultText.length;

      // Track unique sources
      const sourceKey = result.source.url;
      if (!sources.find(s => s.url === sourceKey)) {
        sources.push({
          title: result.source.title || result.source.url,
          url: result.source.url,
          type: result.source.type
        });
      }
    }

    // Apply format-specific styling
    if (format === 'openai') {
      formattedText = `## Context Information\n\n${formattedText}`;
    } else if (format === 'claude') {
      formattedText = `<context>\n${formattedText}</context>`;
    }

    return {
      text: formattedText.trim(),
      sources,
      characterCount: formattedText.length
    };
  }

  /**
   * Get client health status
   */
  async healthCheck(): Promise<HealthStatus> {
    const services = {
      vectorStore: false,
      embedding: false,
      github: false,
      webScraping: false
    };

    const errors: string[] = [];

    try {
      services.vectorStore = await this.vectorStoreService.healthCheck();
    } catch (error) {
      errors.push(`Vector store: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
      services.embedding = await this.embeddingService.healthCheck();
    } catch (error) {
      errors.push(`Embedding: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
      services.github = await this.githubService.healthCheck();
    } catch (error) {
      errors.push(`GitHub: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
      services.webScraping = await this.webScrapingService.healthCheck();
    } catch (error) {
      errors.push(`Web scraping: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const healthy = Object.values(services).every(status => status === true);

    return {
      healthy,
      services,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Get RAG statistics
   */
  async getStats(): Promise<RAGStats> {
    await this.ensureInitialized();
    
    const indexStats = await this.vectorStoreService.getIndexStats();
    
    return {
      totalSources: 0, // Would require metadata tracking
      totalChunks: indexStats.totalVectors,
      indexFullness: indexStats.indexFullness,
      sourceTypes: {
        github: 0, // Would require metadata tracking
        documentation: 0 // Would require metadata tracking
      }
    };
  }

  /**
   * Cleanup resources (call when done)
   */
  async cleanup(): Promise<void> {
    try {
      await this.webScrapingService.cleanup();
      console.log('Resources cleaned up successfully');
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  // Private helper methods

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private buildSearchFilter(options: SearchOptions): Record<string, any> {
    const filter: Record<string, any> = {};

    // Filter by source URLs if specified
    if (options.sources && options.sources.length > 0) {
      filter.sourceUrl = { $in: options.sources };
    }

    // Filter by content type
    const includeTypes: string[] = [];
    if (options.includeCode !== false) {
      includeTypes.push('code', 'readme');
    }
    if (options.includeDocumentation !== false) {
      includeTypes.push('documentation');
    }
    
    if (includeTypes.length > 0) {
      filter.type = { $in: includeTypes };
    }

    return filter;
  }

  private convertToSearchResults(vectorResults: any[]): SearchResult[] {
    return vectorResults.map(result => ({
      content: result.metadata.content,
      source: {
        url: result.metadata.sourceUrl,
        type: result.metadata.type === 'code' || result.metadata.type === 'readme' ? 'github' : 'documentation',
        path: result.metadata.sourcePath,
        title: result.metadata.sourceTitle
      },
      metadata: {
        language: result.metadata.language,
        section: result.metadata.section,
        headingLevel: result.metadata.headingLevel
      },
      score: result.score
    }));
  }

  private rankAndDiversifyResults(results: SearchResult[], query: string): SearchResult[] {
    // Apply additional scoring factors
    const scoredResults = results.map(result => ({
      ...result,
      adjustedScore: this.calculateAdjustedScore(result, query)
    }));

    // Sort by adjusted score
    scoredResults.sort((a, b) => b.adjustedScore - a.adjustedScore);

    // Diversify results to avoid too many from the same source
    const diversifiedResults = this.diversifyResults(scoredResults);

    return diversifiedResults.map(result => ({
      content: result.content,
      source: result.source,
      metadata: result.metadata,
      score: result.score
    }));
  }

  private calculateAdjustedScore(result: SearchResult, query: string): number {
    let score = result.score;

    // Boost score based on content length (prefer more substantial content)
    const contentLength = result.content.length;
    if (contentLength > 500) {
      score *= 1.1;
    } else if (contentLength < 100) {
      score *= 0.9;
    }

    // Boost score for code if query contains code-related terms
    const codeTerms = ['function', 'class', 'method', 'implementation', 'code', 'api', 'library'];
    const hasCodeTerms = codeTerms.some(term => 
      query.toLowerCase().includes(term) || result.content.toLowerCase().includes(term)
    );
    
    if (hasCodeTerms && result.source.type === 'github') {
      score *= 1.2;
    }

    // Boost score for documentation if query contains question words
    const questionWords = ['how', 'what', 'why', 'when', 'where', 'guide', 'tutorial', 'documentation'];
    const hasQuestionWords = questionWords.some(word => query.toLowerCase().includes(word));
    
    if (hasQuestionWords && result.source.type === 'documentation') {
      score *= 1.15;
    }

    // Boost score for exact phrase matches
    const queryWords = query.toLowerCase().split(/\s+/);
    const contentLower = result.content.toLowerCase();
    const exactMatches = queryWords.filter(word => contentLower.includes(word)).length;
    const exactMatchBoost = 1 + (exactMatches / queryWords.length) * 0.1;
    score *= exactMatchBoost;

    // Prefer content with clear structure (headers, sections)
    if (result.metadata.section) {
      score *= 1.05;
    }

    return Math.min(score, 1.0); // Cap at 1.0
  }

  private diversifyResults(results: any[]): any[] {
    const diversified: any[] = [];
    const sourceCount: Record<string, number> = {};
    const maxPerSource = 3; // Maximum results per source

    for (const result of results) {
      const sourceKey = result.source.url;
      const currentCount = sourceCount[sourceKey] || 0;

      if (currentCount < maxPerSource) {
        diversified.push(result);
        sourceCount[sourceKey] = currentCount + 1;
      }
    }

    // If we have fewer results than requested due to diversification,
    // add more from the highest-scoring sources
    if (diversified.length < results.length && diversified.length < 10) {
      const remaining = results.filter(r => !diversified.includes(r));
      const additionalCount = Math.min(remaining.length, 10 - diversified.length);
      diversified.push(...remaining.slice(0, additionalCount));
    }

    return diversified;
  }

  private async generateSourceId(url: string): Promise<string> {
    const { createHash } = await import('crypto');
    return createHash('md5').update(url).digest('hex').substring(0, 12);
  }
}