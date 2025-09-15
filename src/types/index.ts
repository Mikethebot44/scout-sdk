// ===== SDK Configuration Types =====

export interface OpenRAGConfig {
  scout: {
    apiKey: string;
    projectId: string;
    apiUrl?: string; // default: https://scout-mauve-nine.vercel.app
  };
  openai?: {
    model?: string;
  };
  github?: {
    token?: string;
  };
  processing?: {
    maxFileSize?: number;
    maxChunkSize?: number;
    chunkOverlap?: number;
    batchSize?: number;
  };
}

// ===== Source and Content Types =====

export type SourceType = 'github' | 'documentation';

export interface SourceInfo {
  /** Unique source identifier */
  id: string;
  /** Source URL */
  url: string;
  /** Source type */
  type: SourceType;
  /** Human-readable title */
  title: string;
  /** When the source was indexed */
  indexedAt: Date;
  /** Number of chunks indexed */
  chunkCount: number;
  /** Current status */
  status: 'indexed' | 'indexing' | 'failed';
}

// ===== Indexing Types =====

export interface IndexOptions {
  /** Source type (auto-detects if not specified) */
  sourceType?: SourceType | 'auto';
  /** Git branch for GitHub repos (default: main) */
  branch?: string;
  /** File patterns to include (e.g., ["*.ts", "*.js"]) */
  includePatterns?: string[];
  /** File patterns to exclude (e.g., ["node_modules/**"]) */
  excludePatterns?: string[];
  /** Maximum file size in bytes */
  maxFileSize?: number;
  /** Maximum crawl depth for documentation sites */
  maxDepth?: number;
  /** Extract only main content for documentation */
  onlyMainContent?: boolean;
}

export interface GitHubOptions extends Omit<IndexOptions, 'maxDepth' | 'onlyMainContent'> {
  /** Git branch (default: main) */
  branch?: string;
}

export interface DocOptions extends Omit<IndexOptions, 'branch'> {
  /** Maximum crawl depth (default: 3) */
  maxDepth?: number;
  /** Extract only main content (default: true) */
  onlyMainContent?: boolean;
}

export interface IndexResult {
  /** Whether indexing was successful */
  success: boolean;
  /** Result message */
  message: string;
  /** Unique source identifier */
  sourceId?: string;
  /** Number of chunks indexed */
  chunksIndexed?: number;
  /** Processing time in milliseconds */
  processingTime?: number;
}

// ===== Search Types =====

export interface SearchOptions {
  /** Maximum number of results (default: 10) */
  maxResults?: number;
  /** Filter by specific source URLs or IDs */
  sources?: string[];
  /** Include code snippets in results (default: true) */
  includeCode?: boolean;
  /** Include documentation in results (default: true) */
  includeDocumentation?: boolean;
  /** Similarity threshold 0-1 (default: 0.7) */
  threshold?: number;
}

export interface SearchResult {
  /** Content snippet */
  content: string;
  /** Source information */
  source: {
    /** Source URL */
    url: string;
    /** Source type */
    type: SourceType;
    /** File path (for GitHub) or page path (for docs) */
    path?: string;
    /** Source title */
    title?: string;
  };
  /** Additional metadata */
  metadata: {
    /** Programming language (for code) */
    language?: string;
    /** Section or heading (for docs) */
    section?: string;
    /** Heading level (for docs) */
    headingLevel?: number;
  };
  /** Similarity score (0-1) */
  score: number;
}

// ===== Batch Operations =====

export interface BatchIndexRequest {
  /** Source URL */
  url: string;
  /** Source type */
  type?: SourceType | 'auto';
  /** Source-specific options */
  options?: IndexOptions;
}

export interface BatchIndexResult {
  /** Overall success */
  success: boolean;
  /** Total sources processed */
  totalSources: number;
  /** Number of successful indexes */
  successfulIndexes: number;
  /** Number of failed indexes */
  failedIndexes: number;
  /** Individual results */
  results: Array<{
    url: string;
    success: boolean;
    sourceId?: string;
    chunksIndexed?: number;
    error?: string;
  }>;
  /** Total processing time */
  totalTime: number;
}

// ===== Health and Stats =====

export interface HealthStatus {
  /** Overall health */
  healthy: boolean;
  /** Service-specific status */
  services: {
    vectorStore: boolean;
    embedding: boolean;
    github: boolean;
    webScraping: boolean;
  };
  /** Any error messages */
  errors?: string[];
}

export interface RAGStats {
  /** Total number of sources indexed */
  totalSources: number;
  /** Total number of chunks/vectors */
  totalChunks: number;
  /** Vector store index fullness (0-1) */
  indexFullness: number;
  /** Breakdown by source type */
  sourceTypes: {
    github: number;
    documentation: number;
  };
}

