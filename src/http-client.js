/**
 * Polite HTTP client built on native fetch (Node >= 22):
 * - global minimum interval between requests (RateLimiter), shared by all concurrent workers
 * - per-request timeout, bounded body size, charset-aware decoding
 * - retries with exponential backoff + jitter on network errors and 408/425/429/5xx,
 *   honouring Retry-After
 */

import { setTimeout as sleep } from 'node:timers/promises';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 120_000;

export class HttpError extends Error {
  constructor(message, { url, cause } = {}) {
    super(message, { cause });
    this.name = 'HttpError';
    this.url = url;
  }
}

/**
 * Guarantees at least `intervalMs` between the *start* of two requests, no matter how many
 * workers run concurrently. Slots are reserved synchronously, so callers queue up fairly.
 */
export class RateLimiter {
  #intervalMs;
  #nextSlot = 0;

  constructor(intervalMs = 0) {
    this.#intervalMs = Math.max(0, Number(intervalMs) || 0);
  }

  get intervalMs() {
    return this.#intervalMs;
  }

  /** Raises (never lowers) the interval, e.g. to honour a robots.txt Crawl-delay. */
  raiseInterval(ms) {
    if (Number.isFinite(ms) && ms > this.#intervalMs) this.#intervalMs = ms;
  }

  async wait(signal) {
    const now = Date.now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + this.#intervalMs;
    const delay = slot - now;
    if (delay > 0) await sleep(delay, undefined, { signal });
  }
}

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * @returns {number | null}
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function charsetFromContentType(contentType) {
  const match = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? '');
  return match ? match[1].toLowerCase() : 'utf-8';
}

function decode(bytes, contentType) {
  const charset = charsetFromContentType(contentType);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response body too large (${declared} bytes > ${maxBytes})`);
  }
  if (!response.body) return new Uint8Array(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Response body exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class HttpClient {
  /**
   * @param {object} options
   * @param {string} options.userAgent
   * @param {RateLimiter} options.limiter
   * @param {number} [options.timeoutMs=20000]
   * @param {number} [options.retries=3]
   * @param {number} [options.maxBodyBytes=15MB]
   * @param {number} [options.backoffBaseMs=1000]
   * @param {object} [options.logger]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({
    userAgent,
    limiter,
    timeoutMs = 20_000,
    retries = 3,
    maxBodyBytes = 15 * 1024 * 1024,
    backoffBaseMs = 1000,
    logger,
    fetchImpl = globalThis.fetch,
  }) {
    if (!userAgent) throw new Error('HttpClient requires a descriptive userAgent');
    this.userAgent = userAgent;
    this.limiter = limiter ?? new RateLimiter(0);
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.maxBodyBytes = maxBodyBytes;
    this.backoffBaseMs = backoffBaseMs;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.requestCount = 0;
  }

  /**
   * GET a URL. Resolves with the final response (also for 4xx/5xx after retries are exhausted);
   * rejects with HttpError only for network-level failures after all retries.
   *
   * @param {string} url
   * @param {{ accept?: string, acceptLanguage?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<{ url: string, status: number, ok: boolean, redirected: boolean,
   *   contentType: string, bytes: Uint8Array, text: () => string }>}
   */
  async get(url, { accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', acceptLanguage, signal } = {}) {
    const headers = { 'user-agent': this.userAgent, accept };
    if (acceptLanguage) headers['accept-language'] = acceptLanguage;

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      signal?.throwIfAborted();
      await this.limiter.wait(signal);
      this.requestCount += 1;

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let response;
      try {
        response = await this.fetchImpl(url, { headers, redirect: 'follow', signal: combined });
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        const reason = timeout.aborted ? `timeout after ${this.timeoutMs} ms` : (error.cause?.code ?? error.message);
        if (attempt < this.retries) {
          const wait = this.#backoff(attempt);
          this.logger?.warn(`Network error, retrying in ${wait} ms`, { url, attempt: attempt + 1, reason });
          await sleep(wait, undefined, { signal });
          continue;
        }
        throw new HttpError(`Request failed after ${attempt + 1} attempt(s): ${reason}`, { url, cause: error });
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.retries) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const wait = Math.min(retryAfter ?? this.#backoff(attempt), MAX_RETRY_AFTER_MS);
        await response.body?.cancel().catch(() => {});
        this.logger?.warn(`HTTP ${response.status}, retrying in ${wait} ms`, { url, attempt: attempt + 1 });
        await sleep(wait, undefined, { signal });
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      let bytes;
      try {
        bytes = await readBody(response, this.maxBodyBytes);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new HttpError(error.message, { url, cause: error });
      }
      return {
        url: response.url || url,
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        contentType,
        bytes,
        text: () => decode(bytes, contentType),
      };
    }
    throw new HttpError('Retries exhausted', { url, cause: lastError });
  }

  #backoff(attempt) {
    return Math.round(this.backoffBaseMs * 2 ** attempt + Math.random() * 250);
  }
}

/** True for HTML/XHTML responses (and for servers that omit the header). */
export function isHtml(contentType) {
  return !contentType || /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}
