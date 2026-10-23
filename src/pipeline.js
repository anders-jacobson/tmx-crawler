/**
 * Orchestrates discovery → fetching → alignment → TMX output → verification.
 *
 * Every source page is processed in its own try/catch: a failing page is logged and recorded in
 * the report, and the crawl carries on.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pLimit from 'p-limit';
import { HttpClient, RateLimiter, isHtml } from './http-client.js';
import { RobotsCache } from './robots.js';
import { loadSitemap } from './sitemap.js';
import { extractPage } from './extract.js';
import { alignBlocks, dedupeUnits } from './align.js';
import { DEEPL_MAX_TMX_BYTES, verifyTmx, writeTmx } from './tmx-writer.js';
import {
  compilePatterns,
  hreflangMatches,
  isSameDocument,
  isUnderBase,
  mapByBase,
  normalizeUrl,
  passesFilters,
} from './url-utils.js';
import { silentLogger } from './logger.js';

export const TOOL_NAME = 'site-tmx-aligner';
export const TOOL_VERSION = '1.0.0';

function langMatches(htmlLang, wanted) {
  if (!htmlLang) return true; // pages without a lang attribute are not rejected
  return hreflangMatches(htmlLang, wanted);
}

/**
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {{ logger?: object, signal?: AbortSignal, fetchImpl?: typeof fetch }} [runtime]
 */
