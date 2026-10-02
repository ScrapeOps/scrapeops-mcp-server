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
# Set the port for HTTP/SSE mode (required for local server)
export PORT=8080
export SCRAPEOPS_API_KEY=your-api-key-here

# Run the server
npm start
# or if you have the package installed globally
scrapeops-mcp
```

The server exposes Streamable HTTP at `http://localhost:8080/mcp` (or the port specified by `PORT`). The legacy SSE endpoint remains available at `/sse`.

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
docker run --rm -p 8080:8080 \
  -e PUBLIC_BASE_URL=https://mcp.scrapeops.io \
  -e TOKEN_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
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
2. Claude discovers `maps_web`, `extract_data`, and `return_links`.
3. Connect opens the ScrapeOps sign-in page.
4. After approval, a tool call is billed to the signed-in account.
5. Revoking access from Claude, or at `/oauth/revoke-access`, makes the next call return `401`.

## Available Tools

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

## User Stories

### The Visual Debugger
> "User complains a site looks broken in Germany. The AI calls `maps_web(url='...', country='de', screenshot=true)`. The user sees the actual screenshot of the site rendered via a German residential IP."

### The Efficient Scraper
> "User needs pricing data. Instead of fetching HTML and parsing it (wasting tokens), the AI calls `extract_data(url='...', mode='llm', data_schema='product_page')`. ScrapeOps handles the heavy lifting, and the AI just displays the final JSON."

### The Bypass Expert
> "The AI tries to access a site and gets blocked. It automatically retries the request using `maps_web` with `bypass_level='generic_level_3'` and `residential=true` to overcome the blockage."

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
