/**
 * Public API, for use as a library:
 *
 *   import { resolveConfig, runPipeline, createLogger } from 'site-tmx-aligner';
 *   const summary = await runPipeline(resolveConfig({ source: {...}, target: {...} }), { logger: createLogger() });
 */

export { runPipeline, TOOL_NAME, TOOL_VERSION } from './pipeline.js';
export { resolveConfig, loadConfigFile, DEFAULT_CONFIG } from './config.js';
export { createLogger, silentLogger } from './logger.js';
export { extractPage, DEFAULT_NOISE_SELECTORS, DEFAULT_DYNAMIC_SELECTORS, DEFAULT_BLOCK_SELECTOR } from './extract.js';
export { alignBlocks, dedupeUnits, ALIGNMENT_MODES } from './align.js';
export { writeTmx, verifyTmx, sanitizeXmlText, escapeXml, DEEPL_MAX_TMX_BYTES } from './tmx-writer.js';
export { loadSitemap, parseSitemapXml } from './sitemap.js';
export { HttpClient, RateLimiter } from './http-client.js';
export { RobotsCache } from './robots.js';
