# Scout SDK

A TypeScript SDK for building RAG-enhanced AI applications with vector search and content indexing.

## Features

- **Universal Source Indexing**: Index GitHub repositories and documentation websites
- **Vector Search**: Semantic search using Scout API for embeddings and vector storage  
- **Developer-Friendly API**: Clean TypeScript interface with native promises
- **Batch Operations**: Index multiple sources efficiently
- **AI Provider Integration**: Format context for OpenAI, Claude, and other LLMs
- **Health Monitoring**: Built-in health checks and statistics
- **Type Safety**: Full TypeScript support with comprehensive type definitions

## Installation

```bash
npm install scout-sdk
```

## Quick Start

```typescript
import { OpenRAGClient } from 'scout-sdk';

// Initialize the client
const client = new OpenRAGClient({
  scout: {
    apiKey: process.env.SCOUT_API_KEY!,
    projectId: process.env.SCOUT_PROJECT_ID!,
    apiUrl: process.env.SCOUT_API_URL || 'https://scout-mauve-nine.vercel.app'
  },
  github: { token: process.env.GITHUB_TOKEN } // optional
});

// Initialize (health checks Scout API)
await client.initialize();

// Index a GitHub repository
const result = await client.indexSource('https://github.com/facebook/react');
console.log(`Indexed ${result.chunksIndexed} chunks`);

// Search for relevant context
const results = await client.search('how to use React hooks');
console.log(`Found ${results.length} relevant results`);

// Format results for AI consumption
const context = client.formatForAI(results, { format: 'openai' });
// Use context.text in your LLM prompt
```

## API Reference

### OpenRAGClient

The main client class for all RAG operations.

#### Constructor

```typescript
new OpenRAGClient(config: OpenRAGConfig)
```

**Configuration Options:**

```typescript
interface OpenRAGConfig {
  scout: {
    apiKey: string;           // Required: Scout API key
    projectId: string;        // Required: Scout project ID
    apiUrl?: string;          // Optional: Default 'https://scout-mauve-nine.vercel.app'
  };
  openai?: {
    model?: string;           // Optional: Default 'text-embedding-3-small'
  };
  github?: {
    token?: string;           // Optional: GitHub token for higher rate limits
  };
  processing?: {
    maxFileSize?: number;     // Optional: Default 1MB
    maxChunkSize?: number;    // Optional: Default 8192 chars
    chunkOverlap?: number;    // Optional: Default 200 chars
    batchSize?: number;       // Optional: Default 100
  };
}
```

#### Methods

##### `initialize(): Promise<void>`

Initialize the client and health check Scout API. Must be called before other operations.

##### `indexSource(url: string, options?: IndexOptions): Promise<IndexResult>`

Index a GitHub repository or documentation website.

**Options:**
- `sourceType?: 'github' | 'documentation' | 'auto'` - Source type (auto-detects by default)
- `includePatterns?: string[]` - File patterns to include (e.g., `['*.ts', '*.js']`)
- `excludePatterns?: string[]` - File patterns to exclude (e.g., `['**/*.test.*']`)
- `maxFileSize?: number` - Maximum file size in bytes
- `maxDepth?: number` - Maximum crawl depth for documentation sites
- `branch?: string` - Git branch for GitHub repos (default: 'main')

##### `search(query: string, options?: SearchOptions): Promise<SearchResult[]>`

Search indexed content for relevant context.

**Options:**
- `maxResults?: number` - Maximum results to return (default: 10)
- `threshold?: number` - Similarity threshold 0-1 (default: 0.7)
- `sources?: string[]` - Filter by specific source URLs
- `includeCode?: boolean` - Include code snippets (default: true)
- `includeDocumentation?: boolean` - Include documentation (default: true)

##### `indexBatch(requests: BatchIndexRequest[]): Promise<BatchIndexResult>`

Index multiple sources in batch.

##### `formatForAI(results: SearchResult[], options?: FormatOptions): FormattedContext`

Format search results for AI consumption.

**Options:**
- `format?: 'openai' | 'claude' | 'generic'` - Output format
- `maxLength?: number` - Maximum character length (default: 16000)
- `includeCitations?: boolean` - Include source citations (default: true)

##### `listSources(): Promise<SourceInfo[]>`

List all indexed sources with metadata.

##### `deleteSource(sourceId: string): Promise<boolean>`

Delete an indexed source and all its content.

##### `healthCheck(): Promise<HealthStatus>`

Check the health of all services.

##### `getStats(): Promise<RAGStats>`

Get statistics about the knowledge base.

## Examples

### Basic Usage

See [`examples/basic/simple-usage.ts`](./examples/basic/simple-usage.ts) for a complete example.

### Express.js Chatbot

See [`examples/express-chatbot/server.ts`](./examples/express-chatbot/server.ts) for a full chatbot implementation.

### Next.js Integration

```typescript
// pages/api/search.ts
import { OpenRAGClient } from 'scout-sdk';

const ragClient = new OpenRAGClient({
  scout: {
    apiKey: process.env.SCOUT_API_KEY!,
    projectId: process.env.SCOUT_PROJECT_ID!,
    apiUrl: process.env.SCOUT_API_URL || 'https://scout-mauve-nine.vercel.app'
  },
  github: { token: process.env.GITHUB_TOKEN } // optional
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;
  
  try {
    const results = await ragClient.search(query);
    const context = ragClient.formatForAI(results);
    
    res.json({ results, context });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
```

## Prerequisites

You need API keys for:
- **Scout API**: Vector storage and embeddings ([Get API key](https://scout-mauve-nine.vercel.app))
- **GitHub Token** (optional): For higher rate limits ([Create token](https://github.com/settings/tokens))

## Environment Variables

```bash
SCOUT_API_KEY=your_scout_api_key
SCOUT_PROJECT_ID=your_scout_project_id
SCOUT_API_URL=https://scout-mauve-nine.vercel.app  # Optional
GITHUB_TOKEN=your_github_token  # Optional
```

## Error Handling

The SDK provides specific error types for different scenarios:

```typescript
import { 
  ConfigurationError, 
  IndexingError, 
  SearchError, 
  VectorStoreError,
  EmbeddingError 
} from 'scout-sdk';

try {
  await client.indexSource(url);
} catch (error) {
  if (error instanceof IndexingError) {
    console.log('Indexing failed:', error.message);
  } else if (error instanceof ConfigurationError) {
    console.log('Configuration issue:', error.message);
  }
}
```

## Development

```bash
# Clone the repository
git clone https://github.com/terragon-labs/scout-sdk
cd scout-sdk

# Install dependencies
npm install

# Build the SDK
npm run build

# Run examples
npm run example:basic
npm run example:express
```

## Differences from MCP Server

This SDK provides the same core functionality as the Scout MCP server but with:

- **Direct API**: No MCP protocol overhead, just TypeScript function calls
- **Better DX**: Constructor-based config, native promises, comprehensive types
- **More Features**: Batch operations, AI formatting, health monitoring
- **Framework Ready**: Easy integration with Express, Next.js, etc.

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please read the contributing guidelines before submitting PRs.

## Support

- [Documentation](https://docs.scout-sdk.dev)
- [GitHub Issues](https://github.com/terragon-labs/scout-sdk/issues)
- [Discord Community](https://discord.gg/scout-sdk)# scout-sdk
