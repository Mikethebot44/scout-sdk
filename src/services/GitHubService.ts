import { Octokit } from '@octokit/rest';
import { 
  GitHubUrlInfo, 
  GitHubFile, 
  GitHubContent, 
  ProcessingOptions,
  OpenRAGConfig
} from '../types/index.js';
import { IndexingError } from '../types/index.js';

// Define GitHub-specific types for the SDK
interface GitHubError extends Error {
  status?: number;
}

export class GitHubService {
  private octokit: Octokit;
  private rateLimit: {
    remaining: number;
    reset: Date;
  } = { remaining: 5000, reset: new Date() };

  constructor(config: OpenRAGConfig) {
    this.octokit = new Octokit({
      auth: config.github?.token, // Optional token for higher rate limits
      userAgent: 'Scout-SDK/1.0.0'
    });
  }

  /**
   * Parse GitHub URL to extract repository information
   */
  parseGitHubUrl(url: string): GitHubUrlInfo {
    const patterns = [
      // https://github.com/owner/repo
      /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/?$/,
      // https://github.com/owner/repo/tree/branch
      /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)\/?$/,
      // https://github.com/owner/repo/tree/branch/path
      /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)\/(.+)$/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return {
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''), // Remove .git suffix if present
          branch: match[3] || 'main',
          path: match[4] || ''
        };
      }
    }

    throw new IndexingError(`Invalid GitHub URL format: ${url}`);
  }

  /**
   * Process a GitHub repository and return structured content
   */
  async processRepository(url: string, options: ProcessingOptions = {}): Promise<GitHubContent> {
    const urlInfo = this.parseGitHubUrl(url);
    
    try {
      // Verify repository exists and get default branch
      const repoInfo = await this.getRepositoryInfo(urlInfo.owner, urlInfo.repo);
      const branch = urlInfo.branch === 'main' ? repoInfo.default_branch : urlInfo.branch;
      
      // Get file tree
      const files = await this.getRepositoryContent(
        urlInfo.owner,
        urlInfo.repo,
        urlInfo.path,
        branch,
        options
      );

      return {
        url,
        repository: `${urlInfo.owner}/${urlInfo.repo}`,
        branch,
        files
      };
    } catch (error) {
      if (error instanceof IndexingError) {
        throw error;
      }
      
      throw new IndexingError(
        `Failed to process repository: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { url, urlInfo, error }
      );
    }
  }

  /**
   * Get repository information
   */
  private async getRepositoryInfo(owner: string, repo: string) {
    await this.checkRateLimit();
    
    try {
      const { data } = await this.octokit.rest.repos.get({
        owner,
        repo
      });
      
      this.updateRateLimit(this.octokit.rest.repos.get.endpoint.DEFAULTS.headers);
      return data;
    } catch (error: any) {
      if (error.status === 404) {
        throw new IndexingError(`Repository ${owner}/${repo} not found or is private`);
      }
      if (error.status === 403) {
        throw new IndexingError(`Access denied to repository ${owner}/${repo}. Check permissions or provide a GitHub token.`);
      }
      
      throw new IndexingError(`Failed to get repository info: ${error.message}`, { owner, repo, status: error.status });
    }
  }

  /**
   * Get repository content recursively
   */
  private async getRepositoryContent(
    owner: string,
    repo: string,
    path: string = '',
    branch: string,
    options: ProcessingOptions
  ): Promise<GitHubFile[]> {
    await this.checkRateLimit();

    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: branch
      });

      this.updateRateLimit(this.octokit.rest.repos.getContent.endpoint.DEFAULTS.headers);

      if (Array.isArray(data)) {
        // Directory listing
        return await this.processDirectoryListing(data, owner, repo, branch, options);
      } else if (data.type === 'file') {
        // Single file
        const file = await this.processFile(data, options);
        return file ? [file] : [];
      } else {
        // Submodule or other type - skip
        return [];
      }
    } catch (error: any) {
      if (error.status === 404) {
        console.warn(`Path not found: ${path}`);
        return [];
      }
      
      throw new IndexingError(
        `Failed to get repository content: ${error.message}`,
        { owner, repo, path, branch, status: error.status }
      );
    }
  }

  /**
   * Process directory listing recursively
   */
  private async processDirectoryListing(
    items: any[],
    owner: string,
    repo: string,
    branch: string,
    options: ProcessingOptions
  ): Promise<GitHubFile[]> {
    const files: GitHubFile[] = [];
    const directories: string[] = [];

    // Separate files and directories
    for (const item of items) {
      if (item.type === 'file') {
        if (this.shouldIncludeFile(item.name, options)) {
          const file = await this.processFile(item, options);
          if (file) {
            files.push(file);
          }
        }
      } else if (item.type === 'dir' && !this.isExcludedDirectory(item.name, options)) {
        directories.push(item.path);
      }
    }

    // Process subdirectories
    for (const dirPath of directories) {
      const subFiles = await this.getRepositoryContent(owner, repo, dirPath, branch, options);
      files.push(...subFiles);
    }

    return files;
  }

  /**
   * Process a single file
   */
  private async processFile(fileData: any, options: ProcessingOptions): Promise<GitHubFile | null> {
    // Check file size
    if (fileData.size > (options.maxFileSize || 1048576)) {
      console.warn(`Skipping large file: ${fileData.path} (${fileData.size} bytes)`);
      return null;
    }

    try {
      // Get file content
      const content = await this.getFileContent(fileData.download_url);
      
      return {
        path: fileData.path,
        content,
        sha: fileData.sha,
        size: fileData.size,
        language: this.detectLanguage(fileData.name),
        downloadUrl: fileData.download_url
      };
    } catch (error) {
      console.warn(`Failed to fetch file content for ${fileData.path}:`, error);
      return null;
    }
  }

  /**
   * Download file content from GitHub
   */
  private async getFileContent(downloadUrl: string): Promise<string> {
    try {
      const response = await fetch(downloadUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      
      // Check if content is binary (simple heuristic)
      if (this.isBinaryContent(content)) {
        throw new Error('Binary content detected');
      }

      return content;
    } catch (error) {
      throw new IndexingError(
        `Failed to download file content: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { downloadUrl, error }
      );
    }
  }

  /**
   * Check if file should be included based on patterns
   */
  private shouldIncludeFile(filename: string, options: ProcessingOptions): boolean {
    const { includePatterns, excludePatterns } = options;

    // Check exclude patterns first
    if (excludePatterns && excludePatterns.length > 0) {
      for (const pattern of excludePatterns) {
        if (this.matchesPattern(filename, pattern)) {
          return false;
        }
      }
    }

    // Check include patterns
    if (includePatterns && includePatterns.length > 0) {
      return includePatterns.some(pattern => this.matchesPattern(filename, pattern));
    }

    // Default: include common code files, exclude common non-code files
    const codeExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h',
      '.cs', '.php', '.rb', '.go', '.rs', '.kt', '.swift', '.scala',
      '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.xml',
      '.css', '.scss', '.sass', '.less', '.html', '.vue', '.svelte'
    ];

    const excludeExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf',
      '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'
    ];

    const ext = '.' + filename.split('.').pop()?.toLowerCase();
    
    if (excludeExtensions.includes(ext)) {
      return false;
    }

    return codeExtensions.includes(ext) || filename === 'README' || filename === 'LICENSE';
  }

  /**
   * Check if directory should be excluded
   */
  private isExcludedDirectory(dirname: string, options: ProcessingOptions): boolean {
    const defaultExcludes = [
      'node_modules', '.git', '.svn', '.hg', 'build', 'dist',
      'target', 'bin', 'obj', '.vscode', '.idea', '__pycache__',
      '.pytest_cache', 'coverage', '.nyc_output'
    ];

    if (defaultExcludes.includes(dirname)) {
      return true;
    }

    if (options.excludePatterns) {
      return options.excludePatterns.some(pattern => this.matchesPattern(dirname, pattern));
    }

    return false;
  }

  /**
   * Simple glob pattern matching
   */
  private matchesPattern(filename: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\*\*/g, '.*') // ** matches anything
      .replace(/\*/g, '[^/]*') // * matches anything except /
      .replace(/\?/g, '.') // ? matches single character
      .replace(/\./g, '\\.'); // Escape dots

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(filename);
  }

  /**
   * Detect programming language from filename
   */
  private detectLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    
    const languageMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'cc': 'cpp',
      'cxx': 'cpp',
      'c': 'c',
      'h': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'kt': 'kotlin',
      'swift': 'swift',
      'scala': 'scala',
      'md': 'markdown',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'toml': 'toml',
      'xml': 'xml',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'sass': 'sass',
      'less': 'less'
    };

    return languageMap[ext || ''] || 'text';
  }

  /**
   * Simple check for binary content
   */
  private isBinaryContent(content: string): boolean {
    // Check for null bytes which are common in binary files
    return content.includes('\0') || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(content.substring(0, 1000));
  }

  /**
   * Check GitHub API rate limit
   */
  private async checkRateLimit(): Promise<void> {
    if (this.rateLimit.remaining <= 10 && new Date() < this.rateLimit.reset) {
      const waitTime = this.rateLimit.reset.getTime() - Date.now();
      console.warn(`Rate limit approaching. Waiting ${Math.ceil(waitTime / 1000)} seconds...`);
      await new Promise(resolve => setTimeout(resolve, waitTime + 1000));
    }
  }

  /**
   * Update rate limit info from response headers
   */
  private updateRateLimit(headers: any): void {
    if (headers && headers['x-ratelimit-remaining']) {
      this.rateLimit.remaining = parseInt(headers['x-ratelimit-remaining']);
      this.rateLimit.reset = new Date(parseInt(headers['x-ratelimit-reset']) * 1000);
    }
  }

  /**
   * Get current rate limit status
   */
  async getRateLimitStatus(): Promise<{
    remaining: number;
    limit: number;
    reset: Date;
  }> {
    try {
      const { data } = await this.octokit.rest.rateLimit.get();
      
      return {
        remaining: data.rate.remaining,
        limit: data.rate.limit,
        reset: new Date(data.rate.reset * 1000)
      };
    } catch (error) {
      // Fallback to cached values
      return {
        remaining: this.rateLimit.remaining,
        limit: 5000,
        reset: this.rateLimit.reset
      };
    }
  }

  /**
   * Health check for GitHub service
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.octokit.rest.rateLimit.get();
      return true;
    } catch (error) {
      console.error('GitHub service health check failed:', error);
      return false;
    }
  }
}

// Add missing types to the types file
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