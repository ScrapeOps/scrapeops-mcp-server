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
env SCRAPEOPS_API_KEY=YOUR_API_KEY npx -y scrapeops-mcp
```

### Manual Installation

```bash
npm install -g scrapeops-mcp
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
    "scrapeops-mcp": {
      "command": "npx",
      "args": ["-y", "scrapeops-mcp"],
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
    "scrapeops-mcp": {
      "command": "npx",
      "args": ["-y", "scrapeops-mcp"],
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
        "args": ["-y", "scrapeops-mcp"],
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
    "scrapeops-mcp": {
      "command": "npx",
      "args": ["-y", "scrapeops-mcp"],
      "env": {
        "SCRAPEOPS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

## Available Tools

### Tool 1: `Maps_web`

General-purpose web browsing tool for reading pages, taking screenshots, and bypassing anti-bot protections.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | The URL to browse |
| `country` | enum | No | Country for geo-targeting: `us`, `gb`, `de`, `fr`, `ca`, `au`, `br`, `in`, `jp`, `nl`, `es`, `it` |
| `residential` | boolean | No | Use residential proxies |
| `mobile` | boolean | No | Use mobile proxies |
| `render_js` | boolean | No | Enable JavaScript rendering |
| `screenshot` | boolean | No | Return a screenshot (base64 PNG) |
| `wait_for` | string | No | CSS selector to wait for |
| `wait` | number | No | Time to wait (ms) |
| `scroll` | number | No | Scroll pixels before capture |
| `bypass_level` | enum | No | Anti-bot bypass level |
| `premium` | enum | No | Premium proxy level: `level_1`, `level_2` |
| `device_type` | enum | No | `desktop` or `mobile` |
| `follow_redirects` | boolean | No | Follow HTTP redirects |

**Bypass Levels:**
- `generic_level_1` - `generic_level_4`
- `cloudflare_level_1` - `cloudflare_level_3`
- `datadome`
- `incapsula`
- `perimeterx`

**Usage Examples:**

```json
// Simple page browse
{
  "name": "Maps_web",
  "arguments": {
    "url": "https://example.com"
  }
}

// Screenshot from Germany with residential proxy
{
  "name": "Maps_web",
  "arguments": {
    "url": "https://example.de",
    "country": "de",
    "residential": true,
    "screenshot": true
  }
}

// Bypass Cloudflare protection
{
  "name": "Maps_web",
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

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | The URL to extract data from |
| `mode` | enum | Yes | `auto` or `llm` |
| `data_schema` | enum | No | Schema for LLM extraction |
| `response_format` | enum | No | `json` or `markdown` |
| `country` | enum | No | Country for geo-targeting |
| `residential` | boolean | No | Use residential proxies |
| `render_js` | boolean | No | Enable JavaScript rendering |
| `wait_for` | string | No | CSS selector to wait for |
| `wait` | number | No | Time to wait (ms) |
| `bypass_level` | enum | No | Anti-bot bypass level |

**Data Schemas:**
- **Product**: `product_page`, `product_reviews_page`, `product_search_page`, `product_seller_page`
- **Jobs**: `job_page`, `job_advert_page`, `job_search_page`
- **Company**: `company_page`, `company_job_page`, `company_location_page`, `company_review_page`, `company_search_page`, `company_social_media_page`
- **Real Estate**: `real_estate_page`, `real_estate_profile_page`, `real_estate_search_page`
- **Search**: `serp_search_page`

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
> "User complains a site looks broken in Germany. The AI calls `Maps_web(url='...', country='de', screenshot=true)`. The user sees the actual screenshot of the site rendered via a German residential IP."

### The Efficient Scraper
> "User needs pricing data. Instead of fetching HTML and parsing it (wasting tokens), the AI calls `extract_data(url='...', mode='llm', data_schema='product_page')`. ScrapeOps handles the heavy lifting, and the AI just displays the final JSON."

### The Bypass Expert
> "The AI tries to access a site and gets blocked. It automatically retries the request using `Maps_web` with `bypass_level='generic_level_3'` and `residential=true` to overcome the blockage."

## System Configuration

The server includes configurable retry parameters with exponential backoff:

```javascript
const RETRY_CONFIG = {
  maxAttempts: 0,      // Default: 0 (no retries) - configurable via SCRAPEOPS_RETRY_MAX_ATTEMPTS
  initialDelay: 1000,  // Initial delay before first retry in milliseconds (configurable via SCRAPEOPS_RETRY_INITIAL_DELAY)
};
```

**Retry Behavior:**
- **Default: No automatic retries** (maxAttempts = 0)
- Only retries on HTTP 500 (Internal Server Error) when maxAttempts > 0
- Does NOT retry on 429 (rate limits), 502, 503, or other status codes
- Uses exponential backoff (delay doubles on each retry)
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
