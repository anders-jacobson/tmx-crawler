/**
 * sitemap.xml / sitemap index parser (also handles gzip-compressed sitemaps).
 * Collects <loc> entries plus any <xhtml:link rel="alternate" hreflang="…"> alternates,
 * which give an authoritative source → target page mapping when slugs are localised.
 */

import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { normalizeUrl } from './url-utils.js';

function looksGzipped(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Parses one sitemap document.
 * @param {string} xml
 * @returns {{ type: 'index' | 'urlset' | 'unknown', sitemaps: string[],
 *   urls: { loc: string, alternates: { hreflang: string, href: string }[] }[] }}
 */
export function parseSitemapXml(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const rootName = $.root().children().first().prop('tagName')?.toLowerCase() ?? '';
  const localName = rootName.includes(':') ? rootName.split(':').pop() : rootName;

  if (localName === 'sitemapindex') {
    const sitemaps = [];
    $.root().children().first().children().each((_, el) => {
      const loc = $(el).children().filter((__, c) => c.tagName?.toLowerCase().endsWith('loc')).first().text().trim();
      if (loc) sitemaps.push(loc);
    });
    return { type: 'index', sitemaps, urls: [] };
  }

  if (localName === 'urlset') {
    const urls = [];
    $.root().children().first().children().each((_, el) => {
      let loc = '';
      const alternates = [];
      $(el).children().each((__, child) => {
        const tag = child.tagName?.toLowerCase() ?? '';
        if (tag === 'loc' || tag.endsWith(':loc')) {
          loc = $(child).text().trim();
        } else if (tag === 'link' || tag.endsWith(':link')) {
          const rel = (child.attribs?.rel ?? '').toLowerCase();
          const hreflang = child.attribs?.hreflang;
          const href = child.attribs?.href;
          if (rel === 'alternate' && hreflang && href) alternates.push({ hreflang, href });
        }
      });
      if (loc) urls.push({ loc, alternates });
    });
    return { type: 'urlset', sitemaps: [], urls };
  }

  return { type: 'unknown', sitemaps: [], urls: [] };
}

/**
 * Loads a sitemap (recursing through sitemap indexes) with per-file error isolation.
 * @param {string} sitemapUrl
 * @param {object} options
 * @param {import('./http-client.js').HttpClient} options.http
 * @param {object} [options.logger]
 * @param {number} [options.maxSitemaps=500]  guards against runaway / cyclic indexes
 * @param {AbortSignal} [options.signal]
 */
export async function loadSitemap(sitemapUrl, { http, logger, maxSitemaps = 500, signal }) {
  const queue = [sitemapUrl];
  const visited = new Set();
  const urls = [];
  const errors = [];

  while (queue.length && visited.size < maxSitemaps) {
    signal?.throwIfAborted();
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const res = await http.get(current, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5', signal });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const xml = looksGzipped(res.bytes) ? gunzipSync(res.bytes).toString('utf8') : res.text();
      const parsed = parseSitemapXml(xml);

      if (parsed.type === 'index') {
        for (const child of parsed.sitemaps) {
          const normalized = normalizeUrl(child, { base: current, dropQuery: false });
          if (normalized && !visited.has(normalized)) queue.push(normalized);
        }
        logger?.info(`Sitemap index with ${parsed.sitemaps.length} child sitemap(s)`, { sitemap: current });
      } else if (parsed.type === 'urlset') {
        urls.push(...parsed.urls);
        logger?.info(`Sitemap with ${parsed.urls.length} URL(s)`, { sitemap: current });
      } else {
        throw new Error('Not a sitemap (expected <urlset> or <sitemapindex>)');
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push({ sitemap: current, error: error.message });
      logger?.warn('Failed to read sitemap; continuing', { sitemap: current, error: error.message });
    }
  }

  if (queue.length) {
    logger?.warn(`Stopped after ${maxSitemaps} sitemap files; ${queue.length} not read`);
  }
  return { urls, sitemapsRead: visited.size, errors };
}
