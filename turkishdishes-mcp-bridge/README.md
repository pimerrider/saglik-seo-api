# TurkishDishes SEO MCP Bridge

Separate Node.js service that connects a ChatGPT MCP client to the existing TurkishDishes SEO REST API without changing its code or deployment.

- MCP endpoint: POST /mcp (Streamable HTTP)
- Health endpoint: GET /health
- Six read-only tools: get_sitemap_urls, suggest_internal_links, article_engine, revision_analysis, site_summary, project_context
- Writing to /project-log deliberately excluded
- Only TurkishDishes target URLs are permitted.
- Bearer token required on every /mcp request: environment variable MCP_BRIDGE_TOKEN (32+ characters).

Render (separate web service): branch turkishdishes-mcp-bridge; build command `cd turkishdishes-mcp-bridge && npm install`; start command `cd turkishdishes-mcp-bridge && npm start`; Node runtime; autoDeploy=no.

Security: Token-protecting this bridge does not secure the existing upstream REST API if it is publicly accessible. Use a private ChatGPT plugin with an API-key credential to connect. Before use verify health, unauthenticated rejection, MCP tools/list, and sitemap and internal-link tool calls. Do not store bearer tokens in GitHub.

The bridge is independently deployed; the main and seo-safety-fix branches must remain unchanged.
