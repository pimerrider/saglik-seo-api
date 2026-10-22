import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 3000);
const API_BASE = 'https://saglik-seo-api-1.onrender.com';
const AUTH0_ISSUER = 'https://dev-r38bhp2ua51avnhr.us.auth0.com/';
const RESOURCE = 'https://turkishdishes-seo-mcp-bridge.onrender.com';
const RESOURCE_METADATA = RESOURCE + '/.well-known/oauth-protected-resource/mcp';
const ALLOWED_SUB = process.env.AUTH0_ALLOWED_SUB;
if (!ALLOWED_SUB || !ALLOWED_SUB.trim()) throw new Error('Set AUTH0_ALLOWED_SUB before OAuth deployment');
const JWKS = createRemoteJWKSet(new URL(AUTH0_ISSUER + '.well-known/jwks.json'));
const AUTHORIZATION_SERVER = AUTH0_ISSUER.slice(0, -1);
const SITE = 'https://turkishdishes.net/';
const SITEMAP = 'https://turkishdishes.net/sitemap_index.xml';

function sitePage(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['turkishdishes.net', 'www.turkishdishes.net'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Only TurkishDishes HTTPS URLs are permitted');
  }
  return url.toString();
}

const app = express();
app.disable('x-powered-by');
// Safe MCP diagnostics: never log Authorization headers, tokens, or request bodies.
app.use('/mcp', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => console.info('mcp_request', JSON.stringify({ method: req.method, status: res.statusCode, elapsedMs: Date.now() - started })));
  next();
});
app.use(express.json({ limit: '32kb' }));

app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  res.json({
    resource: RESOURCE,
    authorization_servers: [AUTHORIZATION_SERVER],
    scopes_supported: ['read:seo'],
    bearer_methods_supported: ['header']
  });
});
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: RESOURCE,
    authorization_servers: [AUTHORIZATION_SERVER],
    scopes_supported: ['read:seo'],
    bearer_methods_supported: ['header']
  });
});

function rejectOAuth(res, status, error, description) {
  const challenge = [
    'Bearer realm="TurkishDishes SEO"',
    'resource_metadata="' + RESOURCE_METADATA + '"',
    'error="' + error + '"',
    'error_description="' + description + '"'
  ].join(', ');
  return res.status(status).set('WWW-Authenticate', challenge).json({ error, error_description: description });
}
async function requireAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) { console.warn('mcp_auth', 'missing_bearer'); return rejectOAuth(res, 401, 'invalid_token', 'Access token required'); }
  try {
    const { payload } = await jwtVerify(auth.slice(7), JWKS, {
      issuer: AUTH0_ISSUER, audience: RESOURCE, algorithms: ['RS256'],
      clockTolerance: 30
    });
    if (typeof payload.sub !== 'string' || payload.sub !== ALLOWED_SUB) {
      console.warn('mcp_auth', 'subject_not_allowed');
      return rejectOAuth(res, 403, 'insufficient_scope', 'Account not authorized');
    }
    const scopes = String(payload.scope || '').split(/\s+/);
    if (!scopes.includes('read:seo')) {
      console.warn('mcp_auth', 'scope_missing');
      return rejectOAuth(res, 403, 'insufficient_scope', 'read:seo permission required');
    }
    console.info('mcp_auth', 'ok');
    req.auth = { subject: payload.sub, scopes };
    return next();
  } catch (err) {
    console.warn('mcp_auth', 'jwt_invalid', err?.code || 'unknown');
    return rejectOAuth(res, 401, 'invalid_token', 'Invalid or expired access token');
  }
}

// Volatile read-only cache: never persist OAuth tokens, GSC payloads, or site data to disk.
// Cached data is explicitly marked. On a transient upstream failure, stale results are
// returned only within the bounded stale window and NEVER described as live/current.
const RESPONSE_CACHE = new Map();
const IN_FLIGHT = new Map();
const BACKOFF_UNTIL = new Map();
const TTL_MS = {
  '/sitemap-urls': 30 * 60_000,
  '/project-context': 10 * 60_000,
  '/internal-link-suggestions-v2': 15 * 60_000,
  '/article-engine': 5 * 60_000,
  '/revision-analysis': 5 * 60_000,
  '/site-summary': 5 * 60_000
};
const STALE_WINDOW_MS = 6 * 60 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 2 * 60_000;
const MAX_CACHE_ENTRIES = 80;

