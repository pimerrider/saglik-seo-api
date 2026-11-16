# Sağlıklı Türkiye — isolated read-only MCP bridge

Only for https://saglikliturkiye.net/ . Uses the existing multi-site SEO API read-only sitemap endpoint, falling back to direct public XML. No TurkishDishes service or WordPress writes.

## Deployment
Git branch: saglikturkiye-mcp-isolated
Render build: cd saglikturkiye-mcp && npm install
Render start: cd saglikturkiye-mcp && npm start
Runtime: Node 20+
Env: AUTH0_ALLOWED_SUB (required for MCP access); MCP_RESOURCE_URL must be the exact deployed HTTPS service URL.

Auth0 must issue RS256 access tokens with audience equal to MCP_RESOURCE_URL and scope read:seo. The owner must configure a separate Auth0 API resource for the new service. MCP denies all access without an allowed subject.

Tools: get_sitemap_urls, verify_page, suggest_internal_links.
All operations are read-only. Sitemap membership is not indexability certification; links need semantic editorial review.
No production branch merges, WordPress mutations, or modifications to TurkishDishes bridge.

## November 2026 health-site additions

- `read_article(url, maxChars?)` retrieves public article body text, canonical URL, title and approximate word count (read-only). This is public HTML, not private WordPress content or a WordPress revision history.
- Sitemap retrieval prefers live Rank Math XML and falls back to the upstream SEO API only if necessary. Cache: 10 minutes.
- `data/revision-registry.json` is the durable editorial ledger with an empty initial `records` array. This ledger does **not** update automatically: after a verified review or revision, authorized editors must commit the validated record to this dedicated branch using GitHub, preserving record history.
- Never invent earlier revisions, edit TurkishDishes data, or treat sitemap membership as proof of Google indexing.
- Google Search Console remains unconnected for saglikliturkiye.net until ownership and authorization are verified; do not claim real GSC measurements without a successful query.