// ===== AI Provider Formatting =====

export interface FormattedContext {
  /** Formatted text ready for AI model */
  text: string;
  /** Source attribution for citations */
  sources: Array<{
    title: string;
    url: string;
    type: SourceType;
  }>;
  /** Total character count */
  characterCount: number;
}

export interface FormatOptions {
  /** Maximum context length in characters */
  maxLength?: number;
  /** Include source citations */
  includeCitations?: boolean;
  /** Format style for different AI providers */
  format?: 'openai' | 'claude' | 'generic';
}

// ===== Internal Types (used by services) =====

export interface ContentChunk {
  id: string;
  content: string;
  type: 'code' | 'documentation' | 'readme';
  source: {
    url: string;
    type: SourceType;
    path?: string;
    title?: string;
  };
  metadata: {
    language?: string;
    size: number;
    hash: string;
    headingLevel?: number;
    section?: string;
    dependencies?: string[];
  };
}

export interface Vector {
  id: string;
  values: number[];
  metadata: {
    content: string;
    type: string;
    sourceUrl: string;
    sourcePath?: string;
    sourceTitle?: string;
    language?: string;
    size: number;
    hash: string;
    headingLevel?: number;
    section?: string;
    dependencies?: string;
  };
}

export interface QueryResult {
  id: string;
  score: number;
  metadata: Vector['metadata'];
}

// ===== Error Types =====

export class OpenRAGError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'OpenRAGError';
  }
}

export class ConfigurationError extends OpenRAGError {
  constructor(message: string, details?: any) {
    super(message, 'CONFIGURATION_ERROR', details);
  }
}

export class IndexingError extends OpenRAGError {
  constructor(message: string, details?: any) {
    super(message, 'INDEXING_ERROR', details);
  }
}

export class SearchError extends OpenRAGError {
  constructor(message: string, details?: any) {
    super(message, 'SEARCH_ERROR', details);
  }
}

export class VectorStoreError extends OpenRAGError {
  constructor(message: string, details?: any) {
    super(message, 'VECTOR_STORE_ERROR', details);
  }
}

export class EmbeddingError extends OpenRAGError {
  constructor(message: string, details?: any) {
    super(message, 'EMBEDDING_ERROR', details);
  }
}

// ===== Type Guards and Utilities =====

export function isGitHubUrl(url: string): boolean {
  return url.includes('github.com');
}

export function detectSourceType(url: string): SourceType {
  return isGitHubUrl(url) ? 'github' : 'documentation';
}

export function validateConfig(config: OpenRAGConfig): void {
  if (!config.scout?.apiKey || !config.scout?.projectId) {
    throw new ConfigurationError('Scout configuration is required: scout.apiKey and scout.projectId');
  }
}

export interface IVectorStoreService {
  initialize(): Promise<void>;
  upsertVectors(vectors: Vector[]): Promise<void>;
  queryVectors(vector: number[], options?: {
    topK?: number;
    filter?: Record<string, any>;
    threshold?: number;
    includeMetadata?: boolean;
  }): Promise<QueryResult[]>;
  deleteVectors(ids: string[]): Promise<void>;
  deleteByFilter(filter: Record<string, any>): Promise<void>;
  getIndexStats(): Promise<{ totalVectors: number; dimension: number; indexFullness: number }>;
  listSources(): Promise<string[]>;
  healthCheck(): Promise<boolean>;
}

export interface IEmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
  generateQueryEmbedding(query: string): Promise<number[]>;
  healthCheck(): Promise<boolean>;
  getModelInfo(): { model: string; dimensions: number; maxTokens: number };
}

// ===== GitHub Types =====

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  branch: string;
  path?: string;
}

export interface GitHubFile {
  path: string;
  content: string;
  sha: string;
  size: number;
  language: string;
  downloadUrl: string;
}

export interface GitHubContent {
  url: string;
  repository: string;
  branch: string;
  files: GitHubFile[];
}

// ===== Documentation Types =====

export interface DocumentationContent {
  url: string;
  pages: DocumentationPage[];
}

export interface DocumentationPage {
  url: string;
  title: string;
  content: string;
  headings: string[];
  breadcrumbs: string[];
  lastModified?: string;
}

// ===== Processing Options =====

export interface ProcessingOptions {
  includePatterns?: string[];
  excludePatterns?: string[];
  maxFileSize?: number;
  maxDepth?: number;
  onlyMainContent?: boolean;
  maxPages?: number;
}