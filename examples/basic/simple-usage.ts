/**
 * Basic usage example of the Scout SDK
 */

import { OpenRAGClient } from 'scout-sdk';

async function main() {
  // Initialize the client
  const client = new OpenRAGClient({
    pinecone: {
      apiKey: process.env.PINECONE_API_KEY!,
      indexName: 'my-rag-index' // Optional, defaults to 'scout-index'
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small' // Optional, this is the default
    },
    github: {
      token: process.env.GITHUB_TOKEN // Optional, for higher rate limits
    }
  });

  // Initialize (creates Pinecone index if needed)
  await client.initialize();

  // Index a GitHub repository
  console.log('Indexing React repository...');
  const indexResult = await client.indexSource('https://github.com/facebook/react', {
    includePatterns: ['*.ts', '*.tsx', '*.js', '*.jsx'],
    excludePatterns: ['**/*.test.*', '**/node_modules/**'],
    maxFileSize: 500000 // 500KB max per file
  });

  if (indexResult.success) {
    console.log(`✅ Indexed ${indexResult.chunksIndexed} chunks from React repo`);
  } else {
    console.log(`❌ Failed to index: ${indexResult.message}`);
    return;
  }

  // Index documentation
  console.log('Indexing React documentation...');
  const docResult = await client.indexSource('https://react.dev/learn', {
    sourceType: 'documentation',
    maxDepth: 2
  });

  if (docResult.success) {
    console.log(`✅ Indexed ${docResult.chunksIndexed} chunks from React docs`);
  }

  // Search for context
  console.log('\nSearching for information about hooks...');
  const searchResults = await client.search('how to use React hooks', {
    maxResults: 5,
    threshold: 0.8,
    includeCode: true,
    includeDocumentation: true
  });

  console.log(`Found ${searchResults.length} relevant results:`);
  searchResults.forEach((result, index) => {
    console.log(`\n${index + 1}. ${result.source.title} (${(result.score * 100).toFixed(1)}% match)`);
    console.log(`   Source: ${result.source.url}`);
    console.log(`   Preview: ${result.content.substring(0, 200)}...`);
  });

  // Format results for AI consumption
  const formattedContext = client.formatForAI(searchResults, {
    format: 'openai',
    maxLength: 8000,
    includeCitations: true
  });

  console.log(`\nFormatted context (${formattedContext.characterCount} chars):`);
  console.log(formattedContext.text.substring(0, 500) + '...');

  // Get client statistics
  const stats = await client.getStats();
  console.log('\nRAG Statistics:', stats);

  // Check health
  const health = await client.healthCheck();
  console.log('\nHealth Status:', health);
}

// Run the example
main().catch(console.error);