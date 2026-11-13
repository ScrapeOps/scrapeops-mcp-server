# ScrapeOps MCP Server

A Model Context Protocol (MCP) server that exposes the full capabilities of the [ScrapeOps Proxy API](https://scrapeops.io/) to LLM clients (Cursor, Claude Desktop, VS Code). Enable AI agents to browse the web, bypass anti-bots, render JavaScript, take screenshots, and perform structured data extraction autonomously.

## Features

- 🌐 **Web Browsing** - Browse any webpage with proxy support
- 🌍 **Geo-Targeting** - Access websites from 12+ countries
- 🏠 **Residential/Mobile Proxies** - Higher success rates on challenging sites
- 🤖 **Anti-Bot Bypass** - Multiple bypass levels (Cloudflare, DataDome, PerimeterX, etc.)
- 🖼️ **Screenshots** - Capture visual snapshots of pages
- ⚡ **JavaScript Rendering** - Full headless browser capabilities
- 📊 **Structured Extraction** - LLM-powered data extraction with schemas
- 🔄 **Auto-Extract** - Domain-specific parsers for popular sites
- 🔗 **Link Extraction** - Discover page and asset URLs from any webpage
- 🧭 **Scraping Analysis** - Difficulty scoring, anti-bot detection, JS rendering checks, tech stack, CSS selector stability, legality, page-type classification, data sources, API endpoints, and schema generation

## Installation

### Running with npx

```bash
env SCRAPEOPS_API_KEY=YOUR_API_KEY npx -y @scrapeops/mcp
```

### Manual Installation

```bash
npm install -g @scrapeops/mcp
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SCRAPEOPS_API_KEY` | Yes | Your ScrapeOps API key from [scrapeops.io](https://scrapeops.io/app/login) |

### How It Works

The MCP server uses a **simple, single-request approach**:

1. **Basic Request**: If no options are specified, a basic request is made (URL only)
2. **User-Specified Options**: If options like `render_js`, `residential`, or `premium` are specified, they are used directly
3. **On Failure**: Returns helpful error with suggestions - the AI/user decides what to do next
4. **No Auto-Retry**: The server does not automatically retry with different options - this gives you full control

**Example Flow:**
- You ask: "Scrape https://example.com"
- Server makes basic request (no extra params)
- If it fails (403), returns error with suggestions: "Try with `residential: true`"
- You decide: "OK, scrape it with residential proxy"
- Server makes request with `residential: true`

### Running on Cursor

1. Open Cursor Settings
2. Go to Features > MCP Servers
3. Click "+ Add new global MCP server"
4. Enter the following configuration:

```json
{
  "mcpServers": {
    "@scrapeops/mcp": {
      "command": "npx",
      "args": ["-y", "@scrapeops/mcp"],
      "env": {
        "SCRAPEOPS_API_KEY": "YOUR-API-KEY"
      }
    }
  }
}
```

for development environment

```json
{
    "mcpServers": {
        "@scrapeops/mcp": {
        "url": "http://localhost:8080/mcp",
        "headers": {
            "scrapeops-api-key": "SCRAPEOPS_API_KEY"
        }
        }
    }
}
```

### Running on Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "@scrapeops/mcp": {
      "command": "npx",
      "args": ["-y", "@scrapeops/mcp"],
      "env": {
        "SCRAPEOPS_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

for development environment

Replace `/ABSOLUTE/PATH/TO/scrapeops-mcp-server/dist/index.js` with the absolute path to your local built entry point (run `npm run build` first).

```json
{
  "mcpServers": {
    "scrapeops-mcp": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/scrapeops-mcp-server/dist/index.js"
      ],
      "env": {
        "SCRAPEOPS_API_KEY": "SCRAPEOPS_API_KEY"
      }
    }
  },
  "preferences": {
    "sidebarMode": "chat",
    "coworkScheduledTasksEnabled": false
  }
}
```

### Running on VS Code

Add to your User Settings (JSON) via `Ctrl + Shift + P` → `Preferences: Open User Settings (JSON)`:

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "apiKey",
        "description": "ScrapeOps API Key",
        "password": true
      }
    ],
    "servers": {
      "scrapeops": {
        "command": "npx",
        "args": ["-y", "@scrapeops/mcp"],
        "env": {
          "SCRAPEOPS_API_KEY": "${input:apiKey}"
        }
      }
    }
  }
}
```

### Running on Windsurf

Add to your `./codeium/windsurf/model_config.json`:

```json
{
  "mcpServers": {
    "@scrapeops/mcp": {
      "command": "npx",
      "args": ["-y", "@scrapeops/mcp"],
      "env": {
        "SCRAPEOPS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Running a local HTTP server

You can run the same MCP server over HTTP instead of stdio. This is useful for development. It is not the hosted OAuth server.

**1. Start the server:**

```bash
# Set the port for HTTP mode (required for local server)
export PORT=8080
export SCRAPEOPS_API_KEY=your-api-key-here

# Run the server
npm start
# or if you have the package installed globally
scrapeops-mcp
```

The server exposes Streamable HTTP at `http://localhost:8080/mcp` (or the port specified by `PORT`). This is the only HTTP endpoint: the deprecated HTTP+SSE transport (`/sse`, `/messages`) was removed in 2.0.0.

The server implements MCP protocol revision `2026-07-28` and still answers clients on `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`, over both stdio and HTTP. Over HTTP, 2025-era clients get a plain JSON body (`enableJsonResponse: true`); 2026-era clients may get JSON or `text/event-stream` depending on the exchange. Clients must still send `Accept: application/json, text/event-stream`. Invalid tool arguments come back as a tool result with `isError: true` instead of a JSON-RPC error.

**Note:** If `PORT` is not set, the server runs in stdio mode (for use with `npx` in MCP clients like Cursor). Set `PORT` explicitly to run as an HTTP server.

**2. Configure Cursor to connect to the local server:**

Edit your Cursor MCP configuration file (typically at `~/.cursor/mcp.json` or in Cursor Settings):

```json
{
  "mcpServers": {
    "@scrapeops/mcp": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "scrapeops-api-key": "your-api-key-here"
      }
    }
  }
}
```

**Note:** When using the local HTTP transport, you can pass the API key either:
- Via the `scrapeops-api-key` header in the configuration (as shown above), or
- Via the `SCRAPEOPS_API_KEY` environment variable when starting the server

This local HTTP mode is separate from the hosted remote MCP. It keeps using your API key directly and does not require OAuth.

## Remote MCP

The hosted server is for clients that connect over HTTPS instead of running the npm package, including Claude's remote connector directory.

**Endpoint:** `https://mcp.scrapeops.io/mcp`

Claude users add that URL as a remote MCP connector. The server responds to an unauthenticated request with a `401` and a `WWW-Authenticate` challenge. Claude then:

1. Reads the OAuth protected-resource and authorization-server metadata
2. Registers itself with dynamic client registration
3. Sends the user to the ScrapeOps sign-in and approval page
4. Calls the MCP endpoint with `Authorization: Bearer <token>`

The access token is resolved on the server to that user's ScrapeOps account. The account API key is used for Proxy API calls and is not returned to Claude. Tokens expire, refresh tokens rotate, and reuse of an old refresh token revokes that connection. A user can also revoke every connection at `https://mcp.scrapeops.io/oauth/revoke-access`.

`npx -y @scrapeops/mcp` with `SCRAPEOPS_API_KEY` is unchanged.

## Deployment

The remote server is a separate Node process from the ScrapeOps frontend. Terminate TLS at the load balancer and forward `https://mcp.scrapeops.io` to the container. The process expects `X-Forwarded-Proto: https` in production.

```bash
docker build -t scrapeops-mcp .

# Generate once and reuse across restarts/deployments (do not regenerate each run).
export TOKEN_ENCRYPTION_KEY="$(openssl rand -hex 32)"

docker run --rm -p 8080:8080 \
  -e PUBLIC_BASE_URL=https://mcp.scrapeops.io \
  -e TOKEN_ENCRYPTION_KEY="$TOKEN_ENCRYPTION_KEY" \
  -e SENTRY_DSN=https://key@o0.ingest.sentry.io/0 \
  -v scrapeops-mcp-data:/data \
  scrapeops-mcp
```

| Variable | Required in production | Description |
|----------|------------------------|-------------|
| `PUBLIC_BASE_URL` | Yes | Public origin, for example `https://mcp.scrapeops.io` |
| `TOKEN_ENCRYPTION_KEY` | Yes | 32-byte key (`openssl rand -hex 32`) used to encrypt account API keys at rest |
| `REQUIRE_OAUTH` | Yes | `true` so a process-wide API key cannot authenticate remote users |
| `OAUTH_ENABLED` | Yes | `true` |
| `DATA_DIR` | No | SQLite directory for OAuth clients and tokens. Defaults to `./data` |
| `SCRAPEOPS_BACKEND_URL` | No | Login API. Defaults to `https://backend.scrapeops.io/v1` |
| `SENTRY_DSN` | No | Sends server errors to Sentry |
| `LOG_FORMAT` | No | Set to `json` for production logs |
| `ALLOWED_ORIGINS` | No | Extra browser origins, comma-separated. `https://claude.ai` and `https://claude.com` are already allowed |

`GET /health` returns `{ "status": "ok" }`. MCP and OAuth routes require HTTPS when `NODE_ENV=production`. Requests are rate limited per IP and per account.

Before submitting the Claude connector, confirm with a deployed server:

1. `https://mcp.scrapeops.io/mcp` is accepted as a remote MCP URL.
2. Claude discovers the proxy tools (`maps_web`, `extract_data`, `return_links`) and the analysis tools listed below.
3. Connect opens the ScrapeOps sign-in page.
4. After approval, a tool call is billed to the signed-in account.
5. Revoking access from Claude, or at `/oauth/revoke-access`, makes the next call return `401`.

## Available Tools

### Proxy & extraction tools

### Tool 1: `maps_web`

General-purpose web browsing tool for reading pages, taking screenshots, and bypassing anti-bot protections.

**Usage Examples:**

```json
// Simple page browse
{
  "name": "maps_web",
  "arguments": {
    "url": "https://example.com"
  }
}

// Screenshot from Germany with residential proxy
{
  "name": "maps_web",
  "arguments": {
    "url": "https://example.de",
    "country": "de",
    "residential": true,
    "screenshot": true
  }
}

// Bypass Cloudflare protection
{
  "name": "maps_web",
  "arguments": {
    "url": "https://protected-site.com",
    "bypass_level": "cloudflare_level_2",
    "residential": true,
    "render_js": true
  }
}
```

### Tool 2: `extract_data`

Structured data extraction using auto-parsing or LLM-powered extraction.

**Usage Examples:**

```json
// Auto-extract from known domain
{
  "name": "extract_data",
  "arguments": {
    "url": "https://www.amazon.com/dp/B09V3KXJPB",
    "mode": "auto"
  }
}

// LLM extraction for product page
{
  "name": "extract_data",
  "arguments": {
    "url": "https://shop.example.com/product/123",
    "mode": "llm",
    "data_schema": "product_page",
    "response_format": "json"
  }
}

// Extract job listings with anti-bot bypass
{
  "name": "extract_data",
  "arguments": {
    "url": "https://careers.example.com/jobs",
    "mode": "llm",
    "data_schema": "job_search_page",
    "bypass_level": "generic_level_2",
    "render_js": true
  }
}
```

### Tool 3: `return_links`

Extract and categorize URLs from a webpage into **pages** (navigational HTML links) and **assets** (images, scripts, stylesheets, media, embeds). Relative URLs are absolutized and duplicates removed.

**Usage Examples:**

```json
{
  "name": "return_links",
  "arguments": {
    "url": "https://example.com"
  }
}

{
  "name": "return_links",
  "arguments": {
    "url": "https://protected-site.com",
    "bypass_level": "generic_level_1"
  }
}
```

### Scraping analysis tools

These tools help plan a scrape before spending credits on heavy proxy/bypass options. Several call the ScrapeOps parser / web-analyzer service in addition to the Proxy API.

### Tool 4: `analyze_scraping_difficulty`

Score how hard a URL is to scrape (1–5), including anti-bot signals, JS framework needs, CSS selector stability, rate limiting, bandwidth, and residential-IP guidance.

```json
{
  "name": "analyze_scraping_difficulty",
  "arguments": {
    "url": "https://example.com"
  }
}
```

### Tool 5: `check_js_rendering`

Compare a basic fetch vs a JS-rendered fetch to decide whether rendering is required, and report missing content / SPA indicators / frameworks.

```json
{
  "name": "check_js_rendering",
  "arguments": {
    "url": "https://example.com"
  }
}
```

### Tool 6: `detect_anti_bots`

Detect anti-bot systems (Cloudflare, DataDome, PerimeterX/HUMAN, Incapsula, Akamai, AWS WAF, Sucuri, reCAPTCHA, hCaptcha, Kasada, Shape/F5) with confidence, evidence, and recommended `maps_web` bypass settings.

```json
{
  "name": "detect_anti_bots",
  "arguments": {
    "url": "https://example.com"
  }
}
```

### Tool 7: `check_scraping_legality`

Informational robots.txt / Terms of Service analysis: allowed paths, crawl delays, scraping-related clauses, risk level, and known lawsuit notes. Not legal advice.

```json
{
  "name": "check_scraping_legality",
  "arguments": {
    "url": "https://example.com"
  }
}
```

### Tool 8: `classify_page_type`

Classify a page (product, SERP, job, article, company, real estate, captcha/ban, etc.) with reasoning and confidence so you can pick the right extraction schema.

```json
{
  "name": "classify_page_type",
  "arguments": {
    "url": "https://shop.example.com/product/123"
  }
}
```

### Tool 9: `identify_data_sources`

Find where target data lives: static HTML, embedded JSON (`JSON-LD`, `__NEXT_DATA__`, etc.), or network/XHR responses — with extracted items and scraping recommendations.

```json
{
  "name": "identify_data_sources",
  "arguments": {
    "url": "https://example.com/products/blue-widget"
  }
}
```

### Tool 10: `analyze_api_endpoints`

From JS-rendered network capture, identify which XHR/fetch calls return primary data and document method, params, auth hints, and pagination so browser scraping can be replaced with API scraping when possible.

```json
{
  "name": "analyze_api_endpoints",
  "arguments": {
    "url": "https://example.com/products"
  }
}
```

### Tool 11: `detect_tech_stack`

Detect frameworks, libraries, CMS, CSS, ecommerce, analytics, and payment tooling, plus rendering mode (SSR/CSR/SSG) and scraping implications.

```json
{
  "name": "detect_tech_stack",
  "arguments": {
    "url": "https://example.com"
  }
}
```

### Tool 12: `check_css_selectors`

Fetch the page multiple times with JS rendering and classify selectors as **stable**, **dynamic**, or **obfuscated**, with recommended selector strategies.

```json
{
  "name": "check_css_selectors",
  "arguments": {
    "url": "https://example.com"
  }
}
```

### Tool 13: `generate_data_schema`

Classify the page (or accept a `page_type` override) and return a barebones JSON schema from the ScrapeOps schema library for use with `extract_data` LLM mode.

```json
{
  "name": "generate_data_schema",
  "arguments": {
    "url": "https://shop.example.com/product/123"
  }
}

{
  "name": "generate_data_schema",
  "arguments": {
    "url": "https://shop.example.com/product/123",
    "page_type": "product_page"
  }
}
```

## User Stories

### The Visual Debugger
> "User complains a site looks broken in Germany. The AI calls `maps_web(url='...', country='de', screenshot=true)`. The user sees the actual screenshot of the site rendered via a German residential IP."

### The Efficient Scraper
> "User needs pricing data. Instead of fetching HTML and parsing it (wasting tokens), the AI calls `extract_data(url='...', mode='llm', data_schema='product_page')`. ScrapeOps handles the heavy lifting, and the AI just displays the final JSON."

### The Bypass Expert
> "The AI tries to access a site and gets blocked. It automatically retries the request using `maps_web` with `bypass_level='generic_level_3'` and `residential=true` to overcome the blockage."

### The Scraping Planner
> "Before burning credits on a hard target, the AI runs `analyze_scraping_difficulty`, `detect_anti_bots`, and `check_js_rendering`. It then picks bypass/render settings (or switches to API scraping via `analyze_api_endpoints`) and generates a schema with `generate_data_schema` before calling `extract_data`."

## System Configuration

The server includes configurable retry parameters with exponential backoff:

```javascript
const RETRY_CONFIG = {
  maxAttempts: 1,      
  initialDelay: 1000, 
};
```

**Retry Behavior:**
- Network errors are retried once regardless of maxAttempts setting
- To enable retries, set `SCRAPEOPS_RETRY_MAX_ATTEMPTS` environment variable

**Custom Configuration Example:**

```bash
# Enable retries with 3 attempts
export SCRAPEOPS_RETRY_MAX_ATTEMPTS=3
export SCRAPEOPS_RETRY_INITIAL_DELAY=1000
```

## Error Handling

| Status Code | Error | Resolution |
|-------------|-------|------------|
| 401 | Invalid API Key | Check your `SCRAPEOPS_API_KEY` environment variable |
| 403 | Forbidden | Target website blocking request - consider using advanced parameters |
| 404 | Not Found | Verify the URL is correct |
| 429 | Rate Limited | Too many requests - wait before retrying (NOT auto-retried) |
| 500 | Server Error | Automatically retried up to 3 times with exponential backoff |
| 502/503 | Gateway/Service Error | Temporary issue - NOT auto-retried |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally (stdio transport)
SCRAPEOPS_API_KEY=your-key npm start

# Run tests
npm test
```

## API Reference

**Base URL:** `https://proxy.scrapeops.io/v1/`

**Authentication:** Query parameter `?api_key=...` (managed via server-side environment variables)

For full API documentation, visit [ScrapeOps Documentation](https://scrapeops.io/docs/intro/).

## License

MIT License - see LICENSE file for details.

## Support

- 📚 [Documentation](https://scrapeops.io/docs/intro/)
- 🐛 [Report Issues](https://github.com/ScrapeOps/scrapeops-mcp-server/issues)
