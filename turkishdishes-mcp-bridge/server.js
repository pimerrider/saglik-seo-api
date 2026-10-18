import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 3000);
const API_BASE = 'https://saglik-seo-api-1.onrender.com';
const BRIDGE_TOKEN = process.env.MCP_BRIDGE_TOKEN;
if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 32) throw new Error('Set MCP_BRIDGE_TOKEN (32+ characters)');
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
app.use(express.json({ limit: '32kb' }));

function authed(req) {
  const auth = req.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(auth.slice(7));
  const expected = Buffer.from(BRIDGE_TOKEN);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function requireAuth(req, res, next) {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function upstream(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const result = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await result.text();
    if (!result.ok) throw new Error('Upstream returned HTTP ' + result.status);
    try { return JSON.parse(data); } catch { throw new Error('Upstream response is not JSON'); }
  } finally {
    clearTimeout(timer);
  }
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
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP error' }, id: null });
    }
  }
});
app.listen(PORT, '0.0.0.0', () => console.log('TurkishDishes MCP bridge listening'));
