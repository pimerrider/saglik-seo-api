import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('read-only tool surface remains', () => {
  for (const name of ['get_sitemap_urls','suggest_internal_links','article_engine','revision_analysis','site_summary','project_context']) {
    assert.ok(src.includes("'" + name + "'"), name + ' absent');
  }
  assert.ok(!src.includes("server.tool('project_log'"));
});
test('OAuth discovery and denial gate are present', () => {
  assert.match(src, /oauth-protected-resource\/mcp/);
  assert.match(src, /WWW-Authenticate/);
  assert.match(src, /app\.post\('\/mcp', requireAuth,/);
});
test('JWT verifies issuer, audience, algorithm, scope and authorized subject', () => {
  assert.match(src, /jwtVerify\(/);
  assert.match(src, /issuer: AUTH0_ISSUER, audience: RESOURCE, algorithms: \['RS256'\]/);
  assert.match(src, /payload\.sub !== ALLOWED_SUB/);
  assert.match(src, /scopes\.includes\('read:seo'\)/);
  assert.match(src, /split\(\/\\s\+\/\)/);
});
test('API and sitemap stay pinned to TurkishDishes', () => {
  assert.match(src, /https:\/\/turkishdishes\.net\/sitemap_index\.xml/);
  assert.match(src, /sitePage\(a\.pageUrl\)/);
});

test('rate-limit protection has bounded cache and in-flight deduplication', () => {
  assert.match(src, /const RESPONSE_CACHE = new Map\(\)/);
  assert.match(src, /const IN_FLIGHT = new Map\(\)/);
  assert.match(src, /const BACKOFF_UNTIL = new Map\(\)/);
  assert.match(src, /const MAX_CACHE_ENTRIES = 80/);
  assert.match(src, /RESPONSE_CACHE\.size > MAX_CACHE_ENTRIES/);
  assert.match(src, /if \(IN_FLIGHT\.has\(key\)\)/);
  assert.match(src, /result\.status === 429/);
});
test('stale data is transparently marked and never represented as live', () => {
  assert.match(src, /status: 'stale'/);
  assert.match(src, /revalidation required before publication/);
  assert.match(src, /status,/);
  assert.match(src, /fetchedAt: new Date\(cachedAt\)\.toISOString\(\)/);
  assert.match(src, /const STALE_WINDOW_MS = 6 \* 60 \* 60_000/);
  assert.match(src, /return withCacheMetadata\(data, fetchedAt, 'live'\)/);
});

test('website sitemap fallback is bounded and explicitly source-labeled', () => {
  assert.match(src, /const MAX_SITEMAP_DOCUMENTS = 30/);
  assert.match(src, /const MAX_SITEMAP_URLS = 10_000/);
  assert.match(src, /const SITEMAP_FETCH_TIMEOUT_MS = 12_000/);
  assert.match(src, /verificationSource: 'website_xml'/);
  assert.match(src, /status: 'live_direct_sitemap'/);
  assert.match(src, /Main SEO API unavailable/);
  assert.match(src, /name !== 'get_sitemap_urls'/);
  assert.match(src, /directSitemapVerification\(args\.maxUrls\)/);
});

test('archived sitemap provenance and publication warning are explicit', () => {
  assert.match(src, /sitemap-snapshot\.json/);
  assert.match(src, /status: 'stale_snapshot'/);
  assert.match(src, /verificationSource: 'bundled_snapshot'/);
  assert.match(src, /Archived membership is NOT current/);
  assert.match(src, /snapshotSitemapVerification\(args\.maxUrls\)/);
});
