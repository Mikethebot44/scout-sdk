import { createHash } from 'crypto';
import { 
  ContentChunk,
  GitHubContent,
  GitHubFile,
  DocumentationContent,
  DocumentationPage,
  ProcessingOptions,
  SourceType,
  OpenRAGConfig
} from '../types/index.js';

export class ContentProcessor {
  private maxChunkSize: number;
  private chunkOverlap: number;

  constructor(config: OpenRAGConfig) {
    this.maxChunkSize = config.processing?.maxChunkSize || 8192;
    this.chunkOverlap = config.processing?.chunkOverlap || 200;
  }

  /**
   * Process GitHub repository content into chunks
   */
  processGitHubContent(content: GitHubContent): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    
    for (const file of content.files) {
      const fileChunks = this.chunkGitHubFile(file, content.url);
      chunks.push(...fileChunks);
    }

    return chunks;
  }

  /**
   * Process documentation content into chunks
   */
  processDocumentationContent(content: DocumentationContent): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    
    for (const page of content.pages) {
      const pageChunks = this.chunkDocumentationPage(page, content.url);
      chunks.push(...pageChunks);
    }

    return chunks;
  }

  /**
   * Chunk a GitHub file based on its type and content
   */
  private chunkGitHubFile(file: GitHubFile, sourceUrl: string): ContentChunk[] {
    const fileType = this.determineFileType(file.path, file.language);
    
    if (fileType === 'readme') {
      return this.chunkMarkdownContent(file.content, {
        id: this.generateChunkId(sourceUrl, file.path, file.sha),
        sourceUrl,
        sourcePath: file.path,
        type: 'readme',
        language: 'markdown',
        size: file.size
      });
    }

    if (this.isCodeFile(file.language)) {
      return this.chunkCodeContent(file.content, {
        id: this.generateChunkId(sourceUrl, file.path, file.sha),
        sourceUrl,
        sourcePath: file.path,
        type: 'code',
        language: file.language,
        size: file.size
      });
    }

    // For other files, treat as text
    return this.chunkTextContent(file.content, {
      id: this.generateChunkId(sourceUrl, file.path, file.sha),
      sourceUrl,
      sourcePath: file.path,
      type: 'code', // Default to code type for repository files
      language: file.language,
      size: file.size
    });
  }

  /**
   * Chunk a documentation page
   */
  private chunkDocumentationPage(page: DocumentationPage, sourceUrl: string): ContentChunk[] {
    const baseChunkInfo = {
      id: this.generateChunkId(sourceUrl, page.url),
      sourceUrl,
      sourcePath: page.url,
      sourceTitle: page.title,
      type: 'documentation' as const,
      size: page.content.length
    };

    // Try to chunk by headings first
    const headingChunks = this.chunkByHeadings(page.content, page.headings, baseChunkInfo);
    
    if (headingChunks.length > 0) {
      return headingChunks;
    }

    // Fallback to regular text chunking
    return this.chunkTextContent(page.content, baseChunkInfo);
  }

  /**
   * Chunk code content intelligently
   */
  private chunkCodeContent(content: string, baseInfo: any): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    const lines = content.split('\n');

    // For small files, return as single chunk
    if (content.length <= this.maxChunkSize) {
      return [{
        id: baseInfo.id,
        content,
        type: baseInfo.type,
        source: {
          url: baseInfo.sourceUrl,
          type: 'github' as SourceType,
          path: baseInfo.sourcePath
        },
        metadata: {
          language: baseInfo.language,
          size: baseInfo.size,
          hash: this.generateContentHash(content)
        }
      }];
    }

    // Try to chunk by functions/classes for supported languages
    if (this.supportsStructuralChunking(baseInfo.language)) {
      const structuralChunks = this.chunkByCodeStructure(content, baseInfo);
      if (structuralChunks.length > 0) {
        return structuralChunks;
      }
    }

    // Fallback to line-based chunking
    return this.chunkByLines(content, lines, baseInfo);
  }

  /**
   * Chunk by code structure (functions, classes, etc.)
   */
  private chunkByCodeStructure(content: string, baseInfo: any): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    const lines = content.split('\n');

    // Simple heuristic-based chunking for common patterns
    let currentChunk: string[] = [];
    let chunkStart = 0;
    let braceLevel = 0;
    let inFunction = false;
    let inClass = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      currentChunk.push(line);

      // Track brace levels
      for (const char of line) {
        if (char === '{') braceLevel++;
        if (char === '}') braceLevel--;
      }

      // Detect function/method/class starts
      if (this.isStructureStart(line, baseInfo.language)) {
        if (currentChunk.length > 1) {
          // Save previous chunk if it exists
          this.addCodeChunk(chunks, currentChunk.slice(0, -1), baseInfo, chunkStart, i - 1);
        }
        currentChunk = [line];
        chunkStart = i;
        inFunction = this.isFunctionStart(line, baseInfo.language);
        inClass = this.isClassStart(line, baseInfo.language);
      }

      // End of function/class when braces return to base level
      if ((inFunction || inClass) && braceLevel === 0 && line.trim().endsWith('}')) {
        this.addCodeChunk(chunks, currentChunk, baseInfo, chunkStart, i);
        currentChunk = [];
        chunkStart = i + 1;
        inFunction = false;
        inClass = false;
      }

      // If chunk gets too large, force split
      if (currentChunk.join('\n').length > this.maxChunkSize) {
        this.addCodeChunk(chunks, currentChunk, baseInfo, chunkStart, i);
        currentChunk = [];
        chunkStart = i + 1;
      }
    }

    // Add remaining content
    if (currentChunk.length > 0) {
      this.addCodeChunk(chunks, currentChunk, baseInfo, chunkStart, lines.length - 1);
    }

    return chunks;
  }

  /**
   * Add a code chunk with proper metadata
   */
  private addCodeChunk(chunks: ContentChunk[], lines: string[], baseInfo: any, startLine: number, endLine: number): void {
    const content = lines.join('\n');
    if (content.trim().length === 0) return;

    chunks.push({
      id: `${baseInfo.id}_${startLine}_${endLine}`,
      content,
      type: baseInfo.type,
      source: {
        url: baseInfo.sourceUrl,
        type: 'github' as SourceType,
        path: baseInfo.sourcePath
      },
      metadata: {
        language: baseInfo.language,
        size: content.length,
        hash: this.generateContentHash(content),
        dependencies: this.extractDependencies(content, baseInfo.language)
      }
    });
  }

  /**
   * Chunk text content by semantic breaks
   */
  private chunkTextContent(content: string, baseInfo: any): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    
    if (content.length <= this.maxChunkSize) {
      return [{
        id: baseInfo.id,
        content,
        type: baseInfo.type,
        source: {
          url: baseInfo.sourceUrl,
          type: 'github' as SourceType,
          path: baseInfo.sourcePath
        },
        metadata: {
          language: baseInfo.language,
          size: baseInfo.size,
          hash: this.generateContentHash(content)
        }
      }];
    }

    // Split by paragraphs first
    const paragraphs = content.split(/\n\s*\n/);
    let currentChunk = '';
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length + this.chunkOverlap <= this.maxChunkSize) {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      } else {
        if (currentChunk) {
          chunks.push(this.createTextChunk(currentChunk, baseInfo, chunkIndex++));
        }
        
        // Handle oversized paragraphs
        if (paragraph.length > this.maxChunkSize) {
          const subChunks = this.splitLongText(paragraph, this.maxChunkSize);
          for (const subChunk of subChunks) {
            chunks.push(this.createTextChunk(subChunk, baseInfo, chunkIndex++));
          }
          currentChunk = '';
        } else {
          currentChunk = paragraph;
        }
      }
    }

    if (currentChunk) {
      chunks.push(this.createTextChunk(currentChunk, baseInfo, chunkIndex));
    }

    return chunks;
  }

  /**
   * Chunk markdown content by headings
   */
  private chunkMarkdownContent(content: string, baseInfo: any): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    const lines = content.split('\n');
    
    let currentChunk: string[] = [];
    let currentHeading = '';
    let chunkIndex = 0;

    for (const line of lines) {
      // Check if line is a heading
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      
      if (headingMatch) {
        // Save previous chunk
        if (currentChunk.length > 0) {
          const chunkContent = currentChunk.join('\n');
          chunks.push({
            id: `${baseInfo.id}_${chunkIndex++}`,
            content: chunkContent,
            type: baseInfo.type,
            source: {
              url: baseInfo.sourceUrl,
              type: 'github' as SourceType,
              path: baseInfo.sourcePath
            },
            metadata: {
              language: baseInfo.language,
              size: chunkContent.length,
              hash: this.generateContentHash(chunkContent),
              section: currentHeading,
              headingLevel: headingMatch[1].length
            }
          });
        }
        
        currentHeading = headingMatch[2];
        currentChunk = [line];
      } else {
        currentChunk.push(line);
        
        // If chunk gets too large, force split
        if (currentChunk.join('\n').length > this.maxChunkSize) {
          const chunkContent = currentChunk.join('\n');
          chunks.push({
            id: `${baseInfo.id}_${chunkIndex++}`,
            content: chunkContent,
            type: baseInfo.type,
            source: {
              url: baseInfo.sourceUrl,
              type: 'github' as SourceType,
              path: baseInfo.sourcePath
            },
            metadata: {
              language: baseInfo.language,
              size: chunkContent.length,
              hash: this.generateContentHash(chunkContent),
              section: currentHeading
            }
          });
          
          currentChunk = [];
        }
      }
    }

    // Add remaining content
    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join('\n');
      chunks.push({
        id: `${baseInfo.id}_${chunkIndex}`,
        content: chunkContent,
        type: baseInfo.type,
        source: {
          url: baseInfo.sourceUrl,
          type: 'github' as SourceType,
          path: baseInfo.sourcePath
        },
        metadata: {
          language: baseInfo.language,
          size: chunkContent.length,
          hash: this.generateContentHash(chunkContent),
          section: currentHeading
        }
      });
    }

    return chunks;
  }

  /**
   * Chunk documentation by headings
   */
  private chunkByHeadings(content: string, headings: string[], baseInfo: any): ContentChunk[] {
    if (headings.length === 0) return [];

    const chunks: ContentChunk[] = [];
    const lines = content.split('\n');
    
    let currentChunk: string[] = [];
    let currentHeading = '';
    let chunkIndex = 0;

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Check if this line matches one of our headings
      const matchedHeading = headings.find(heading => 
        trimmedLine === heading || 
        trimmedLine.endsWith(heading) ||
        heading.includes(trimmedLine)
      );

      if (matchedHeading && currentChunk.length > 0) {
        // Save previous section
        const chunkContent = currentChunk.join('\n');
        if (chunkContent.trim().length > 50) { // Only save meaningful chunks
          chunks.push({
            id: `${baseInfo.id}_${chunkIndex++}`,
            content: chunkContent,
            type: baseInfo.type,
            source: {
              url: baseInfo.sourceUrl,
              type: 'documentation' as SourceType,
              path: baseInfo.sourcePath,
              title: baseInfo.sourceTitle
            },
            metadata: {
              size: chunkContent.length,
              hash: this.generateContentHash(chunkContent),
              section: currentHeading
            }
          });
        }
        
        currentHeading = matchedHeading;
        currentChunk = [line];
      } else {
        currentChunk.push(line);
        
        // If chunk gets too large, force split
        if (currentChunk.join('\n').length > this.maxChunkSize) {
          const chunkContent = currentChunk.join('\n');
          chunks.push({
            id: `${baseInfo.id}_${chunkIndex++}`,
            content: chunkContent,
            type: baseInfo.type,
            source: {
              url: baseInfo.sourceUrl,
              type: 'documentation' as SourceType,
              path: baseInfo.sourcePath,
              title: baseInfo.sourceTitle
            },
            metadata: {
              size: chunkContent.length,
              hash: this.generateContentHash(chunkContent),
              section: currentHeading
            }
          });
          
          currentChunk = [];
        }
      }
    }

    // Add remaining content
    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join('\n');
      if (chunkContent.trim().length > 50) {
        chunks.push({
          id: `${baseInfo.id}_${chunkIndex}`,
          content: chunkContent,
          type: baseInfo.type,
          source: {
            url: baseInfo.sourceUrl,
            type: 'documentation' as SourceType,
            path: baseInfo.sourcePath,
            title: baseInfo.sourceTitle
          },
          metadata: {
            size: chunkContent.length,
            hash: this.generateContentHash(chunkContent),
            section: currentHeading
          }
        });
      }
    }

    return chunks;
  }

  /**
   * Chunk by lines (fallback method)
   */
  private chunkByLines(content: string, lines: string[], baseInfo: any): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    let currentLines: string[] = [];
    let chunkIndex = 0;

    for (const line of lines) {
      currentLines.push(line);
      
      if (currentLines.join('\n').length >= this.maxChunkSize) {
        // Try to end at a natural break
        const breakPoint = this.findNaturalBreakPoint(currentLines);
        const chunkLines = currentLines.slice(0, breakPoint + 1);
        const chunkContent = chunkLines.join('\n');
        
        chunks.push({
          id: `${baseInfo.id}_${chunkIndex++}`,
          content: chunkContent,
          type: baseInfo.type,
          source: {
            url: baseInfo.sourceUrl,
            type: 'github' as SourceType,
            path: baseInfo.sourcePath
          },
          metadata: {
            language: baseInfo.language,
            size: chunkContent.length,
            hash: this.generateContentHash(chunkContent)
          }
        });
        
        // Keep overlap
        const overlapStart = Math.max(0, breakPoint + 1 - Math.floor(this.chunkOverlap / 20)); // Approximate lines for overlap
        currentLines = currentLines.slice(overlapStart);
      }
    }

    // Add remaining lines
    if (currentLines.length > 0) {
      const chunkContent = currentLines.join('\n');
      chunks.push({
        id: `${baseInfo.id}_${chunkIndex}`,
        content: chunkContent,
        type: baseInfo.type,
        source: {
          url: baseInfo.sourceUrl,
          type: 'github' as SourceType,
          path: baseInfo.sourcePath
        },
        metadata: {
          language: baseInfo.language,
          size: chunkContent.length,
          hash: this.generateContentHash(chunkContent)
        }
      });
    }

    return chunks;
  }

  /**
   * Create a text chunk
   */
  private createTextChunk(content: string, baseInfo: any, index: number): ContentChunk {
    return {
      id: `${baseInfo.id}_${index}`,
      content,
      type: baseInfo.type,
      source: {
        url: baseInfo.sourceUrl,
        type: 'github' as SourceType,
        path: baseInfo.sourcePath
      },
      metadata: {
        language: baseInfo.language,
        size: content.length,
        hash: this.generateContentHash(content)
      }
    };
  }

  /**
   * Split long text into chunks
   */
  private splitLongText(text: string, maxSize: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + maxSize;
      
      if (end >= text.length) {
        chunks.push(text.substring(start));
        break;
      }

      // Try to find a good break point
      const breakPoint = this.findTextBreakPoint(text, start, end);
      chunks.push(text.substring(start, breakPoint));
      start = breakPoint - this.chunkOverlap;
    }

    return chunks;
  }

  /**
   * Find natural break point for lines
   */
  private findNaturalBreakPoint(lines: string[]): number {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      const line = lines[i].trim();
      
      // Good break points
      if (line === '' || // Empty line
          line === '}' || // End of block
          line.endsWith(';') || // End of statement
          line.startsWith('//') || // Comment
          line.startsWith('/*') || // Comment
          line.startsWith('*') || // Comment
          line.match(/^(export|import|const|let|var|function|class|interface)/)) { // Declarations
        return i;
      }
    }
    
    return lines.length - 1;
  }

  /**
   * Find text break point
   */
  private findTextBreakPoint(text: string, start: number, maxEnd: number): number {
    // Try to break at sentence boundaries
    for (let i = maxEnd - 1; i > start + maxEnd * 0.8; i--) {
      const char = text[i];
      if (char === '.' || char === '!' || char === '?') {
        const next = text[i + 1];
        if (next === ' ' || next === '\n') {
          return i + 1;
        }
      }
    }

    // Try to break at word boundaries
    for (let i = maxEnd - 1; i > start + maxEnd * 0.9; i--) {
      if (text[i] === ' ' || text[i] === '\n') {
        return i;
      }
    }

    return maxEnd;
  }

  /**
   * Determine file type
   */
  private determineFileType(path: string, language: string): 'code' | 'documentation' | 'readme' {
    const filename = path.toLowerCase();
    
    if (filename.includes('readme')) return 'readme';
    if (language === 'markdown') return 'documentation';
    
    return 'code';
  }

  /**
   * Check if file is a code file
   */
  private isCodeFile(language: string): boolean {
    const codeLanguages = [
      'typescript', 'javascript', 'python', 'java', 'cpp', 'c',
      'csharp', 'php', 'ruby', 'go', 'rust', 'kotlin', 'swift', 'scala'
    ];
    
    return codeLanguages.includes(language);
  }

  /**
   * Check if language supports structural chunking
   */
  private supportsStructuralChunking(language: string): boolean {
    return ['typescript', 'javascript', 'python', 'java', 'cpp', 'c', 'csharp'].includes(language);
  }

  /**
   * Check if line is start of a structure
   */
  private isStructureStart(line: string, language: string): boolean {
    return this.isFunctionStart(line, language) || this.isClassStart(line, language);
  }

  /**
   * Check if line is start of a function
   */
  private isFunctionStart(line: string, language: string): boolean {
    const trimmed = line.trim();
    
    switch (language) {
      case 'typescript':
      case 'javascript':
        return /^(export\s+)?(async\s+)?(function|const|let|var)\s+\w+/.test(trimmed) ||
               /^\w+\s*\([^)]*\)\s*:\s*\w+\s*=>/.test(trimmed);
      case 'python':
        return /^def\s+\w+/.test(trimmed);
      case 'java':
      case 'csharp':
        return /^\s*(public|private|protected|static).*\w+\s*\([^)]*\)\s*{/.test(trimmed);
      default:
        return false;
    }
  }

  /**
   * Check if line is start of a class
   */
  private isClassStart(line: string, language: string): boolean {
    const trimmed = line.trim();
    
    switch (language) {
      case 'typescript':
      case 'javascript':
        return /^(export\s+)?(abstract\s+)?class\s+\w+/.test(trimmed);
      case 'python':
        return /^class\s+\w+/.test(trimmed);
      case 'java':
      case 'csharp':
        return /^\s*(public|private|protected)?\s*(abstract\s+)?class\s+\w+/.test(trimmed);
      default:
        return false;
    }
  }

  /**
   * Extract dependencies from code
   */
  private extractDependencies(content: string, language: string): string[] {
    const dependencies: string[] = [];
    const lines = content.split('\n').slice(0, 50); // Only check first 50 lines
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (language === 'typescript' || language === 'javascript') {
        // Import statements
        const importMatch = trimmed.match(/^import\s+.*\s+from\s+['"]([^'"]+)['"]/);
        if (importMatch) {
          dependencies.push(importMatch[1]);
          continue;
        }
        
        // Require statements
        const requireMatch = trimmed.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (requireMatch) {
          dependencies.push(requireMatch[1]);
        }
      } else if (language === 'python') {
        // Import statements
        const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/);
        if (importMatch) {
          dependencies.push(importMatch[1] || importMatch[2]);
        }
      }
    }
    
    return [...new Set(dependencies)]; // Remove duplicates
  }

  /**
   * Generate unique chunk ID
   */
  private generateChunkId(sourceUrl: string, path: string, additional?: string): string {
    const input = `${sourceUrl}:${path}${additional ? ':' + additional : ''}`;
    return createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  /**
   * Generate content hash
   */
  private generateContentHash(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }
}