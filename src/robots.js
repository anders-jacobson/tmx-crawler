/**
 * robots.txt support (RFC 9309) with one cached fetch per origin.
 *  - 2xx      → parse and obey
 *  - 4xx      → no restrictions
 *  - 5xx/network error → treated as "disallow all" for that origin, as the RFC requires
 */

import robotsParser from 'robots-parser';

export class RobotsCache {
  /** @type {Map<string, Promise<{ parser: any, unreachable: boolean }>>} */
  #byOrigin = new Map();

  /**
   * @param {object} options
   * @param {import('./http-client.js').HttpClient} options.http
   * @param {string} options.userAgent
   * @param {boolean} [options.enabled=true]
   * @param {object} [options.logger]
   */
  constructor({ http, userAgent, enabled = true, logger }) {
    this.http = http;
    this.userAgent = userAgent;
    this.enabled = enabled;
    this.logger = logger;
  }

  #load(origin, signal) {
    if (!this.#byOrigin.has(origin)) {
      this.#byOrigin.set(origin, this.#fetch(origin, signal));
    }
    return this.#byOrigin.get(origin);
  }

  async #fetch(origin, signal) {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const res = await this.http.get(robotsUrl, { accept: 'text/plain,*/*;q=0.5', signal });
      if (res.status >= 200 && res.status < 300) {
        this.logger?.debug('Loaded robots.txt', { robotsUrl });
        return { parser: robotsParser(robotsUrl, res.text()), unreachable: false };
      }
      if (res.status >= 400 && res.status < 500) {
        this.logger?.info(`robots.txt returned ${res.status}; no crawl restrictions apply`, { robotsUrl });
        return { parser: robotsParser(robotsUrl, ''), unreachable: false };
      }
      this.logger?.warn(`robots.txt returned ${res.status}; treating origin as disallowed (RFC 9309)`, { robotsUrl });
      return { parser: null, unreachable: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      this.logger?.warn('robots.txt unreachable; treating origin as disallowed (RFC 9309)', {
        robotsUrl,
        error: error.message,
      });
      return { parser: null, unreachable: true };
    }
  }

  /** @returns {Promise<boolean>} */
  async isAllowed(url, signal) {
    if (!this.enabled) return true;
    const { parser, unreachable } = await this.#load(new URL(url).origin, signal);
    if (unreachable) return false;
    return parser.isAllowed(url, this.userAgent) !== false;
  }

  /** Crawl-delay for the origin in milliseconds, or 0. */
  async crawlDelayMs(url, signal) {
    if (!this.enabled) return 0;
    const { parser } = await this.#load(new URL(url).origin, signal);
    const seconds = parser?.getCrawlDelay(this.userAgent);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  }

  /** Sitemap URLs declared in robots.txt for the origin. */
  async sitemaps(url, signal) {
    const { parser } = await this.#load(new URL(url).origin, signal);
    return parser?.getSitemaps() ?? [];
  }
}
