// Main SDK exports
export { OpenRAGClient } from './OpenRAGClient.js';

// Type exports
export type {
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
  GitHubOptions,
  DocOptions,
  SourceType,
  IVectorStoreService,
  IEmbeddingService
} from './types/index.js';

// Error exports
export {
  OpenRAGError,
  ConfigurationError,
  IndexingError,
  SearchError,
  VectorStoreError,
  EmbeddingError
} from './types/index.js';

// Utility exports
export {
  validateConfig,
  detectSourceType,
  isGitHubUrl
} from './types/index.js';

// Service exports (for advanced use cases)
export { ScoutVectorStoreService } from './services/ScoutVectorStoreService.js';
export { ScoutEmbeddingService } from './services/ScoutEmbeddingService.js';
export { GitHubService } from './services/GitHubService.js';
export { WebScrapingService } from './services/WebScrapingService.js';
export { ContentProcessor } from './services/ContentProcessor.js';