function cacheKey(path, payload) {
  return JSON.stringify([path, payload]);
}
function withCacheMetadata(data, cachedAt, status, cause) {
  return {
    ...data,
    _bridgeCache: {
      status,
      fetchedAt: new Date(cachedAt).toISOString(),
      ageSeconds: Math.max(0, Math.floor((Date.now() - cachedAt) / 1000)),
      ...(cause ? { warning: cause } : {})
    }
  };
}
function trimCache() {
  while (RESPONSE_CACHE.size > MAX_CACHE_ENTRIES) {
    RESPONSE_CACHE.delete(RESPONSE_CACHE.keys().next().value);
  }
}
function fromCache(entry, status, warning) {
  return withCacheMetadata(entry.data, entry.cachedAt, status, warning);
}
async function upstream(path, payload) {
  const key = cacheKey(path, payload);
  const now = Date.now();
  const entry = RESPONSE_CACHE.get(key);
  const ttl = TTL_MS[path] ?? 5 * 60_000;
  if (entry && now - entry.cachedAt < ttl) return fromCache(entry, 'fresh_cache');
  if (IN_FLIGHT.has(key)) return IN_FLIGHT.get(key);

  const task = (async () => {
    const cached = RESPONSE_CACHE.get(key);
    const blockedUntil = BACKOFF_UNTIL.get(path) ?? 0;
    if (Date.now() < blockedUntil) {
      if (cached && Date.now() - cached.cachedAt < STALE_WINDOW_MS) {
        return fromCache(cached, 'stale', 'Upstream HTTP 429 cooldown: not current; revalidation required before publication');
      }
      throw new Error('Upstream HTTP 429 cooldown active; no verified current data available');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const result = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!result.ok) {
        const retryAfter = result.headers.get('retry-after');
        console.warn('upstream_http_error', JSON.stringify({
          endpoint: path,
          status: result.status,
          retryAfter: retryAfter ? retryAfter.slice(0, 50) : null,
          contentType: (result.headers.get('content-type') || '').slice(0, 80),
          server: (result.headers.get('server') || '').slice(0, 60)
        }));
        if (result.status === 429) BACKOFF_UNTIL.set(path, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        throw new Error('Upstream returned HTTP ' + result.status + (retryAfter ? ' (Retry-After: ' + retryAfter.slice(0, 50) + ')' : ''));
      }
      const data = await result.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unexpected upstream JSON shape');
      const fetchedAt = Date.now();
      RESPONSE_CACHE.set(key, { data, cachedAt: fetchedAt });
      trimCache();
      BACKOFF_UNTIL.delete(path);
      return withCacheMetadata(data, fetchedAt, 'live');
    } catch (error) {
      const fallback = RESPONSE_CACHE.get(key);
      if (fallback && Date.now() - fallback.cachedAt < STALE_WINDOW_MS) {
        console.warn('upstream_stale_fallback', JSON.stringify({ endpoint: path, ageSeconds: Math.floor((Date.now() - fallback.cachedAt) / 1000) }));
        return fromCache(fallback, 'stale', 'Upstream unavailable (' + String(error.message || error).slice(0, 90) + '); not current; revalidation required before publication');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  IN_FLIGHT.set(key, task);
  try { return await task; } finally { IN_FLIGHT.delete(key); }
}

function makeServer() {
  const server = new McpServer({ name: 'turkishdishes-seo', version: '0.1.0' });
  function add(name, description, shape, path, normalize) {
    server.tool(name, description, shape, async (args) => {
      try {
        const data = await upstream(path, normalize(args));
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error.message ?? error) }] };
      }
    });
  }
  add('get_sitemap_urls', 'Fetch current TurkishDishes sitemap URLs before internal linking.',
    { maxUrls: z.number().int().positive().max(10000).optional() }, '/sitemap-urls',
    a => ({ sitemapUrl: SITEMAP, ...(a.maxUrls ? { maxUrls: a.maxUrls } : {}) }));
  add('suggest_internal_links', 'Suggest relevant sitemap-confirmed TurkishDishes internal links.',
    { topic: z.string().min(2).max(200), currentUrl: z.string().url().optional(), limit: z.number().int().min(1).max(20).optional() },
    '/internal-link-suggestions-v2',
    a => ({ topic: a.topic, sitemapUrl: SITEMAP, ...(a.currentUrl ? { currentUrl: sitePage(a.currentUrl) } : {}), ...(a.limit ? { limit: a.limit } : {}) }));
  add('article_engine', 'Plan a TurkishDishes article using current GSC and internal-link data.',
    { topic: z.string().min(2).max(200) }, '/article-engine',
    a => ({ topic: a.topic }));
  add('revision_analysis', 'Analyze an existing TurkishDishes page without modifying it.',
    { pageUrl: z.string().url() }, '/revision-analysis',
    a => ({ siteUrl: SITE, sitemapUrl: SITEMAP, pageUrl: sitePage(a.pageUrl) }));
  add('site_summary', 'Read TurkishDishes site SEO overview.',
    {}, '/site-summary', () => ({ siteUrl: SITE, sitemapUrl: SITEMAP }));
  add('project_context', 'Read TurkishDishes editorial context.',
    {}, '/project-context', () => ({}));
  // /project-log intentionally not exposed: it writes project state.
  return server;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'turkishdishes-mcp-bridge' }));
// An HTTP GET without an SSE stream is optional for stateless MCP; advertise unsupported polling as 405.
app.get('/mcp', requireAuth, (_req, res) => res.status(405).set('Allow', 'POST').end());
app.post('/mcp', requireAuth, async (req, res) => {
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp_transport_error', err?.name || 'unknown', err?.message || 'unknown');
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP error' }, id: null });
    }
  }
});
app.listen(PORT, '0.0.0.0', () => console.log('TurkishDishes MCP bridge listening'));
