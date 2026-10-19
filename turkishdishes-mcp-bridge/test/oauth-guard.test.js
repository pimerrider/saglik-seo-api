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
