import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, RateLimiter, isHtml, parseRetryAfter } from '../src/http-client.js';
import { parseSitemapXml } from '../src/sitemap.js';

test('RateLimiter spaces request starts across concurrent callers', async () => {
  const limiter = new RateLimiter(40);
  const start = Date.now();
  const starts = await Promise.all(Array.from({ length: 5 }, () => limiter.wait().then(() => Date.now() - start)));
  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= 35, `gap ${starts[i] - starts[i - 1]} ms between requests ${i} and ${i + 1}`);
  }
  limiter.raiseInterval(100);
  assert.equal(limiter.intervalMs, 100);
  limiter.raiseInterval(10);
  assert.equal(limiter.intervalMs, 100, 'interval is never lowered');
});

test('parseRetryAfter handles seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  const now = Date.parse('2026-10-23T10:00:00Z');
  assert.equal(parseRetryAfter('Fri, 23 Oct 2026 10:00:30 GMT', now), 30000);
  assert.equal(parseRetryAfter('garbage'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('isHtml', () => {
  assert.ok(isHtml('text/html; charset=utf-8'));
  assert.ok(isHtml('application/xhtml+xml'));
  assert.ok(isHtml(''));
  assert.ok(!isHtml('application/pdf'));
});

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body ?? '', { status: next.status, headers: next.headers ?? {} });
  };
  return { impl, calls };
}

test('HttpClient retries 503 and network errors, then succeeds', async () => {
  const { impl, calls } = fakeFetch([
    { status: 503, headers: { 'retry-after': '0' } },
    new TypeError('fetch failed'),
    { status: 200, body: 'ok', headers: { 'content-type': 'text/html; charset=utf-8' } },
  ]);
  const client = new HttpClient({ userAgent: 'TestAgent/1.0 (+tests)', retries: 3, backoffBaseMs: 1, fetchImpl: impl });
  const res = await client.get('https://example.com/', { acceptLanguage: 'de' });
  assert.equal(res.status, 200);
  assert.equal(res.text(), 'ok');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers['user-agent'], 'TestAgent/1.0 (+tests)');
  assert.equal(calls[0].headers['accept-language'], 'de');
});

test('HttpClient returns 404 without retrying and throws after exhausting network retries', async () => {
  const notFound = fakeFetch([{ status: 404 }]);
  const client = new HttpClient({ userAgent: 'TestAgent/1.0', retries: 3, backoffBaseMs: 1, fetchImpl: notFound.impl });
  assert.equal((await client.get('https://example.com/x')).status, 404);
  assert.equal(notFound.calls.length, 1);

  const down = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
  const client2 = new HttpClient({ userAgent: 'TestAgent/1.0', retries: 1, backoffBaseMs: 1, fetchImpl: down.impl });
  await assert.rejects(client2.get('https://example.com/'), { name: 'HttpError', message: /after 2 attempt/ });
});

test('HttpClient enforces the body size limit and decodes declared charsets', async () => {
  const big = fakeFetch([{ status: 200, body: 'x'.repeat(2048) }]);
  const client = new HttpClient({ userAgent: 'TestAgent/1.0', maxBodyBytes: 1024, fetchImpl: big.impl });
  await assert.rejects(client.get('https://example.com/'), /exceeded 1024 bytes|too large/);

  const latin1 = new Uint8Array([0x47, 0xf6, 0x74, 0x65, 0x62, 0x6f, 0x72, 0x67]); // "Göteborg" in ISO-8859-1
  const enc = fakeFetch([{ status: 200, body: latin1, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }]);
  const client2 = new HttpClient({ userAgent: 'TestAgent/1.0', fetchImpl: enc.impl });
  assert.equal((await client2.get('https://example.com/')).text(), 'Göteborg');
});

test('parseSitemapXml reads url sets with hreflang alternates and sitemap indexes', () => {
  const urlset = parseSitemapXml(`<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
      <url><loc> https://x.com/int/a/ </loc>
        <xhtml:link rel="alternate" hreflang="de-DE" href="https://x.com/de/a-de/"/>
      </url>
      <url><loc>https://x.com/int/b/</loc></url>
    </urlset>`);
  assert.equal(urlset.type, 'urlset');
  assert.deepEqual(urlset.urls, [
    { loc: 'https://x.com/int/a/', alternates: [{ hreflang: 'de-DE', href: 'https://x.com/de/a-de/' }] },
    { loc: 'https://x.com/int/b/', alternates: [] },
  ]);

  const index = parseSitemapXml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://x.com/s1.xml</loc></sitemap><sitemap><loc>https://x.com/s2.xml.gz</loc></sitemap>
  </sitemapindex>`);
  assert.deepEqual(index, { type: 'index', sitemaps: ['https://x.com/s1.xml', 'https://x.com/s2.xml.gz'], urls: [] });

  assert.equal(parseSitemapXml('<html><body>nope</body></html>').type, 'unknown');
});

test('RateLimiter keeps the interval even when the event loop is blocked', async () => {
  const limiter = new RateLimiter(30);
  const starts = [];
  const waiters = Array.from({ length: 4 }, () => limiter.wait().then(() => starts.push(Date.now())));
  // Block the event loop for longer than one interval while timers are pending.
  const until = Date.now() + 80;
  while (Date.now() < until) { /* busy */ }
  await Promise.all(waiters);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= 30, `gap ${starts[i] - starts[i - 1]} ms between requests ${i} and ${i + 1}`);
  }
});

test('RateLimiter: an aborted waiter does not block the queue', async () => {
  const limiter = new RateLimiter(20);
  await limiter.wait();
  const controller = new AbortController();
  const aborted = limiter.wait(controller.signal);
  const next = limiter.wait();
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  await next; // resolves instead of hanging
});