export async function runPipeline(config, { logger = silentLogger, signal, fetchImpl } = {}) {
  const startedAt = new Date();
  const { source, target, discovery, http: httpCfg, extraction, alignment, output } = config;

  const limiter = new RateLimiter(httpCfg.delayMs);
  const http = new HttpClient({
    userAgent: httpCfg.userAgent,
    limiter,
    timeoutMs: httpCfg.timeoutMs,
    retries: httpCfg.retries,
    maxBodyBytes: httpCfg.maxBodyBytes,
    backoffBaseMs: httpCfg.backoffBaseMs,
    logger,
    fetchImpl,
  });
  const robots = new RobotsCache({ http, userAgent: httpCfg.userAgent, enabled: httpCfg.respectRobotsTxt, logger });

  const filters = {
    include: compilePatterns(discovery.include, 'discovery.include'),
    exclude: compilePatterns(discovery.exclude, 'discovery.exclude'),
  };

  const invalidSelectors = new Set();
  const extractOptions = {
    contentRoot: extraction.contentRoot,
    anchors: extraction.anchors,
    pageIdentity: extraction.pageIdentity,
    anchorSelector: extraction.anchorSelector,
    anchorAttribute: extraction.anchorAttribute,
    blockSelector: extraction.blockSelector,
    noiseSelectors: extraction.noiseSelectors,
    dynamicSelectors: extraction.dynamicSelectors,
    onInvalidSelector: (selector, error) => {
      if (!invalidSelectors.has(selector)) {
        invalidSelectors.add(selector);
        logger.warn('Ignoring invalid CSS selector', { selector, error: error.message });
      }
    },
  };

  // --- Politeness: honour Crawl-delay of both origins ------------------------------------
  if (httpCfg.respectRobotsTxt) {
    for (const base of [source.baseUrl, target.baseUrl]) {
      const crawlDelay = await robots.crawlDelayMs(base, signal);
      if (crawlDelay > limiter.intervalMs) {
        logger.info(`robots.txt Crawl-delay raises request interval to ${crawlDelay} ms`, { origin: new URL(base).origin });
        limiter.raiseInterval(crawlDelay);
      }
    }
  }

  // --- Discovery ---------------------------------------------------------------------------
  /** sourceUrl → target URLs declared as hreflang alternates in the sitemap */
  const sitemapAlternates = new Map();
  let seeds = [];
  let discoveryMode = 'crawl';
  let sitemapStats = null;

  const inSourceScope = (url) =>
    isUnderBase(url, source.baseUrl) && !isUnderBase(url, target.baseUrl) && passesFilters(url, filters);

  if (discovery.sitemapUrl) {
    try {
      let sitemapUrls = [discovery.sitemapUrl];
      if (discovery.sitemapUrl === 'auto') {
        const declared = await robots.sitemaps(source.baseUrl, signal);
        sitemapUrls = declared.length ? declared : [new URL('/sitemap.xml', source.baseUrl).href];
        logger.info(`Sitemap auto-discovery: ${sitemapUrls.join(', ')}`);
      }
      const sitemap = { urls: [], sitemapsRead: 0, errors: [] };
      for (const url of sitemapUrls) {
        const result = await loadSitemap(url, { http, logger, signal });
        sitemap.urls.push(...result.urls);
        sitemap.sitemapsRead += result.sitemapsRead;
        sitemap.errors.push(...result.errors);
      }
      sitemapStats = { sitemapsRead: sitemap.sitemapsRead, urlsListed: sitemap.urls.length, errors: sitemap.errors };
      for (const entry of sitemap.urls) {
        const loc = normalizeUrl(entry.loc, { dropQuery: discovery.dropQuery });
        if (!loc || !inSourceScope(loc)) continue;
        seeds.push(loc);
        const alternates = entry.alternates
          .filter((alt) => hreflangMatches(alt.hreflang, target.hreflang ?? target.lang))
          .map((alt) => normalizeUrl(alt.href, { base: loc, dropQuery: discovery.dropQuery }))
          .filter(Boolean);
        if (alternates.length) sitemapAlternates.set(loc, alternates);
      }
      seeds = [...new Set(seeds)];
      if (seeds.length) {
        discoveryMode = 'sitemap';
        logger.info(`Sitemap yielded ${seeds.length} source URL(s) under ${source.baseUrl}`);
      } else {
        logger.warn('Sitemap yielded no URLs under the source base; falling back to recursive crawl');
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn('Sitemap discovery failed; falling back to recursive crawl', { error: error.message });
    }
  }
  if (discoveryMode === 'crawl') seeds = [source.baseUrl];
  if (discoveryMode === 'sitemap' && discovery.order === 'shallow-first') {
    // Sitemaps often list thousands of near-identical leaf pages first (videos, downloads).
    // Visiting section and landing pages first makes small --max-pages samples representative.
    const depth = (url) => new URL(url).pathname.split('/').filter(Boolean).length;
    seeds.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  }
  const followLinks = discovery.followLinks ?? discoveryMode === 'crawl';

  // --- Crawl -------------------------------------------------------------------------------
  const limit = pLimit(httpCfg.concurrency);
  const seen = new Set();
  const pending = new Set();
  const pages = [];
  const counters = {
    sourcePagesFetched: 0,
    targetPagesFetched: 0,
    pagePairsAligned: 0,
    pagesFailed: 0,
    pagesSkipped: 0,
  };

  const record = (page) => {
    pages.push(page);
    const label = page.status === 'aligned' ? 'OK  ' : page.status === 'error' ? 'FAIL' : 'SKIP';
    const detail = page.status === 'aligned' ? `${page.units.length} unit(s)` : page.reason;
    const message = `[${pages.length}/${seen.size}] ${label} ${page.sourceUrl} – ${detail}`;
    if (page.status === 'error') logger.error(message);
    else logger.info(message);
  };

  const enqueue = (url, depth) => {
    if (seen.has(url) || seen.size >= discovery.maxPages || signal?.aborted) return;
    seen.add(url);
    const task = limit(() => processSourcePage(url, depth));
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => {});
  };

  const targetCandidates = (sourceUrl, finalSourceUrl, page) => {
    const candidates = [];
    const fromSitemap = sitemapAlternates.get(sourceUrl) ?? sitemapAlternates.get(finalSourceUrl) ?? [];
    const fromPage = page.alternates
      .filter((alt) => hreflangMatches(alt.hreflang, target.hreflang ?? target.lang))
      .map((alt) => normalizeUrl(alt.href, { base: finalSourceUrl, dropQuery: discovery.dropQuery }))
      .filter((url) => url && isUnderBase(url, target.baseUrl));
    const byBase = mapByBase(finalSourceUrl, source.baseUrl, target.baseUrl);

    if (alignment.mapping === 'auto' || alignment.mapping === 'hreflang') {
      candidates.push(...fromSitemap.filter((url) => isUnderBase(url, target.baseUrl)), ...fromPage);
    }
    if ((alignment.mapping === 'auto' || alignment.mapping === 'path') && byBase) candidates.push(byBase);
    return [...new Set(candidates)].slice(0, 3);
  };

  const identity = extraction.pageIdentity;

  /**
   * Fetches target candidates in order and returns the first one that is a valid counterpart:
   * HTTP 200 HTML, no redirect elsewhere, declared in the target language, the same page id as
   * the source page and an actual target-language content version (not a CMS fallback).
   */
  async function fetchTarget(candidates, srcPage) {
    const attempts = [];
    for (const url of candidates) {
      if (!(await robots.isAllowed(url, signal))) {
        attempts.push(`${url}: disallowed by robots.txt`);
        continue;
      }
      const res = await http.get(url, { acceptLanguage: `${target.lang},*;q=0.1`, signal });
      counters.targetPagesFetched += 1;
      if (res.status !== 200) {
        attempts.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      if (!isHtml(res.contentType)) {
        attempts.push(`${url}: not HTML (${res.contentType})`);
        continue;
      }
      if (res.redirected && !isSameDocument(res.url, url)) {
        const allowed = alignment.allowTargetRedirects
          && isUnderBase(res.url, target.baseUrl)
          && !isSameDocument(res.url, target.baseUrl);
        if (!allowed) {
          attempts.push(`${url}: redirected to ${res.url}`);
          continue;
        }
      }
      const finalUrl = normalizeUrl(res.url, { dropQuery: discovery.dropQuery }) ?? url;
      const tgtPage = extractPage(res.text(), { ...extractOptions, baseUrl: finalUrl });

      if (extraction.checkHtmlLang && !langMatches(tgtPage.lang, target.lang)) {
        attempts.push(`${url}: <html lang="${tgtPage.lang}"> does not match "${target.lang}"`);
        continue;
      }
      if (identity) {
        if (srcPage.pageId && tgtPage.pageId && srcPage.pageId !== tgtPage.pageId) {
          attempts.push(`${url}: different page (page id ${tgtPage.pageId}, source has ${srcPage.pageId})`);
          continue;
        }
        if (identity.required && (!srcPage.pageId || !tgtPage.pageId)) {
          attempts.push(`${url}: page id missing (source ${srcPage.pageId ?? '-'}, target ${tgtPage.pageId ?? '-'})`);
          continue;
        }
        if (tgtPage.contentLanguage && !hreflangMatches(tgtPage.contentLanguage, target.lang)) {
          attempts.push(`${url}: no ${target.lang} version – the CMS served the "${tgtPage.contentLanguage}" content`);
          continue;
        }
      }
      return { res, page: tgtPage, url: finalUrl, attempts };
    }
    return { res: null, page: null, url: null, attempts };
  }

  async function processSourcePage(sourceUrl, depth) {
    if (signal?.aborted) return;
    const page = { sourceUrl, targetUrl: null, depth, status: 'skipped', reason: null, units: [], stats: null };
    try {
      if (!(await robots.isAllowed(sourceUrl, signal))) {
        page.reason = 'source disallowed by robots.txt';
        counters.pagesSkipped += 1;
        return record(page);
      }

      const srcRes = await http.get(sourceUrl, { acceptLanguage: `${source.lang},*;q=0.1`, signal });
      if (srcRes.status !== 200) {
        page.reason = `source HTTP ${srcRes.status}`;
        counters.pagesSkipped += 1;
        return record(page);
      }
      if (!isHtml(srcRes.contentType)) {
        page.reason = `source not HTML (${srcRes.contentType})`;
        counters.pagesSkipped += 1;
        return record(page);
      }
      counters.sourcePagesFetched += 1;

      const finalSourceUrl = normalizeUrl(srcRes.url, { dropQuery: discovery.dropQuery }) ?? sourceUrl;
      if (finalSourceUrl !== sourceUrl) {
        if (!isUnderBase(finalSourceUrl, source.baseUrl) || isUnderBase(finalSourceUrl, target.baseUrl)) {
          page.reason = `source redirected outside scope to ${finalSourceUrl}`;
          counters.pagesSkipped += 1;
          return record(page);
        }
        if (seen.has(finalSourceUrl) && !isSameDocument(finalSourceUrl, sourceUrl)) {
          page.reason = `source redirected to already queued ${finalSourceUrl}`;
          counters.pagesSkipped += 1;
          return record(page);
        }
        seen.add(finalSourceUrl);
      }

      const srcPage = extractPage(srcRes.text(), { ...extractOptions, baseUrl: finalSourceUrl });

      if (followLinks && depth < discovery.maxDepth) {
        for (const href of srcPage.links) {
          const link = normalizeUrl(href, { base: finalSourceUrl, dropQuery: discovery.dropQuery });
          if (link && inSourceScope(link)) enqueue(link, depth + 1);
        }
      }

      if (extraction.checkHtmlLang && !langMatches(srcPage.lang, source.lang)) {
        page.reason = `source <html lang="${srcPage.lang}"> does not match "${source.lang}"`;
        counters.pagesSkipped += 1;
        return record(page);
      }
      page.sourcePageId = srcPage.pageId;
      if (identity && srcPage.contentLanguage && !hreflangMatches(srcPage.contentLanguage, source.lang)) {
        page.reason = `source is the "${srcPage.contentLanguage}" content version, not "${source.lang}"`;
        counters.pagesSkipped += 1;
        return record(page);
      }

      const candidates = targetCandidates(sourceUrl, finalSourceUrl, srcPage);
      if (!candidates.length) {
        page.reason = 'no target URL could be derived';
        counters.pagesSkipped += 1;
        return record(page);
      }

      const { page: tgtPage, url: targetUrl, attempts } = await fetchTarget(candidates, srcPage);
      if (!tgtPage) {
        page.targetUrl = candidates[0];
        page.reason = `no valid target page (${attempts.join('; ')})`;
        counters.pagesSkipped += 1;
        return record(page);
      }
      page.targetUrl = targetUrl;
      page.targetPageId = tgtPage.pageId;

      const { pairs, stats, rejectedPairs } = alignBlocks(srcPage.blocks, tgtPage.blocks, {
        ...alignment,
        sourceLang: source.lang,
        targetLang: target.lang,
      });
      page.stats = stats;
      page.units = pairs.map((pair) => ({ ...pair, sourceUrl: finalSourceUrl, targetUrl: page.targetUrl }));
      page.rejectedPairs = rejectedPairs;
      page.status = 'aligned';
      counters.pagePairsAligned += 1;
      return record(page);
    } catch (error) {
      if (signal?.aborted) {
        page.status = 'aborted';
        page.reason = 'run interrupted';
        return record(page);
      }
      page.status = 'error';
      page.reason = error.message;
      counters.pagesFailed += 1;
      return record(page);
    }
  }

  for (const seed of seeds) enqueue(seed, 0);
  while (pending.size) {
    await Promise.allSettled([...pending]);
  }
  if (seen.size >= discovery.maxPages) {
    logger.warn(`Reached discovery.maxPages (${discovery.maxPages}); some pages were not visited`);
  }

  // --- Merge, de-duplicate, write ------------------------------------------------------------
  pages.sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
  const allUnits = pages.flatMap((page) => page.units.slice().sort((a, b) => a.index - b.index));
  const { units, duplicates, conflicts, conflictSamples } = dedupeUnits(allUnits);

  const rejected = {};
  const samplesPerReason = output.rejectedSamplesPerReason ?? 50;
  const rejectedSamples = {};
  for (const page of pages) {
    for (const [reason, count] of Object.entries(page.stats?.rejected ?? {})) {
      rejected[reason] = (rejected[reason] ?? 0) + count;
    }
    for (const item of page.rejectedPairs ?? []) {
      const bucket = (rejectedSamples[item.reason] ??= []);
      if (bucket.length < samplesPerReason) {
        bucket.push({ ...item, reason: undefined, sourceUrl: page.sourceUrl, targetUrl: page.targetUrl });
      }
    }
  }

  const tmx = await writeTmx(output.file, units, {
    sourceLang: source.lang,
    targetLang: target.lang,
    creationTool: TOOL_NAME,
    creationToolVersion: TOOL_VERSION,
    segtype: output.segtype,
    oTmf: output.oTmf,
    adminLang: output.adminLang,
    dataType: output.dataType,
    includeProvenance: output.includeProvenance,
    now: startedAt,
  });
  const verification = await verifyTmx(output.file, {
    sourceLang: source.lang,
    targetLang: target.lang,
    expectedUnits: tmx.units,
    maxBytes: output.maxBytes ?? DEEPL_MAX_TMX_BYTES,
  });

  const summary = {
    tool: `${TOOL_NAME}/${TOOL_VERSION}`,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    interrupted: Boolean(signal?.aborted),
    source: { baseUrl: source.baseUrl, lang: source.lang },
    target: { baseUrl: target.baseUrl, lang: target.lang },
    discovery: { mode: discoveryMode, followLinks, urlsQueued: seen.size, sitemap: sitemapStats },
    requests: http.requestCount,
    pages: counters,
    segments: {
      alignedBeforeDedup: allUnits.length,
      duplicatesRemoved: duplicates,
      conflictsRemoved: conflicts,
      rejected,
    },
    tmx: {
      file: tmx.path,
      translationUnits: tmx.units,
      bytes: tmx.bytes,
      maxBytes: output.maxBytes ?? DEEPL_MAX_TMX_BYTES,
      withinUploadLimit: tmx.bytes <= (output.maxBytes ?? DEEPL_MAX_TMX_BYTES),
      verification,
    },
  };

  if (output.reportFile) {
    await mkdir(dirname(output.reportFile), { recursive: true });
    const report = {
      summary,
      conflicts: conflictSamples,
      // Up to output.rejectedSamplesPerReason examples per rejection reason, for review/tuning.
      rejected: Object.fromEntries(Object.entries(rejectedSamples).map(([reason, samples]) => [
        reason,
        { total: rejected[reason] ?? samples.length, shown: samples.length, samples },
      ])),
      pages: pages.map(({ units: pageUnits, rejectedPairs: _rejected, ...rest }) => ({ ...rest, units: pageUnits.length })),
    };
    await writeFile(output.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return summary;
}
