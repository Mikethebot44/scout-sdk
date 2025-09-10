import { chromium, Browser, Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { 
  DocumentationContent,
  DocumentationPage,
  ProcessingOptions
} from '../types/index.js';
import { IndexingError } from '../types/index.js';

export class WebScrapingService {
  private browser: Browser | null = null;
  private userAgent = 'Mozilla/5.0 (compatible; Scout-SDK/1.0.0; +https://github.com/terragon-labs/scout-sdk)';

  constructor() {}

  /**
   * Initialize the browser for web scraping
   */
  async initialize(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      });
    }
  }

  /**
   * Close browser and cleanup
   */
  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Process documentation from a URL
   */
  async processDocumentation(baseUrl: string, options: ProcessingOptions = {}): Promise<DocumentationContent> {
    await this.initialize();
    
    if (!this.browser) {
      throw new IndexingError('Failed to initialize browser', { baseUrl });
    }

    const {
      maxDepth = 3,
      maxPages = 1000,
      onlyMainContent = true
    } = options;

    const visited = new Set<string>();
    const pages: DocumentationPage[] = [];
    const queue: { url: string; depth: number }[] = [{ url: baseUrl, depth: 0 }];

    try {
      while (queue.length > 0 && pages.length < maxPages) {
        const { url, depth } = queue.shift()!;
        
        if (visited.has(url) || depth > maxDepth) {
          continue;
        }

        visited.add(url);

        try {
          const page = await this.scrapePage(url, onlyMainContent);
          
          if (page) {
            pages.push(page);
            console.log(`Scraped page ${pages.length}/${maxPages}: ${url}`);

            // Extract internal links for further crawling
            if (depth < maxDepth) {
              const links = this.extractInternalLinks(page.content, baseUrl);
              for (const link of links) {
                if (!visited.has(link) && this.isRelevantDocumentationUrl(link, baseUrl)) {
                  queue.push({ url: link, depth: depth + 1 });
                }
              }
            }
          }

          // Small delay to be respectful
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          console.warn(`Failed to scrape ${url}:`, error instanceof Error ? error.message : error);
          continue;
        }
      }

      return {
        url: baseUrl,
        pages: pages.sort((a, b) => a.url.localeCompare(b.url))
      };

    } catch (error) {
      throw new IndexingError(
        `Failed to process documentation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { baseUrl, error }
      );
    }
  }

  /**
   * Scrape a single page
   */
  private async scrapePage(url: string, onlyMainContent: boolean): Promise<DocumentationPage | null> {
    if (!this.browser) {
      throw new IndexingError('Browser not initialized');
    }

    const page = await this.browser.newPage();
    
    try {
      // Set user agent
      await page.setExtraHTTPHeaders({
        'User-Agent': this.userAgent
      });
      
      // Navigate to page with timeout
      await page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: 30000 
      });

      // Get page content
      const content = await page.content();
      
      // Extract title
      const title = await page.title();

      // Process content
      const processedContent = onlyMainContent 
        ? this.extractMainContent(content, url)
        : this.extractAllContent(content);

      if (!processedContent || processedContent.trim().length < 100) {
        console.warn(`Page too short or empty: ${url}`);
        return null;
      }

      return {
        url,
        title: title || this.extractTitleFromUrl(url),
        content: processedContent,
        headings: this.extractHeadings(content),
        breadcrumbs: this.extractBreadcrumbs(url),
        lastModified: await this.getLastModified(page)
      };

    } finally {
      await page.close();
    }
  }

  /**
   * Extract main content using readability
   */
  private extractMainContent(html: string, url: string): string {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      
      if (article && article.textContent) {
        return this.cleanContent(article.textContent);
      }
      
      // Fallback to extracting from common content selectors
      return this.extractContentBySelectors(html);
      
    } catch (error) {
      console.warn('Readability extraction failed, using fallback method');
      return this.extractContentBySelectors(html);
    }
  }

  /**
   * Extract content by common selectors
   */
  private extractContentBySelectors(html: string): string {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Common content selectors in documentation sites
    const selectors = [
      'main',
      'article',
      '[role="main"]',
      '.content',
      '.documentation',
      '.docs-content',
      '.main-content',
      '#content',
      '.markdown-body',
      '.prose'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent && element.textContent.trim().length > 200) {
        return this.cleanContent(element.textContent);
      }
    }

    // Fallback: use body but remove navigation and footer
    const body = document.body;
    if (body) {
      // Remove navigation elements
      const navElements = body.querySelectorAll('nav, .nav, .navigation, header, footer, .sidebar, .menu');
      navElements.forEach(el => el.remove());
      
      return this.cleanContent(body.textContent || '');
    }

    return '';
  }

  /**
   * Extract all content (less selective)
   */
  private extractAllContent(html: string): string {
    const dom = new JSDOM(html);
    const body = dom.window.document.body;
    
    if (body) {
      // Remove script and style elements
      const scriptsAndStyles = body.querySelectorAll('script, style, noscript');
      scriptsAndStyles.forEach(el => el.remove());
      
      return this.cleanContent(body.textContent || '');
    }
    
    return '';
  }

  /**
   * Clean extracted content
   */
  private cleanContent(content: string): string {
    return content
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/\n\s*\n/g, '\n') // Remove empty lines
      .trim();
  }

  /**
   * Extract headings from HTML
   */
  private extractHeadings(html: string): string[] {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    const headings: string[] = [];
    const headingElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    
    headingElements.forEach(heading => {
      const text = heading.textContent?.trim();
      if (text && text.length > 0) {
        headings.push(text);
      }
    });
    
    return headings;
  }

  /**
   * Extract internal links from content
   */
  private extractInternalLinks(content: string, baseUrl: string): string[] {
    const dom = new JSDOM(`<div>${content}</div>`);
    const document = dom.window.document;
    
    const links: string[] = [];
    const linkElements = document.querySelectorAll('a[href]');
    
    linkElements.forEach(link => {
      const href = link.getAttribute('href');
      if (href) {
        try {
          const absoluteUrl = new URL(href, baseUrl).toString();
          links.push(absoluteUrl);
        } catch (error) {
          // Invalid URL, skip
        }
      }
    });
    
    return [...new Set(links)]; // Remove duplicates
  }

  /**
   * Check if URL is relevant for documentation crawling
   */
  private isRelevantDocumentationUrl(url: string, baseUrl: string): boolean {
    const baseHost = new URL(baseUrl).hostname;
    const linkHost = new URL(url).hostname;
    
    // Must be same host or subdomain
    if (!linkHost.endsWith(baseHost) && linkHost !== baseHost) {
      return false;
    }

    // Skip common non-documentation paths
    const skipPatterns = [
      '/api/', '/login', '/logout', '/signup', '/register',
      '/download', '/pricing', '/contact', '/about',
      '.pdf', '.zip', '.tar', '.gz', '.exe',
      '#', '?', 'javascript:', 'mailto:'
    ];

    const urlLower = url.toLowerCase();
    return !skipPatterns.some(pattern => urlLower.includes(pattern));
  }

  /**
   * Extract title from URL as fallback
   */
  private extractTitleFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split('/').filter(s => s.length > 0);
      
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        return lastSegment.replace(/[-_]/g, ' ').replace(/\.\w+$/, '');
      }
      
      return new URL(url).hostname;
    } catch (error) {
      return 'Documentation Page';
    }
  }

  /**
   * Extract breadcrumbs from URL path
   */
  private extractBreadcrumbs(url: string): string[] {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split('/').filter(s => s.length > 0);
      
      return segments.map(segment => 
        segment.replace(/[-_]/g, ' ')
              .replace(/\.\w+$/, '')
              .split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ')
      );
    } catch (error) {
      return [];
    }
  }

  /**
   * Get last modified date from page
   */
  private async getLastModified(page: Page): Promise<string | undefined> {
    try {
      // Try to find last modified date in meta tags or content
      const lastModified = await page.evaluate(() => {
        // Check meta tags
        const metaModified = document.querySelector('meta[property="article:modified_time"], meta[name="last-modified"]');
        if (metaModified) {
          return metaModified.getAttribute('content');
        }

        // Check for common text patterns
        const bodyText = document.body.textContent || '';
        const dateRegex = /(?:last\s+(?:updated|modified)|updated\s+on|modified\s+on):\s*([^\n,]+)/i;
        const match = bodyText.match(dateRegex);
        
        return match ? match[1].trim() : undefined;
      });

      return lastModified || undefined;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Health check for web scraping service
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.initialize();
      return this.browser !== null;
    } catch (error) {
      console.error('Web scraping service health check failed:', error);
      return false;
    }
  }

  /**
   * Get robots.txt for a domain
   */
  async getRobotsTxt(baseUrl: string): Promise<string | null> {
    try {
      const robotsUrl = new URL('/robots.txt', baseUrl).toString();
      const response = await fetch(robotsUrl);
      
      if (response.ok) {
        return await response.text();
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if URL is allowed by robots.txt
   */
  async isAllowedByRobots(url: string, userAgent = '*'): Promise<boolean> {
    try {
      const robotsTxt = await this.getRobotsTxt(url);
      
      if (!robotsTxt) {
        return true; // If no robots.txt, assume allowed
      }

      // Simple robots.txt parsing (could be improved)
      const lines = robotsTxt.split('\n').map(line => line.trim());
      let relevantUserAgent = false;
      let allowed = true;

      for (const line of lines) {
        if (line.startsWith('User-agent:')) {
          const agent = line.substring(11).trim();
          relevantUserAgent = (agent === '*' || agent === userAgent);
        } else if (relevantUserAgent && line.startsWith('Disallow:')) {
          const disallowPath = line.substring(9).trim();
          if (disallowPath && url.includes(disallowPath)) {
            allowed = false;
          }
        } else if (relevantUserAgent && line.startsWith('Allow:')) {
          const allowPath = line.substring(6).trim();
          if (allowPath && url.includes(allowPath)) {
            allowed = true;
          }
        }
      }

      return allowed;
    } catch (error) {
      console.warn('Error checking robots.txt, assuming allowed:', error);
      return true;
    }
  }
}

// Add missing types for documentation processing
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