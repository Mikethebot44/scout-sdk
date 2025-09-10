/**
 * Express.js chatbot server using Scout SDK for RAG-enhanced responses
 */

import express from 'express';
import { OpenRAGClient } from 'scout-sdk';

const app = express();
app.use(express.json());

// Initialize Scout SDK client
const ragClient = new OpenRAGClient({
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY!,
    indexName: 'chatbot-knowledge'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY!
  }
});

// Initialize on server startup
let clientReady = false;
ragClient.initialize().then(() => {
  clientReady = true;
  console.log('✅ RAG client initialized');
}).catch(console.error);

// Middleware to check if client is ready
const ensureReady = (req: any, res: any, next: any) => {
  if (!clientReady) {
    return res.status(503).json({ error: 'RAG system not ready yet' });
  }
  next();
};

// Index a knowledge source
app.post('/admin/index', ensureReady, async (req, res) => {
  const { url, options } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const result = await ragClient.indexSource(url, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to index source' 
    });
  }
});

// Chat endpoint with RAG-enhanced context
app.post('/chat', ensureReady, async (req, res) => {
  const { message, useRAG = true } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    let context = '';
    let sources: any[] = [];

    // Get relevant context from RAG if enabled
    if (useRAG) {
      const searchResults = await ragClient.search(message, {
        maxResults: 3,
        threshold: 0.7
      });

      if (searchResults.length > 0) {
        const formatted = ragClient.formatForAI(searchResults, {
          format: 'openai',
          maxLength: 4000
        });
        context = formatted.text;
        sources = formatted.sources;
      }
    }

    // Here you would integrate with your preferred LLM
    // For this example, we'll just return the context and a mock response
    const response = {
      message: "I'm a demo chatbot. In a real implementation, I would use the context below to generate an AI response.",
      context,
      sources,
      hasContext: context.length > 0
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Chat request failed' 
    });
  }
});

// Get knowledge base status
app.get('/admin/sources', ensureReady, async (req, res) => {
  try {
    const sources = await ragClient.listSources();
    const stats = await ragClient.getStats();
    
    res.json({
      sources,
      stats
    });
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to get sources' 
    });
  }
});

// Delete a knowledge source
app.delete('/admin/sources/:sourceId', ensureReady, async (req, res) => {
  const { sourceId } = req.params;
  
  try {
    const success = await ragClient.deleteSource(sourceId);
    
    if (success) {
      res.json({ message: 'Source deleted successfully' });
    } else {
      res.status(404).json({ error: 'Source not found' });
    }
  } catch (error) {
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to delete source' 
    });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const health = await ragClient.healthCheck();
    res.status(health.healthy ? 200 : 503).json(health);
  } catch (error) {
    res.status(503).json({ 
      healthy: false, 
      error: error instanceof Error ? error.message : 'Health check failed' 
    });
  }
});

// Simple HTML interface for testing
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>RAG Chatbot Demo</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            .chat-container { border: 1px solid #ddd; padding: 20px; border-radius: 8px; }
            input, button { padding: 10px; margin: 5px; }
            .response { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 4px; }
            .sources { background: #e8f4f8; padding: 10px; margin: 10px 0; border-radius: 4px; }
        </style>
    </head>
    <body>
        <h1>RAG-Enhanced Chatbot Demo</h1>
        <div class="chat-container">
            <input type="text" id="messageInput" placeholder="Ask me anything..." style="width: 60%;">
            <button onclick="sendMessage()">Send</button>
            <div id="response"></div>
        </div>
        
        <h2>Admin Functions</h2>
        <div>
            <input type="url" id="urlInput" placeholder="Enter URL to index..." style="width: 60%;">
            <button onclick="indexUrl()">Index Source</button>
        </div>
        <div id="indexResult"></div>

        <script>
            async function sendMessage() {
                const message = document.getElementById('messageInput').value;
                if (!message) return;
                
                const response = await fetch('/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });
                
                const data = await response.json();
                document.getElementById('response').innerHTML = 
                    '<div class="response"><strong>Response:</strong> ' + data.message + '</div>' +
                    (data.context ? '<div class="sources"><strong>Context Used:</strong><br>' + data.context.substring(0, 500) + '...</div>' : '');
            }
            
            async function indexUrl() {
                const url = document.getElementById('urlInput').value;
                if (!url) return;
                
                const response = await fetch('/admin/index', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const data = await response.json();
                document.getElementById('indexResult').innerHTML = 
                    '<div class="response">' + (data.success ? '✅ ' : '❌ ') + data.message + '</div>';
            }
        </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 RAG chatbot server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to test the chatbot`);
});