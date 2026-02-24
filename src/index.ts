#!/usr/bin/env node
import dotenv from 'dotenv';
import { FastMCP } from 'firecrawl-fastmcp';
import { z } from 'zod';
import type {
  Logger,
  SessionData,
  AuthenticateRequest,
  ScrapeOpsResponse,
  ErrorType,
  RequestResult,
  ScrapeOpsRequestParams,
  UsedOptions,
  ValidationParams,
  ValidationResult,
  SuggestedAdvancedParams,
  ErrorResponse,
  WebAnalyzerResponse,
  NetworkRequestResult,
  ApiEndpointAnalysis,
} from './types/index.js';

dotenv.config({ debug: false, quiet: true });


const ADVANCED_PARAMS = [
  'render_js',
  'residential', 
  'mobile',
  'premium',
  'bypass_level',
  'optimize_request',
] as const;

function hasAdvancedParams(params: UsedOptions): string[] {
  const used: string[] = [];
  for (const param of ADVANCED_PARAMS) {
    const value = params[param as keyof UsedOptions];
    if (value !== undefined && value !== false) {
      used.push(param);
    }
  }
  return used;
}

// const PARSER_BASE_URL = 'http://localhost:6600/v1/';
// const BASE_URL = 'http://localhost:9000/v1/';
const PARSER_BASE_URL = 'https://parser.scrapeops.io/v1/';
const BASE_URL = 'https://proxy.scrapeops.io/v1/';
const ORIGIN = 'mcp-scrapeops';

/** Timeout for parser-service fetches (web-analyzer, determine-page-type, css-selector-stability, data-schema). */
const PARSER_FETCH_TIMEOUT_MS = 120_000;

/**
 * fetch with AbortController timeout. Clears the timer on success or throw.
 * Converts AbortError into a descriptive Error so callers see a timeout-specific message.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  label: string
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? PARSER_FETCH_TIMEOUT_MS;
  const { timeoutMs: _t, ...fetchInit } = init;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...fetchInit, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

function removeEmptyValues(obj: Partial<ScrapeOpsRequestParams>): Partial<ScrapeOpsRequestParams> {
  const out: Partial<ScrapeOpsRequestParams> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).length === 0
    )
      continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function buildQueryString(params: ScrapeOpsRequestParams): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.append(key, String(value));
    }
  }
  return searchParams.toString();
}

class ConsoleLogger implements Logger {
  debug(...args: unknown[]): void {
    console.error('[DEBUG]', new Date().toISOString(), ...args);
  }
  error(...args: unknown[]): void {
    console.error('[ERROR]', new Date().toISOString(), ...args);
  }
  info(...args: unknown[]): void {
    console.error('[INFO]', new Date().toISOString(), ...args);
  }
  log(...args: unknown[]): void {
    console.error('[LOG]', new Date().toISOString(), ...args);
  }
  warn(...args: unknown[]): void {
    console.error('[WARN]', new Date().toISOString(), ...args);
  }
}

const server = new FastMCP<SessionData>({
  name: 'scrapeops-mcp',
  version: '1.0.0',
  logger: new ConsoleLogger(),
  roots: { enabled: false },
  authenticate: async (req?: AuthenticateRequest): Promise<SessionData> => {
    // Try to get key from HTTP headers (for SSE transport)
    if (req && req.headers) {
      const headerKey = req.headers['scrapeops-api-key'] || req.headers['scrapeops_api_key'];
      if (headerKey) {
        return { scrapeOpsApiKey: Array.isArray(headerKey) ? headerKey[0] : headerKey };
      }
    }
    // Fallback to environment variable
    return { scrapeOpsApiKey: process.env.SCRAPEOPS_API_KEY };
  },
  health: {
    enabled: true,
    message: 'ok',
    path: '/health',
    status: 200,
  },
});

// ============================================================================
// API Client
// ============================================================================

function getApiKey(session?: SessionData): string {
  const apiKey = session?.scrapeOpsApiKey || process.env.SCRAPEOPS_API_KEY;
  if (!apiKey) {
    throw new Error('API key is required. Set SCRAPEOPS_API_KEY environment variable.');
  }
  return apiKey;
}


const RETRY_CONFIG = {
  maxAttempts: parseInt(process.env.SCRAPEOPS_RETRY_MAX_ATTEMPTS || '1', 10),
  initialDelay: parseInt(process.env.SCRAPEOPS_RETRY_INITIAL_DELAY || '1000', 10),
};


function getErrorType(statusCode: number): ErrorType {
  switch (statusCode) {
    case 401: return 'auth_failed';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 429: return 'rate_limited';
    case 500: return 'server_error';
    case 502: return 'bad_gateway';
    case 503: return 'service_unavailable';
    default: return 'unknown';
  }
}

/**
 * Get user-friendly error message based on error type
 */
function getErrorMessage(errorType: ErrorType, statusCode: number): string {
  switch (errorType) {
    case 'auth_failed':
      return 'Invalid API Key. Please check your SCRAPEOPS_API_KEY environment variable.';
    case 'forbidden':
      return `Access denied (HTTP 403). The target website may be blocking the request.`;
    case 'not_found':
      return `Page not found (HTTP 404). Please verify the URL is correct.`;
    case 'rate_limited':
      return `Rate limited (HTTP 429). Too many requests. Please wait before retrying.`;
    case 'server_error':
      return `Server error (HTTP 500). The request failed on ScrapeOps servers.`;
    case 'bad_gateway':
      return `Bad gateway (HTTP 502). There was a gateway error.`;
    case 'service_unavailable':
      return `Service unavailable (HTTP 503). The service is temporarily down.`;
    case 'network_error':
      return `Network error. Please check your internet connection.`;
    default:
      return `Request failed with status ${statusCode}.`;
  }
}

async function makeRequest(
  apiKey: string,
  params: Partial<ScrapeOpsRequestParams>,
  log: Logger
): Promise<RequestResult> {
  const queryParams: ScrapeOpsRequestParams = {
    url: params.url || '',
    api_key: apiKey,
    ...params,
  };
  const url = `${BASE_URL}?${buildQueryString(queryParams)}`;
  log.info('Making ScrapeOps request', { url: params.url, params: Object.keys(params).filter(k => k !== 'url') });

  let attempt = 0;
  let delay = RETRY_CONFIG.initialDelay;
  let lastError: unknown = null;

  while (attempt < RETRY_CONFIG.maxAttempts) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': `ScrapeOps-MCP/${ORIGIN}`,
        },
      });

      const status = response.status;
      const errorType = getErrorType(status);

      if (!response.ok) {
        log.warn(`Request failed with status ${status} (${errorType})`, { attempt: attempt + 1, url: params.url });

        if (errorType === 'auth_failed') {
          return {
            success: false,
            error: getErrorMessage(errorType, status),
            errorType,
            statusCode: status,
            retriesAttempted: attempt,
          };
        }

        if (status === 500 && attempt < RETRY_CONFIG.maxAttempts - 1) {
          log.info(`HTTP 500 detected, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_CONFIG.maxAttempts})`);
          await new Promise(res => setTimeout(res, delay));
          delay *= 2;
          attempt++;
          continue;
        }
        return {
          success: false,
          error: getErrorMessage(errorType, status),
          errorType,
          statusCode: status,
          retriesAttempted: attempt,
        };
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json') || params.json_response) {
        const jsonData = await response.json();
        return { success: true, data: jsonData as ScrapeOpsResponse, statusCode: status, retriesAttempted: attempt };
      }

      const textData = await response.text();
      return { success: true, data: textData, statusCode: status, retriesAttempted: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 1) {
        log.warn(`Network error: ${error instanceof Error ? error.message : String(error)}, retrying once...`);
        await new Promise(res => setTimeout(res, delay));
        attempt++;
        continue;
      }
      break;
    }
  }

  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    success: false,
    error: `Network error: ${errorMessage}`,
    errorType: 'network_error',
    retriesAttempted: attempt,
  };
}


function validateParams(params: ValidationParams): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (params.render_js === false && params.wait_for) {
    errors.push('Conflict: `wait_for` requires JavaScript rendering, but `render_js` is explicitly set to false. Remove `render_js: false` or remove `wait_for`.');
  }

  if (params.render_js === false && params.scroll) {
    errors.push('Conflict: `scroll` requires JavaScript rendering, but `render_js` is explicitly set to false. Remove `render_js: false` or remove `scroll`.');
  }

  if (params.render_js === false && params.screenshot) {
    errors.push('Conflict: `screenshot` requires JavaScript rendering, but `render_js` is explicitly set to false. Remove `render_js: false` or remove `screenshot`.');
  }

  if (params.optimize_request && params.bypass_level) {
    warnings.push('Warning: Using `optimize_request` with `bypass_level` may cause conflicts. The optimizer may override your bypass settings.');
  }

  if (params.optimize_request && params.premium) {
    warnings.push('Warning: Using `optimize_request` with `premium` may cause conflicts. The optimizer may override your premium settings.');
  }

  if (params.session_number !== undefined) {
    if (params.session_number < 1 || params.session_number > 10000) {
      errors.push('Invalid `session_number`: must be between 1 and 10000.');
    }
  }

  if (params.max_request_cost && !params.optimize_request) {
    errors.push('`max_request_cost` requires `optimize_request: true` to be set.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Generate MCP-compliant error response that properly asks for user permission
 * before suggesting advanced parameters.
 * 
 * Key principle: NEVER auto-suggest retry with advanced params.
 * Instead, explain what happened and ASK for permission.
 */
function generateErrorResponse(
  url: string,
  error: string,
  errorType: ErrorType | undefined,
  statusCode: number | undefined,
  usedOptions: UsedOptions,
  retriesAttempted: number = 0
): string {
  const usedAdvancedParams = hasAdvancedParams(usedOptions);
  const wasBasicRequest = usedAdvancedParams.length === 0;

  let userMessage: string;
  let canRetryWithAdvanced: boolean = false;
  let suggestedAdvancedParams: SuggestedAdvancedParams = {};

  switch (errorType) {
    case 'auth_failed':
      userMessage = 'Authentication failed. Please verify your SCRAPEOPS_API_KEY is correct and has not expired.';
      break;

    case 'forbidden':
      userMessage = wasBasicRequest
        ? 'The target website blocked the request (HTTP 403). This often happens with protected sites.'
        : `The request was blocked even with advanced options: ${usedAdvancedParams.join(', ')}.`;
      canRetryWithAdvanced = wasBasicRequest;
      suggestedAdvancedParams = {
        residential: true,
        bypass_level: 'generic_level_2',
      };
      break;

    case 'rate_limited':
      userMessage = 'Rate limited by the target website (HTTP 429). The site is limiting request frequency.';
      canRetryWithAdvanced = wasBasicRequest;
      suggestedAdvancedParams = {
        residential: true,
      };
      break;

    case 'not_found':
      userMessage = 'Page not found (HTTP 404). Please verify the URL is correct and the page exists.';
      break;

    case 'server_error':
      userMessage = `Server error occurred (HTTP 500). Retried ${retriesAttempted} time(s) but the issue persists.`;
      canRetryWithAdvanced = wasBasicRequest;
      suggestedAdvancedParams = {
        render_js: true,
      };
      break;

    case 'bad_gateway':
    case 'service_unavailable':
      userMessage = `Service temporarily unavailable (HTTP ${statusCode}). This is usually a temporary issue.`;
      break;

    case 'network_error':
      userMessage = 'Network connection error. Please check your internet connection and try again.';
      break;

    default:
      userMessage = error || 'An unknown error occurred.';
      canRetryWithAdvanced = wasBasicRequest;
  }

  const response: ErrorResponse = {
    success: false,
    url,
    error: userMessage,
    error_type: errorType || 'unknown',
    status_code: statusCode,
    retries_attempted: retriesAttempted,
    options_used: wasBasicRequest ? 'none (basic request with default settings)' : usedOptions,
  };

  if (canRetryWithAdvanced && Object.keys(suggestedAdvancedParams).length > 0) {
    response.permission_request = {
      message: '⚠️ REQUEST FOR PERMISSION: The basic request failed. I can retry with advanced scraping options that may help, but they will consume more API credits.',
      question: 'Would you like me to retry with the following advanced options?',
      suggested_options: suggestedAdvancedParams,
      estimated_additional_cost: 'Approximately 10-25 additional credits per request',
      action_required: 'Please confirm by saying "yes, retry with advanced options" or specify which options you want to use.',
    };
  } else if (!wasBasicRequest) {
    response.diagnostic = {
      message: 'Advanced options were already used but the request still failed.',
      tried_options: usedAdvancedParams,
      possible_causes: [
        'The target website has very strong anti-bot protection',
        'The URL may be incorrect or the page may not exist',
        'The website may be experiencing issues',
      ],
      recommendations: [
        'Verify the URL is correct and accessible in a browser',
        'Try a different approach or target URL',
        'Contact ScrapeOps support if the issue persists',
      ],
    };
  }

  return JSON.stringify(response, null, 2);
}

function asText(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  return JSON.stringify(data, null, 2);
}

// ============================================================================
// Tool 1: browse_webpage - General Purpose Web Browsing
// ============================================================================

const mapsWebSchema = z.object({
  url: z
    .string()
    .url()
    .describe('Target webpage URL to browse/scrape. Must include protocol (http:// or https://)'),

  render_js: z
    .boolean()
    .optional()
    .describe('Enable JavaScript rendering for SPAs and dynamic content. Required for sites built with React, Vue, Angular. Auto-enabled by screenshot, wait_for, and scroll. Adds ~5 credits per request'),

  screenshot: z
    .boolean()
    .optional()
    .describe('Capture base64-encoded PNG screenshot of the rendered page. Useful for visual verification, debugging, or capturing dynamic content. Auto-enables render_js and json_response. Adds ~5 credits'),

  residential: z
    .boolean()
    .optional()
    .describe('Use residential IP proxies instead of datacenter IPs. Provides higher success rates on protected sites and avoids datacenter IP blocks. Recommended for challenging sites. Adds ~10 credits'),

  country: z
    .enum(['us', 'gb', 'de', 'fr', 'ca', 'au', 'br', 'in', 'jp', 'nl', 'es', 'it'])
    .optional()
    .describe('Proxy country code for geo-targeting. Use to access region-locked content or see localized versions of websites. Examples: "us" (United States), "gb" (United Kingdom), "de" (Germany), "fr" (France)'),

  bypass_level: z
    .enum([
      'generic_level_1',
      'generic_level_2',
      'generic_level_3',
      'generic_level_4',
      'cloudflare_level_1',
      'cloudflare_level_2',
      'cloudflare_level_3',
      'datadome',
      'incapsula',
      'perimeterx',
    ])
    .optional()
    .describe('Anti-bot bypass strength level. Use generic_level_2 for most protected sites. Use specific levels (cloudflare_level_2, datadome, incapsula, perimeterx) when you know the protection type. Higher levels cost more credits'),

  wait: z
    .number()
    .optional()
    .describe('Wait time in milliseconds before capturing page data. Useful for slow-loading content or animations. Example: 2000 for 2 seconds. Does not auto-enable render_js'),

  wait_for: z
    .string()
    .optional()
    .describe('CSS selector to wait for before returning response. Waits until the element appears on page. Auto-enables render_js. Example: ".product-list" or "#main-content" or "button.load-more"'),

  scroll: z
    .number()
    .optional()
    .describe('Scroll page by specified pixels before capturing data. Triggers lazy-loaded content and infinite scroll elements. Auto-enables render_js. Example: 1000 to scroll 1000px down'),

  mobile: z
    .boolean()
    .optional()
    .describe('Use mobile proxies instead of desktop proxies. Useful for mobile-specific content or testing mobile versions of sites'),

  premium: z
    .enum(['level_1', 'level_2'])
    .optional()
    .describe('Premium proxy tier for maximum success rates on very difficult sites. Significantly higher cost. Use only when other options fail'),

  device_type: z
    .enum(['desktop', 'mobile'])
    .optional()
    .describe('User-agent device type. Affects how sites render and serve content. Default is desktop. Use mobile for mobile-optimized pages'),

  follow_redirects: z
    .boolean()
    .optional()
    .describe('Whether to follow HTTP redirects (3xx status codes). Enabled by default. Set to false to capture redirect responses'),

  return_status_codes: z
    .boolean()
    .optional()
    .describe('Include initial and final HTTP status codes in JSON response. Useful for debugging redirects and response codes. Forces json_response output'),

  keep_headers: z
    .boolean()
    .optional()
    .describe('Return HTTP response headers in output. Useful for debugging or analyzing server responses'),

  session_number: z
    .number()
    .optional()
    .describe('Sticky session ID (1-10000) for maintaining cookies and state across multiple requests. Use same number for related requests to maintain session'),

  optimize_request: z
    .boolean()
    .optional()
    .describe('Let ScrapeOps automatically optimize parameters for best success/cost ratio. Recommended for cost optimization. Can be combined with max_request_cost'),

  max_request_cost: z
    .number()
    .optional()
    .describe('Maximum credits to spend on this request. Only works with optimize_request: true. Helps control costs by setting a credit limit'),
});

server.addTool({
  name: 'maps_web',
  description: `Browse and scrape any webpage with advanced proxy and rendering capabilities.

**Best for:**
- Reading webpage content
- Taking screenshots of websites
- Verifying how a site looks from different countries
- Bypassing anti-bot protections
- Accessing JavaScript-rendered content

**Key Features:**
- **Geo-targeting**: Access websites from different countries
- **JavaScript Rendering**: Render SPAs and dynamic content
- **Residential/Mobile Proxies**: Better success on challenging sites
- **Screenshots**: Capture visual snapshots of pages
- **Anti-Bot Bypass**: Multiple bypass levels for protected sites
- **Wait Controls**: Wait for elements or time before capture

**Usage Examples:**

1. Simple page browse:
\`\`\`json
{
  "name": "maps_web",
  "arguments": {
    "url": "https://example.com"
  }
}
\`\`\`

2. Screenshot for website:
\`\`\`json
{
  "name": "maps_web",
  "arguments": {
    "url": "https://example.de",
    "render_js": true,
    "json_response": true,
    "screenshot": true
  }
}
\`\`\`

3. Access Cloudflare-protected site:
\`\`\`json
{
  "name": "maps_web",
  "arguments": {
    "url": "https://protected-site.com",
    "bypass_level": "cloudflare_level_2",
    "residential": true,
    "render_js": true
  }
}
\`\`\`

4. Wait for dynamic content:
\`\`\`json
{
  "name": "maps_web",
  "arguments": {
    "url": "https://spa-app.com",
    "render_js": true,
    "wait_for": ".product-list",
    "wait": 2000
  }
}
\`\`\`

**Returns:** HTML content, or JSON with screenshot (base64) if screenshot=true.

**IMPORTANT - Default Behavior:**
- Always start with BASIC settings (just the URL)
- Do NOT use advanced parameters (render_js, residential, bypass_level, premium) unless:
  1. The user explicitly requests them, OR
  2. A previous request failed AND the user gives permission to use them

**If a request fails:**
- The error response will ask for permission to retry with advanced options
- Wait for user confirmation before using advanced parameters
- Never auto-enable advanced parameters without user consent`,
  parameters: mapsWebSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof mapsWebSchema>;
    const apiKey = getApiKey(session);

    const requestParams: Partial<ScrapeOpsRequestParams> = {
      url: params.url,
    };

    const usedOptions: UsedOptions = {};
    if (params.country) {
      requestParams.country = params.country;
      usedOptions.country = params.country;
    }
    if (params.residential) {
      requestParams.residential = true;
      usedOptions.residential = true;
    }
    if (params.mobile) {
      requestParams.mobile = true;
      usedOptions.mobile = true;
    }
    if (params.premium) {
      requestParams.premium = params.premium;
      usedOptions.premium = params.premium;
    }

    if (params.render_js) {
      requestParams.render_js = true;
      usedOptions.render_js = true;
    }
    if (params.wait_for) {
      requestParams.wait_for = params.wait_for;
      requestParams.render_js = true;
      usedOptions.wait_for = params.wait_for;
      usedOptions.render_js = true;
    }
    if (params.wait) {
      requestParams.wait = params.wait;
      usedOptions.wait = params.wait;
    }
    if (params.scroll) {
      requestParams.scroll = params.scroll;
      requestParams.render_js = true;
      usedOptions.scroll = params.scroll;
      usedOptions.render_js = true;
    }

    if (params.screenshot) {
      requestParams.screenshot = true;
      requestParams.render_js = true;
      requestParams.json_response = true;
      usedOptions.screenshot = true;
      usedOptions.render_js = true;
    }

    if (params.bypass_level) {
      requestParams.bypass = params.bypass_level;
      usedOptions.bypass_level = params.bypass_level;
    }

    if (params.device_type) {
      requestParams.device_type = params.device_type;
      usedOptions.device_type = params.device_type;
    }
    if (params.follow_redirects !== undefined) {
      requestParams.follow_redirects = params.follow_redirects;
      usedOptions.follow_redirects = params.follow_redirects;
    }
    if (params.return_status_codes) {
      requestParams.initial_status_code = true;
      requestParams.final_status_code = true;
      requestParams.json_response = true;
      usedOptions.return_status_codes = true;
    }
    if (params.keep_headers) {
      requestParams.keep_headers = true;
      usedOptions.keep_headers = true;
    }
    if (params.session_number) {
      requestParams.session_number = params.session_number;
      usedOptions.session_number = params.session_number;
    }
    if (params.optimize_request) {
      requestParams.optimize_request = true;
      usedOptions.optimize_request = true;
      if (params.max_request_cost) {
        requestParams.max_request_cost = params.max_request_cost;
        usedOptions.max_request_cost = params.max_request_cost;
      }
    }

    const validation = validateParams({
      ...params,
      ...usedOptions,
    });

    if (!validation.valid) {
      log.error('Parameter validation failed', { errors: validation.errors });
      return JSON.stringify({
        success: false,
        url: params.url,
        error: 'Invalid parameter combination',
        validation_errors: validation.errors,
        action_required: 'Please fix the parameter conflicts and try again.',
      }, null, 2);
    }

    if (validation.warnings.length > 0) {
      log.warn('Parameter validation warnings', { warnings: validation.warnings });
    }

    log.info('maps_web request', {
      url: params.url,
      options: Object.keys(usedOptions).length > 0 ? usedOptions : 'basic (no extra options)',
    });

    const result = await makeRequest(apiKey, removeEmptyValues(requestParams), log);

    if (result.success) {
      log.info('Request successful', { statusCode: result.statusCode });

      // Handle screenshot response
      if (params.screenshot && typeof result.data === 'object' && result.data?.screenshot) {
        return JSON.stringify({
          success: true,
          url: params.url,
          screenshot: result.data.screenshot,
          screenshot_type: 'base64_png',
          screenshot_usage: 'Decode this base64 string to get the PNG image',
          message: 'Screenshot captured successfully',
          ...(result.data.initial_status_code && { initial_status_code: result.data.initial_status_code }),
          ...(result.data.final_status_code && { final_status_code: result.data.final_status_code }),
        }, null, 2);
      }

      return asText(result.data);
    }

    log.warn('Request failed', { 
      error: result.error, 
      errorType: result.errorType,
      statusCode: result.statusCode,
      retriesAttempted: result.retriesAttempted,
    });
    return generateErrorResponse(
      params.url, 
      result.error || 'Unknown error', 
      result.errorType,
      result.statusCode, 
      usedOptions,
      result.retriesAttempted || 0
    );
  },
});


// ============================================================================
// Tool 2: extract_data - Structured Data Extraction
// ============================================================================

const extractDataSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The URL to extract data from'),

  mode: z
    .enum(['auto', 'llm'])
    .describe('Extraction mode: "auto" for domain-specific parsing, "llm" for AI-powered extraction'),

  data_schema: z
    .enum([
      'product_page',
      'product_reviews_page',
      'product_search_page',
      'product_seller_page',
      'job_page',
      'job_advert_page',
      'job_search_page',
      'company_page',
      'company_job_page',
      'company_location_page',
      'company_review_page',
      'company_search_page',
      'company_social_media_page',
      'real_estate_page',
      'real_estate_profile_page',
      'real_estate_search_page',
      'serp_search_page',
    ])
    .optional()
    .describe('Page type schema for optimized LLM extraction'),

  response_format: z
    .enum(['json', 'markdown'])
    .optional()
    .default('json')
    .describe('Output format for extracted data'),

  country: z
    .enum(['us', 'gb', 'de', 'fr', 'ca', 'au', 'br', 'in', 'jp', 'nl', 'es', 'it'])
    .optional()
    .describe('Country for geo-targeting'),

  residential: z
    .boolean()
    .optional()
    .describe('Use residential proxies'),

  mobile: z
    .boolean()
    .optional()
    .describe('Use mobile proxies'),

  premium: z
    .enum(['level_1', 'level_2'])
    .optional()
    .describe('Premium proxy level'),

  device_type: z
    .enum(['desktop', 'mobile'])
    .optional()
    .describe('Use desktop or mobile user-agents'),

  follow_redirects: z
    .boolean()
    .optional()
    .describe('Whether to follow HTTP redirects'),

  render_js: z
    .boolean()
    .optional()
    .describe('Render JavaScript before extraction'),

  wait_for: z
    .string()
    .optional()
    .describe('CSS selector to wait for before extraction'),

  wait: z
    .number()
    .optional()
    .describe('Time to wait in milliseconds'),

  // Anti-bot
  bypass_level: z
    .enum([
      'generic_level_1',
      'generic_level_2',
      'generic_level_3',
      'generic_level_4',
      'cloudflare_level_1',
      'cloudflare_level_2',
      'cloudflare_level_3',
      'datadome',
      'incapsula',
      'perimeterx',
    ])
    .optional()
    .describe('Anti-bot bypass level'),

  keep_headers: z
    .boolean()
    .optional()
    .describe('Return response headers'),

  session_number: z
    .number()
    .optional()
    .describe('Sticky session number'),

  optimize_request: z
    .boolean()
    .optional()
    .describe('Let ScrapeOps auto-optimize the request'),

  max_request_cost: z
    .number()
    .optional()
    .describe('Maximum credits allowed for the request'),
});

server.addTool({
  name: 'extract_data',
  description: `
Extract structured data from webpages using auto-parsing or LLM-powered extraction.

**Best for:**
- Getting product information (prices, names, descriptions)
- Extracting job listings data
- Parsing search results
- Collecting structured company information
- Real estate listings extraction

**Extraction Modes:**
- **auto**: Domain-specific parsers for common sites (Amazon, Google, etc.)
- **llm**: AI-powered extraction with customizable schemas

**Data Schemas (for LLM mode):**
- Product: product_page, product_reviews_page, product_search_page, product_seller_page
- Jobs: job_page, job_advert_page, job_search_page
- Company: company_page, company_job_page, company_review_page, company_search_page
- Real Estate: real_estate_page, real_estate_profile_page, real_estate_search_page
- Search: serp_search_page

**Usage Examples:**

1. Auto-extract from known domain:
\`\`\`json
{
  "name": "extract_data",
  "arguments": {
    "url": "https://www.amazon.com/dp/B09V3KXJPB",
    "mode": "auto"
  }
}
\`\`\`

2. LLM extraction for product page:
\`\`\`json
{
  "name": "extract_data",
  "arguments": {
    "url": "https://shop.example.com/product/123",
    "mode": "llm",
    "data_schema": "product_page",
    "response_format": "json"
  }
}
\`\`\`

3. Extract job listings with anti-bot bypass:
\`\`\`json
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
\`\`\`

4. Extract real estate data in markdown:
\`\`\`json
{
  "name": "extract_data",
  "arguments": {
    "url": "https://realestate.example.com/listing/456",
    "mode": "llm",
    "data_schema": "real_estate_page",
    "response_format": "markdown"
  }
}
\`\`\`

**Returns:** Structured JSON or Markdown data extracted from the page.
`,
  parameters: extractDataSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof extractDataSchema>;
    const apiKey = getApiKey(session);

    const requestParams: Partial<ScrapeOpsRequestParams> = {
      url: params.url,
      json_response: true,
    };

    const usedOptions: UsedOptions = {};
    if (params.mode === 'auto') {
      requestParams.auto_extract = true;
    } else if (params.mode === 'llm') {
      requestParams.llm_extract = true;
      if (params.data_schema) {
        requestParams.llm_data_schema = params.data_schema;
      }
      if (params.response_format) {
        requestParams.llm_extract_response_type = params.response_format;
      }
    }

    if (params.country) {
      requestParams.country = params.country;
      usedOptions.country = params.country;
    }
    if (params.residential) {
      requestParams.residential = true;
      usedOptions.residential = true;
    }
    if (params.mobile) {
      requestParams.mobile = true;
      usedOptions.mobile = true;
    }
    if (params.premium) {
      requestParams.premium = params.premium;
      usedOptions.premium = params.premium;
    }

    if (params.render_js) {
      requestParams.render_js = true;
      usedOptions.render_js = true;
    }
    if (params.wait_for) {
      requestParams.wait_for = params.wait_for;
      requestParams.render_js = true;
      usedOptions.wait_for = params.wait_for;
      usedOptions.render_js = true;
    }
    if (params.wait) {
      requestParams.wait = params.wait;
      usedOptions.wait = params.wait;
    }

    if (params.bypass_level) {
      requestParams.bypass = params.bypass_level;
      usedOptions.bypass_level = params.bypass_level;
    }

    if (params.device_type) {
      requestParams.device_type = params.device_type;
      usedOptions.device_type = params.device_type;
    }
    if (params.follow_redirects !== undefined) {
      requestParams.follow_redirects = params.follow_redirects;
      usedOptions.follow_redirects = params.follow_redirects;
    }
    if (params.keep_headers) {
      requestParams.keep_headers = true;
      usedOptions.keep_headers = true;
    }
    if (params.session_number) {
      requestParams.session_number = params.session_number;
      usedOptions.session_number = params.session_number;
    }
    if (params.optimize_request) {
      requestParams.optimize_request = true;
      usedOptions.optimize_request = true;
      if (params.max_request_cost) {
        requestParams.max_request_cost = params.max_request_cost;
        usedOptions.max_request_cost = params.max_request_cost;
      }
    }

    const validation = validateParams({
      ...params,
      ...usedOptions,
    });

    if (!validation.valid) {
      log.error('Parameter validation failed', { errors: validation.errors });
      return JSON.stringify({
        success: false,
        url: params.url,
        error: 'Invalid parameter combination',
        validation_errors: validation.errors,
        action_required: 'Please fix the parameter conflicts and try again.',
      }, null, 2);
    }

    if (validation.warnings.length > 0) {
      log.warn('Parameter validation warnings', { warnings: validation.warnings });
    }

    log.info('extract_data request', {
      url: params.url,
      mode: params.mode,
      schema: params.data_schema,
      options: Object.keys(usedOptions).length > 0 ? usedOptions : 'basic (no extra options)',
    });

    const result = await makeRequest(apiKey, removeEmptyValues(requestParams), log);
    if (result.success) {
      log.info('Extraction successful');
      return JSON.stringify({
        success: true,
        url: params.url,
        extraction_mode: params.mode,
        ...(params.data_schema && { data_schema: params.data_schema }),
        ...(validation.warnings.length > 0 && { warnings: validation.warnings }),
        data: result.data,
      }, null, 2);
    }

    log.warn('Extraction failed', { 
      error: result.error, 
      errorType: result.errorType,
      statusCode: result.statusCode,
      retriesAttempted: result.retriesAttempted,
    });
    return generateErrorResponse(
      params.url, 
      result.error || 'Unknown error', 
      result.errorType,
      result.statusCode, 
      usedOptions,
      result.retriesAttempted || 0
    );
  },
});

// ============================================================================
// Tool 3: return_links - URL Extraction from Webpages
// ============================================================================

const returnLinksSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The URL to extract links from'),

  country: z
    .enum(['us', 'gb', 'de', 'fr', 'ca', 'au', 'br', 'in', 'jp', 'nl', 'es', 'it'])
    .optional()
    .describe('Country for geo-targeting'),

  residential: z
    .boolean()
    .optional()
    .describe('Use residential proxies for better success rates'),

  mobile: z
    .boolean()
    .optional()
    .describe('Use mobile proxies'),

  premium: z
    .enum(['level_1', 'level_2'])
    .optional()
    .describe('Premium proxy level'),

  bypass_level: z
    .enum([
      'generic_level_1',
      'generic_level_2',
      'generic_level_3',
      'generic_level_4',
      'cloudflare_level_1',
      'cloudflare_level_2',
      'cloudflare_level_3',
      'datadome',
      'incapsula',
      'perimeterx',
    ])
    .optional()
    .describe('Anti-bot bypass level'),

  session_number: z
    .number()
    .optional()
    .describe('Sticky session number (1-10000)'),

  optimize_request: z
    .boolean()
    .optional()
    .describe('Let ScrapeOps auto-optimize the request'),

  max_request_cost: z
    .number()
    .optional()
    .describe('Maximum credits allowed for the request'),
});

server.addTool({
  name: 'return_links',
  description: `Extract and categorize all URLs from a webpage.

**Best for:**
- Discovering all links on a page
- Building sitemaps
- Finding all assets (images, scripts, stylesheets)
- Web crawling and link analysis
- Identifying internal vs external links

**What it extracts:**
- Links from <a>, <area> tags
- Images from <img src>, <img srcset>
- Scripts from <script src>
- Stylesheets from <link href>
- Media from <video>, <audio>, <source>
- Embedded content from <iframe>, <object>, <embed>
- URLs from CSS url() functions
- Meta refresh redirects
- Open Graph and meta image URLs

**URL Processing:**
- Converts relative URLs to absolute
- Removes duplicates
- Filters out mailto:, tel:, javascript:, data: URLs
- Categorizes into pages vs assets

**Returns:** JSON with two arrays:
- **pages**: HTML documents and navigational URLs
- **assets**: Static resources (js, css, images, fonts, media)

**Usage Examples:**

1. Basic URL extraction:
\`\`\`json
{
  "name": "return_links",
  "arguments": {
    "url": "https://example.com"
  }
}
\`\`\`

2. Extract URLs from protected site:
\`\`\`json
{
  "name": "return_links",
  "arguments": {
    "url": "https://protected-site.com",
    "bypass_level": "generic_level_1"
  }
}
\`\`\`

3. Geo-targeted extraction:
\`\`\`json
{
  "name": "return_links",
  "arguments": {
    "url": "https://example.de",
    "country": "de"
  }
}
\`\`\`
`,
  parameters: returnLinksSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof returnLinksSchema>;
    const apiKey = getApiKey(session);

    const requestParams: Partial<ScrapeOpsRequestParams> = {
      url: params.url,
      return_links: true,
    };

    const usedOptions: UsedOptions = {};

    if (params.country) {
      requestParams.country = params.country;
      usedOptions.country = params.country;
    }
    if (params.residential) {
      requestParams.residential = true;
      usedOptions.residential = true;
    }
    if (params.mobile) {
      requestParams.mobile = true;
      usedOptions.mobile = true;
    }
    if (params.premium) {
      requestParams.premium = params.premium;
      usedOptions.premium = params.premium;
    }
    if (params.bypass_level) {
      requestParams.bypass = params.bypass_level;
      usedOptions.bypass_level = params.bypass_level;
    }
    if (params.session_number) {
      requestParams.session_number = params.session_number;
      usedOptions.session_number = params.session_number;
    }
    if (params.optimize_request) {
      requestParams.optimize_request = true;
      usedOptions.optimize_request = true;
      if (params.max_request_cost) {
        requestParams.max_request_cost = params.max_request_cost;
        usedOptions.max_request_cost = params.max_request_cost;
      }
    }

    const validation = validateParams(usedOptions);

    if (!validation.valid) {
      log.error('Parameter validation failed', { errors: validation.errors });
      return JSON.stringify({
        success: false,
        url: params.url,
        error: 'Invalid parameter combination',
        validation_errors: validation.errors,
      }, null, 2);
    }

    log.info('return_links request', {
      url: params.url,
      options: Object.keys(usedOptions).length > 0 ? usedOptions : 'basic',
    });

    const result = await makeRequest(apiKey, removeEmptyValues(requestParams), log);

    if (result.success) {
      log.info('Links extraction successful');
      const data = result.data as ScrapeOpsResponse;
      return JSON.stringify({
        success: true,
        url: params.url,
        status: data?.status || 'links_extract_successful',
        data: data?.data || data,
      }, null, 2);
    }

    log.warn('Links extraction failed', {
      error: result.error,
      errorType: result.errorType,
      statusCode: result.statusCode,
    });

    return generateErrorResponse(
      params.url,
      result.error || 'Unknown error',
      result.errorType,
      result.statusCode,
      usedOptions,
      result.retriesAttempted || 0
    );
  },
});

// ============================================================================
// Analysis Helpers
// ============================================================================

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function getBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

// -- Anti-Bot Signatures --

interface AntiBotSignature {
  name: string;
  challengePatterns: RegExp[];
  htmlPatterns: RegExp[];
}

const ANTI_BOT_SIGNATURES: AntiBotSignature[] = [
  {
    name: 'Cloudflare',
    challengePatterns: [
      /challenges\.cloudflare\.com/i,
      /cdn-cgi\/challenge-platform/i,
      /__cf_chl_/i,
      /cf-browser-verification/i,
      /Attention Required! \| Cloudflare/i,
      /Just a moment\.\.\.<\/title>/i,
    ],
    htmlPatterns: [
      /cdn-cgi\//i,
      /cf-beacon/i,
      /cloudflareinsights\.com/i,
      /cf-turnstile/i,
    ],
  },
  {
    name: 'DataDome',
    challengePatterns: [
      /captcha\.datadome/i,
      /interstitial\.datadome/i,
    ],
    htmlPatterns: [
      /datadome\.co/i,
      /dd\.js/i,
      /tags\.tiqcdn\.com.*datadome/i,
    ],
  },
  {
    name: 'PerimeterX (HUMAN)',
    challengePatterns: [
      /px-captcha/i,
      /captcha\.px-cdn\.net/i,
    ],
    htmlPatterns: [
      /b\.px-cloud\.net/i,
      /client\.perimeterx\.net/i,
      /_pxhd/i,
    ],
  },
  {
    name: 'Incapsula/Imperva',
    challengePatterns: [
      /_Incapsula_Resource/i,
      /visid_incap_/i,
      /incap_ses_/i,
    ],
    htmlPatterns: [
      /incapsula/i,
      /imperva/i,
    ],
  },
  {
    name: 'Akamai Bot Manager',
    challengePatterns: [
      /ak_bmsc/i,
    ],
    htmlPatterns: [
      /akamaihd\.net/i,
      /akam\//i,
    ],
  },
  {
    name: 'AWS WAF',
    challengePatterns: [
      /aws-waf-token/i,
      /captcha\.awswaf/i,
    ],
    htmlPatterns: [
      /awswaf/i,
    ],
  },
  {
    name: 'Sucuri',
    challengePatterns: [
      /sucuri-cloudproxy/i,
    ],
    htmlPatterns: [
      /sucuri\.net/i,
    ],
  },
  {
    name: 'reCAPTCHA',
    challengePatterns: [],
    htmlPatterns: [
      /google\.com\/recaptcha/i,
      /g-recaptcha/i,
      /grecaptcha/i,
    ],
  },
  {
    name: 'hCaptcha',
    challengePatterns: [],
    htmlPatterns: [
      /hcaptcha\.com/i,
      /h-captcha/i,
    ],
  },
  {
    name: 'Kasada',
    challengePatterns: [],
    htmlPatterns: [
      /kasada\.io/i,
    ],
  },
  {
    name: 'Shape Security (F5)',
    challengePatterns: [],
    htmlPatterns: [
      /shapesecurity\.com/i,
    ],
  },
];

interface AntiBotDetection {
  name: string;
  confidence: 'high' | 'medium' | 'low';
  is_actively_blocking: boolean;
  evidence: string[];
}

function detectAntiBotsInHtml(html: string, requestBlocked: boolean): AntiBotDetection[] {
  const detected: AntiBotDetection[] = [];

  for (const sig of ANTI_BOT_SIGNATURES) {
    const evidence: string[] = [];
    let isBlocking = false;

    for (const pattern of sig.challengePatterns) {
      if (pattern.test(html)) {
        evidence.push(`Challenge pattern: ${pattern.source}`);
        isBlocking = true;
      }
    }
    for (const pattern of sig.htmlPatterns) {
      if (pattern.test(html)) {
        evidence.push(`Presence detected: ${pattern.source}`);
      }
    }

    if (evidence.length > 0) {
      let confidence: 'high' | 'medium' | 'low';
      if (isBlocking || (evidence.length >= 3 && requestBlocked)) {
        confidence = 'high';
      } else if (evidence.length >= 2 || requestBlocked) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }
      detected.push({
        name: sig.name,
        confidence,
        is_actively_blocking: isBlocking && requestBlocked,
        evidence,
      });
    }
  }
  return detected;
}

// -- JS Framework Detection --

interface JSFrameworkDetection {
  name: string;
  rendering_likely_required: boolean;
}

const JS_FRAMEWORK_PATTERNS: { name: string; patterns: RegExp[]; renderingRequired: boolean }[] = [
  { name: 'React', patterns: [/data-reactroot/i, /_reactListening/i, /react-dom/i, /react\.production/i], renderingRequired: true },
  { name: 'Next.js', patterns: [/__NEXT_DATA__/i, /_next\//i], renderingRequired: true },
  { name: 'Vue.js', patterns: [/data-v-[a-f0-9]/i, /vue\.runtime/i, /vue\.global/i], renderingRequired: true },
  { name: 'Nuxt.js', patterns: [/__NUXT__/i, /_nuxt\//i], renderingRequired: true },
  { name: 'Angular', patterns: [/ng-version=/i, /ng-app/i, /zone\.js/i], renderingRequired: true },
  { name: 'Svelte', patterns: [/svelte-[a-z0-9]/i, /__svelte/i], renderingRequired: true },
  { name: 'Gatsby', patterns: [/___gatsby/i, /gatsby-/i], renderingRequired: true },
  { name: 'jQuery', patterns: [/jquery[.\-/]/i], renderingRequired: false },
];

function detectJSFrameworks(html: string): JSFrameworkDetection[] {
  const detected: JSFrameworkDetection[] = [];
  for (const fw of JS_FRAMEWORK_PATTERNS) {
    for (const pattern of fw.patterns) {
      if (pattern.test(html)) {
        detected.push({ name: fw.name, rendering_likely_required: fw.renderingRequired });
        break;
      }
    }
  }
  return detected;
}

// -- Empty SPA container detection --

function detectEmptyContainers(html: string): string[] {
  const emptyPatterns = [
    { pattern: /<div\s+id=["']root["']\s*>\s*<\/div>/i, description: 'Empty #root container (React)' },
    { pattern: /<div\s+id=["']app["']\s*>\s*<\/div>/i, description: 'Empty #app container (Vue)' },
    { pattern: /<div\s+id=["']__next["']\s*>\s*<\/div>/i, description: 'Empty #__next container (Next.js)' },
    { pattern: /<div\s+id=["']__nuxt["']\s*>\s*<\/div>/i, description: 'Empty #__nuxt container (Nuxt)' },
    { pattern: /<div\s+id=["']svelte["']\s*>\s*<\/div>/i, description: 'Empty #svelte container' },
    { pattern: /<div\s+id=["']gatsby-focus-wrapper["']\s*>\s*<\/div>/i, description: 'Empty Gatsby container' },
  ];
  const found: string[] = [];
  for (const ep of emptyPatterns) {
    if (ep.pattern.test(html)) {
      found.push(ep.description);
    }
  }
  return found;
}

function detectNoscriptMessages(html: string): string[] {
  const noscriptPattern = /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi;
  const messages: string[] = [];
  let match;
  while ((match = noscriptPattern.exec(html)) !== null) {
    const text = stripHtmlTags(match[1]).substring(0, 200);
    if (text.length > 10) {
      messages.push(text);
    }
  }
  return messages;
}

// -- Robots.txt parser --

interface RobotsTxtRule {
  user_agent: string;
  disallow: string[];
  allow: string[];
  crawl_delay?: number;
}

// -- Helpers to extract HTML from request results --
function extractHtml(result: RequestResult): string {
  if (!result.success) return '';
  if (typeof result.data === 'string') return result.data;
  if (typeof result.data === 'object' && result.data) {
    const data = result.data as ScrapeOpsResponse;
    if (typeof data.data === 'string') return data.data;
    return JSON.stringify(data);
  }
  return '';
}


// ============================================================================
// Tool 4: analyze_scraping_difficulty
// ============================================================================

/**
 * Calls the Go parser's web-analyzer route: POST /v1/web-analyzer
 * Requires API key auth via query param. Accepts feature flags to control analysis scope.
 */
async function callWebAnalyzer(
  apiKey: string,
  url: string,
  flags: { protections?: boolean; data_extraction?: boolean; legal?: boolean; resources?: boolean },
  log: Logger,
): Promise<WebAnalyzerResponse> {
  const queryParams = new URLSearchParams({
    api_key: apiKey,
    url,
  });
  if (flags.protections) queryParams.set('protections', 'true');
  if (flags.data_extraction) queryParams.set('data_extraction', 'true');
  if (flags.legal) queryParams.set('legal', 'true');
  if (flags.resources) queryParams.set('resources', 'true');

  const endpoint = `${PARSER_BASE_URL}web-analyzer?${queryParams.toString()}`;
  log.info('Calling web-analyzer', { endpoint, url });

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `ScrapeOps-MCP/${ORIGIN}`,
      },
      body: JSON.stringify({ url }),
    },
    'Web analyzer request'
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Web analyzer request failed with status ${response.status}: ${errorText}`);
  }

  return (await response.json()) as WebAnalyzerResponse;
}

/**
 * Maps a scraping_complexity_score (1-5) to a human-readable difficulty level.
 */
function getDifficultyLevel(score: number): string {
  if (score == 1) return 'Very Easy';
  if (score == 2) return 'Easy';
  if (score == 3) return 'Medium';
  if (score == 4) return 'Hard';
  if (score == 5) return 'Very Hard';
  return 'Very Hard';
}

const analyzeDifficultySchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to analyze for scraping difficulty. Must include protocol (http:// or https://)'),
});

server.addTool({
  name: 'analyze_scraping_difficulty',
  description: `Analyze a website URL and determine how difficult it is to scrape.

Returns a difficulty score (1-5), detected anti-bot protections, JavaScript framework requirements, and actionable recommendations.

**Difficulty Levels:**
- 1: Very Easy — static HTML, no protection
- 2: Easy — minor protections or simple dynamic content
- 3: Medium — needs JS rendering or moderate anti-bot
- 4: Hard — strong anti-bot, requires advanced techniques
- 5: Very Hard — multiple strong protections, aggressive blocking

**What it checks:**
- Basic request accessibility and response time
- Anti-bot protection systems (Cloudflare, DataDome, PerimeterX, Akamai, etc.)
- JavaScript frameworks (React, Vue, Angular, Next.js, etc.)
- CSS selector stability
- Rate limiting detection
- Bandwidth and response time analysis
- Residential IP requirements

**Note:** This tool makes 2 API requests (target page + robots.txt).

\`\`\`json
{
  "name": "analyze_scraping_difficulty",
  "arguments": {
    "url": "https://example.com"
  }
}
\`\`\``,
  parameters: analyzeDifficultySchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof analyzeDifficultySchema>;
    const apiKey = getApiKey(session);

    log.info('Analyzing scraping difficulty via web-analyzer', { url: params.url });

    try {
      // Call the Go parser web-analyzer route with protections enabled for anti-bot data
      const analyzerResponse = await callWebAnalyzer(apiKey, params.url, { protections: true }, log);

      const score = Math.min(5, Math.max(1, analyzerResponse.scraping_complexity_score || 1));
      const level = getDifficultyLevel(score);

      // Build factors from the analyzer response
    const factors: { factor: string; impact: string; details: string }[] = [];

      if (analyzerResponse.requires_javascript) {
      factors.push({
          factor: 'JavaScript Rendering Required',
          impact: 'medium',
          details: `Rendering type: ${analyzerResponse.rendering_type || 'unknown'}. Page requires JavaScript rendering to load content.`,
        });
      }

      if (analyzerResponse.anti_bot_measures && analyzerResponse.anti_bot_measures.length > 0) {
        for (const measure of analyzerResponse.anti_bot_measures) {
      factors.push({
            factor: `Anti-Bot: ${measure.provider || measure.type}`,
        impact: 'high',
            details: `${measure.provider || 'Unknown'} ${measure.type} protection detected`,
          });
        }
      }

      if (analyzerResponse.rate_limiting_detected) {
      factors.push({
          factor: 'Rate Limiting Detected',
        impact: 'medium',
          details: `Rate limit: ${analyzerResponse.rate_limit_requests_per_minute} req/min. Strategy: ${analyzerResponse.rate_limit_strategy || 'unknown'}`,
      });
    }

      if (analyzerResponse.requires_residential_ip) {
      factors.push({
          factor: 'Residential IP Required',
          impact: 'high',
          details: analyzerResponse.residential_ip_reason || 'Residential IP proxies are recommended for this site',
        });
      }

      if (analyzerResponse.css_selector_stability && analyzerResponse.css_selector_stability !== 'stable') {
      factors.push({
          factor: 'Unstable CSS Selectors',
          impact: analyzerResponse.css_selector_stability === 'dynamic' ? 'high' : 'medium',
          details: `CSS selectors are ${analyzerResponse.css_selector_stability}, which may require adaptive scraping strategies`,
        });
      }

      if (analyzerResponse.avg_response_time_ms > 5000) {
      factors.push({
        factor: 'Slow Response',
        impact: 'low',
          details: `Average response time is ${analyzerResponse.avg_response_time_ms}ms`,
        });
      }

      // Build recommendations from the analyzer data
    const recommendations: string[] = [];

      if (analyzerResponse.requires_javascript) {
      recommendations.push('Use render_js: true to render JavaScript content');
    }
      if (analyzerResponse.requires_residential_ip) {
        recommendations.push('Use residential: true for residential IP proxies');
      }
      if (analyzerResponse.anti_bot_measures && analyzerResponse.anti_bot_measures.length > 0) {
        const mainBot = analyzerResponse.anti_bot_measures[0];
        const provider = (mainBot.provider || '').toLowerCase();
        if (provider.includes('cloudflare')) {
        recommendations.push("Use bypass_level: 'cloudflare_level_2' to bypass Cloudflare protection");
        } else if (provider.includes('datadome')) {
        recommendations.push("Use bypass_level: 'datadome' to bypass DataDome protection");
        } else if (provider.includes('perimeterx')) {
        recommendations.push("Use bypass_level: 'perimeterx' to bypass PerimeterX protection");
        } else if (provider.includes('incapsula') || provider.includes('imperva')) {
        recommendations.push("Use bypass_level: 'incapsula' to bypass Incapsula/Imperva protection");
      } else {
        recommendations.push("Use bypass_level: 'generic_level_2' or higher to bypass anti-bot protection");
      }
      }
      if (analyzerResponse.rate_limiting_detected) {
        recommendations.push(`Implement rate limiting: max ${analyzerResponse.rate_limit_requests_per_minute} requests/min`);
      }
      if (analyzerResponse.recommended_proxy_type) {
        recommendations.push(`Recommended proxy type: ${analyzerResponse.recommended_proxy_type}`);
    }
    if (score <= 2) {
      recommendations.push('Basic request should work fine — no special options needed.');
    }

    return JSON.stringify({
      success: true,
      difficulty_score: score,
      difficulty_level: level,
      factors,
      recommendations,
    }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Web analyzer request failed', { url: params.url, error: errorMessage });

      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to analyze scraping difficulty: ${errorMessage}`,
        recommendations: [
          'Ensure the Go parser service is running and accessible',
          'Verify your API key is valid',
          'Try again with a different URL',
        ],
      }, null, 2);
    }
  },
});


// ============================================================================
// Tool 5: check_js_rendering
// ============================================================================

const checkJsRenderingSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The webpage URL to check for JavaScript rendering requirements'),
});

server.addTool({
  name: 'check_js_rendering',
  description: `Check whether a webpage requires JavaScript rendering to access its target data.

Makes two requests — one without JS rendering and one with — then compares the results to determine if rendering is needed. Reports what data is missing from the non-rendered version.

**Returns:**
- Whether the page needs rendering (true/false) with explanation
- Content comparison (text lengths, ratios)
- Specific missing data indicators (empty SPA containers, noscript messages)
- Detected JS frameworks

**Note:** This tool makes 2 API requests (basic + rendered).

\`\`\`json
{
  "name": "check_js_rendering",
  "arguments": {
    "url": "https://example.com"
  }
}
\`\`\``,
  parameters: checkJsRenderingSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof checkJsRenderingSchema>;
    const apiKey = getApiKey(session);

    log.info('Checking JS rendering requirements', { url: params.url });

    // Fetch without JS rendering
    const noJsResult = await makeRequest(apiKey, removeEmptyValues({ url: params.url }), log);
    const noJsHtml = extractHtml(noJsResult);

    // Fetch with JS rendering
    const jsResult = await makeRequest(apiKey, removeEmptyValues({ url: params.url, render_js: true }), log);
    const jsHtml = extractHtml(jsResult);

    if (!noJsResult.success && !jsResult.success) {
      return JSON.stringify({
        success: false,
        url: params.url,
        error: 'Both requests failed. The website may be blocking all requests.',
        without_js_error: noJsResult.error,
        with_js_error: jsResult.error,
        recommendation: 'Try using bypass_level and residential options with the maps_web tool.',
      }, null, 2);
    }

    // Compare content
    const noJsText = stripHtmlTags(noJsHtml);
    const jsText = stripHtmlTags(jsHtml);
    const noJsLength = noJsText.length;
    const jsLength = jsText.length;

    const emptyContainers = detectEmptyContainers(noJsHtml);
    const noscriptMessages = detectNoscriptMessages(noJsHtml);
    const noJsFrameworks = detectJSFrameworks(noJsHtml || '');
    const renderedFrameworks = detectJSFrameworks(jsHtml || '');
    const jsFrameworksByName = new Map<string, JSFrameworkDetection>();
    for (const f of noJsFrameworks) jsFrameworksByName.set(f.name, f);
    for (const f of renderedFrameworks) jsFrameworksByName.set(f.name, f);
    const jsFrameworks = Array.from(jsFrameworksByName.values());

    const contentRatio =
      noJsLength === 0 && jsLength > 0
        ? Number.POSITIVE_INFINITY
        : jsLength > 0 && noJsLength > 0
          ? jsLength / noJsLength
          : 0;
    const contentDiff = jsLength - noJsLength;

    const reasons: string[] = [];
    let needsRendering = false;

    if (!noJsResult.success && jsResult.success) {
      needsRendering = true;
      reasons.push('Non-rendered request failed while rendered request succeeded');
    }

    if (contentRatio > 1.5 && contentDiff > 2000) {
      needsRendering = true;
      reasons.push(`Rendered version has ${contentRatio.toFixed(1)}x more text content (${noJsLength} → ${jsLength} chars)`);
    }

    if (emptyContainers.length > 0) {
      needsRendering = true;
      reasons.push(`Empty SPA mount points found: ${emptyContainers.join(', ')}`);
    }

    if (noscriptMessages.length > 0) {
      needsRendering = true;
      reasons.push(`<noscript> messages found: "${noscriptMessages[0].substring(0, 100)}"`);
    }

    if (noJsLength < 500 && jsFrameworks.some(f => f.rendering_likely_required)) {
      needsRendering = true;
      reasons.push(`Very thin non-rendered content (${noJsLength} chars) with JS framework detected`);
    }

    if (contentDiff > 5000 && !reasons.some(r => r.includes('more text content'))) {
      needsRendering = true;
      reasons.push(`${contentDiff} characters of additional text content appear only in the rendered version`);
    }

    const explanation = needsRendering
      ? `Yes, this page requires JavaScript rendering. ${reasons.join('. ')}.`
      : `No, this page does not require JavaScript rendering. The non-rendered version contains sufficient content (${noJsLength} chars of text).`;

    return JSON.stringify({
      success: true,
      url: params.url,
      needs_rendering: needsRendering,
      explanation,
      comparison: {
        without_js: {
          request_success: noJsResult.success,
          status_code: noJsResult.statusCode || (noJsResult.success ? 200 : undefined),
          html_length: noJsHtml.length,
          text_content_length: noJsLength,
          text_preview: noJsText.substring(0, 500) || '(empty)',
        },
        with_js: {
          request_success: jsResult.success,
          status_code: jsResult.statusCode || (jsResult.success ? 200 : undefined),
          html_length: jsHtml.length,
          text_content_length: jsLength,
          text_preview: jsText.substring(0, 500) || '(empty)',
        },
        content_length_ratio: contentRatio > 0 ? parseFloat(contentRatio.toFixed(2)) : null,
        additional_text_from_rendering: contentDiff,
      },
      empty_spa_containers: emptyContainers.length > 0 ? emptyContainers : undefined,
      noscript_messages: noscriptMessages.length > 0 ? noscriptMessages : undefined,
      js_frameworks_detected: jsFrameworks.length > 0 ? jsFrameworks : undefined,
      reasons,
    }, null, 2);
  },
});


// ============================================================================
// Tool 6: detect_anti_bots
// ============================================================================

const detectAntiBotsSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to check for anti-bot protection systems'),
});

server.addTool({
  name: 'detect_anti_bots',
  description: `Detect anti-bot protection systems on a website.

Makes a basic request and analyzes the response for known anti-bot signatures.

**Detects:**
- Cloudflare (challenge pages, Turnstile, CDN indicators)
- DataDome
- PerimeterX / HUMAN
- Incapsula / Imperva
- Akamai Bot Manager
- AWS WAF
- Sucuri
- reCAPTCHA / hCaptcha
- Kasada
- Shape Security (F5)

**Returns:**
- List of detected anti-bot systems with confidence levels (high/medium/low)
- Whether the protection is actively blocking requests
- Evidence for each detection
- Overall protection level (none/low/medium/high)
- Recommended bypass settings for the maps_web tool

\`\`\`json
{
  "name": "detect_anti_bots",
  "arguments": {
    "url": "https://example.com"
  }
}
\`\`\``,
  parameters: detectAntiBotsSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof detectAntiBotsSchema>;
    const apiKey = getApiKey(session);

    log.info('Detecting anti-bot protections', { url: params.url });

    const result = await makeRequest(apiKey, removeEmptyValues({ url: params.url }), log);
    const html = extractHtml(result);
    const requestBlocked = !result.success &&
      (result.statusCode === 403 || result.statusCode === 503);

    const antiBotsDetected = detectAntiBotsInHtml(html || (result.error || ''), requestBlocked);

    // If blocked but we couldn't identify the specific anti-bot
    if (requestBlocked && antiBotsDetected.length === 0) {
      antiBotsDetected.push({
        name: 'Unknown Anti-Bot Protection',
        confidence: 'medium',
        is_actively_blocking: true,
        evidence: [`Request blocked with HTTP ${result.statusCode}`],
      });
    }

    let protectionLevel: string;
    if (antiBotsDetected.length === 0) {
      protectionLevel = 'none';
    } else if (antiBotsDetected.some(d => d.is_actively_blocking)) {
      protectionLevel = 'high';
    } else if (antiBotsDetected.some(d => d.confidence === 'high')) {
      protectionLevel = 'medium';
    } else {
      protectionLevel = 'low';
    }

    // Build bypass recommendations
    let bypassRecommendations: Record<string, unknown> | undefined;
    if (antiBotsDetected.length > 0) {
      const mainBot = antiBotsDetected.find(d => d.is_actively_blocking) || antiBotsDetected[0];
      bypassRecommendations = {};

      if (mainBot.name === 'Cloudflare') {
        bypassRecommendations.suggested_bypass_level = 'cloudflare_level_2';
        bypassRecommendations.render_js = true;
        bypassRecommendations.residential = true;
      } else if (mainBot.name === 'DataDome') {
        bypassRecommendations.suggested_bypass_level = 'datadome';
        bypassRecommendations.residential = true;
      } else if (mainBot.name.includes('PerimeterX')) {
        bypassRecommendations.suggested_bypass_level = 'perimeterx';
        bypassRecommendations.residential = true;
      } else if (mainBot.name.includes('Incapsula')) {
        bypassRecommendations.suggested_bypass_level = 'incapsula';
        bypassRecommendations.residential = true;
      } else {
        bypassRecommendations.suggested_bypass_level = 'generic_level_2';
        bypassRecommendations.residential = true;
        bypassRecommendations.render_js = true;
      }
    }

    return JSON.stringify({
      success: true,
      url: params.url,
      request_status: {
        success: result.success,
        status_code: result.statusCode || (result.success ? 200 : undefined),
        was_blocked: requestBlocked,
      },
      anti_bots_detected: antiBotsDetected,
      total_protections_found: antiBotsDetected.length,
      protection_level: protectionLevel,
      bypass_recommendations: bypassRecommendations,
    }, null, 2);
  },
});


// ============================================================================
// Tool 7: check_scraping_legality
// ============================================================================

const checkLegalitySchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to check for scraping legality and compliance'),
});

server.addTool({
  name: 'check_scraping_legality',
  description: `Check the legal aspects of scraping a website by analyzing its robots.txt and Terms of Service.

Fetches and parses robots.txt, finds Terms of Service / legal pages, and provides a comprehensive legal analysis.

**Returns:**
- robots.txt analysis (allowed/disallowed paths, crawl delays, sitemaps)
- Terms of Service key clauses related to scraping/crawling/automation
- Links to all legal pages found (ToS, Privacy Policy, etc.)
- Overall legal assessment: allowed, restricted, or ambiguous
- Risk level (low/medium/high) and compliance recommendations
- Known lawsuits related to web scraping of this domain
- Legality and lawsuit summaries from curated database

**Note:** This tool makes 2-3 API requests (robots.txt + main page + optionally ToS page).
This analysis is informational only and does not constitute legal advice.

\`\`\`json
{
  "name": "check_scraping_legality",
  "arguments": {
    "url": "https://example.com"
  }
}
\`\`\``,
  parameters: checkLegalitySchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof checkLegalitySchema>;
    const apiKey = getApiKey(session);

    log.info('Checking scraping legality via web-analyzer', { url: params.url });

    try {
      // Call the Go parser web-analyzer route with legal flag enabled
      const analyzerResponse = await callWebAnalyzer(apiKey, params.url, { legal: true }, log);

      const legalData = analyzerResponse.legal_data;
      const lawsuits = analyzerResponse.lawsuits;

      // Build robots.txt analysis from legal_data
    let robotsAnalysis: Record<string, unknown> = { found: false };
      if (legalData?.robots_url) {
      robotsAnalysis = {
        found: true,
          url: legalData.robots_url,
          scraping_status: legalData.robots_allow_ws_status || 'unknown',
          analysis: legalData.robots_allow_ws_text || undefined,
        };
      }

      // Build Terms of Service analysis from legal_data
    let tosAnalysis: Record<string, unknown> = { found: false };
      if (legalData?.terms_url) {
      tosAnalysis = {
        found: true,
          url: legalData.terms_url,
          scraping_status: legalData.terms_allow_ws_status || 'unknown',
          analysis: legalData.terms_allow_ws_text || undefined,
        };
      }

      // Build lawsuit information
      const lawsuitSummaries = lawsuits && lawsuits.length > 0
        ? lawsuits.map(l => ({
            title: l.title,
            description: l.description,
            status: l.status,
            prosecutor: l.prosecutor_name,
            defendant: l.defendant_name,
            jurisdiction: l.jurisdiction,
            impact_level: l.impact_level,
            ws_relevance: l.ws_relevance,
            ws_direct_issue: l.ws_direct_issue,
            means_for_website: l.means_for_ws_website,
            means_for_industry: l.means_for_ws_industry,
            legal_basis: l.legal_basis,
            affected_data_types: l.affected_data_types,
            more_info_links: l.more_info_links,
            date_started: l.date_started,
            date_ended: l.date_ended,
            conclusion: l.conclusion,
          }))
        : [];

      // Determine risk factors and assessment
    const riskFactors: string[] = [];
    const mitigatingFactors: string[] = [];

      // Robots.txt analysis
      const robotsStatus = legalData?.robots_allow_ws_status?.toLowerCase();
      if (robotsStatus === 'blocked' || robotsStatus === 'restricted' || robotsStatus === 'no') {
        riskFactors.push(`robots.txt indicates scraping is ${robotsStatus}: ${legalData?.robots_allow_ws_text || ''}`);
      } else if (robotsStatus === 'allowed' || robotsStatus === 'yes') {
        mitigatingFactors.push(`robots.txt allows scraping: ${legalData?.robots_allow_ws_text || ''}`);
      }

      // Terms of Service analysis
      const termsStatus = legalData?.terms_allow_ws_status?.toLowerCase();
      if (termsStatus === 'blocked' || termsStatus === 'restricted' || termsStatus === 'no') {
        riskFactors.push(`Terms of Service restricts scraping: ${legalData?.terms_allow_ws_text || ''}`);
      } else if (termsStatus === 'allowed' || termsStatus === 'yes') {
        mitigatingFactors.push(`Terms of Service allows scraping: ${legalData?.terms_allow_ws_text || ''}`);
      }

      // Lawsuit analysis
      if (lawsuits && lawsuits.length > 0) {
        const directLawsuits = lawsuits.filter(l => l.ws_direct_issue);
        if (directLawsuits.length > 0) {
          riskFactors.push(`${directLawsuits.length} lawsuit(s) directly related to web scraping of this site`);
        }
        const highImpact = lawsuits.filter(l => l.impact_level === 'high');
        if (highImpact.length > 0) {
          riskFactors.push(`${highImpact.length} high-impact scraping-related lawsuit(s) found`);
        }
        if (directLawsuits.length === 0 && highImpact.length === 0) {
          riskFactors.push(`${lawsuits.length} scraping-related lawsuit(s) found (indirect or low impact)`);
        }
      }

      // Overall assessment
    let overallAssessment: string;
    let riskLevel: string;

    if (riskFactors.length >= 3) {
      overallAssessment = 'restricted';
      riskLevel = 'high';
    } else if (riskFactors.length >= 1) {
      overallAssessment = 'ambiguous';
      riskLevel = 'medium';
    } else {
      overallAssessment = 'likely_allowed';
      riskLevel = 'low';
    }

      // Build recommendations
      const recommendations: string[] = [];
      if (riskFactors.length > 0) {
        recommendations.push('Review the specific risk factors above carefully before scraping');
      }
      if (lawsuits && lawsuits.length > 0) {
        recommendations.push('Review the lawsuit details — this site has a history of legal action related to scraping');
      }
      if (tosAnalysis.found && tosAnalysis.url) {
        recommendations.push(`Review the full Terms of Service at: ${tosAnalysis.url}`);
      }
      if (robotsAnalysis.found && robotsAnalysis.url) {
        recommendations.push(`Review the robots.txt at: ${robotsAnalysis.url}`);
      }
      recommendations.push(
        'Always comply with applicable laws (GDPR, CCPA, CFAA, etc.)',
        'Consider reaching out to the website owner for explicit permission',
        'Avoid scraping personal data without a legal basis',
        'This analysis is informational only and does not constitute legal advice',
      );

    return JSON.stringify({
      success: true,
        url: analyzerResponse.url,
        domain: analyzerResponse.domain,
        analysis_status: analyzerResponse.analysis_status,
      robots_txt: robotsAnalysis,
      terms_of_service: tosAnalysis,
        website_info: legalData ? {
          website: legalData.website,
          category: legalData.website_category,
          summary: legalData.short_summary || legalData.summary,
          popularity_score: legalData.popularity_score,
          legality_summary: legalData.legality_summary,
          lawsuit_summary: legalData.lawsuit_summary,
        } : undefined,
        lawsuits: lawsuitSummaries.length > 0 ? lawsuitSummaries : undefined,
      legal_summary: {
        overall_assessment: overallAssessment,
        risk_level: riskLevel,
        risk_factors: riskFactors,
        mitigating_factors: mitigatingFactors,
          recommendations,
        },
      }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Web analyzer legal check failed', { url: params.url, error: errorMessage });

      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to check scraping legality: ${errorMessage}`,
        recommendations: [
          'Ensure the Go parser service is running and accessible',
          'Verify your API key is valid',
          'Try again with a different URL',
        ],
      }, null, 2);
    }
  },
});


// ============================================================================
// Tool 8: classify_page_type
// ============================================================================

interface DeterminePageTypeResponse {
  status: string;
  data: {
    page_type: string;
    reasoning: string;
    confidence_level: string;
    page_regex: string;
  } | string;
  error?: string;
}

const classifyPageTypeSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to classify. Must include protocol (http:// or https://)'),
});

server.addTool({
  name: 'classify_page_type',
  description: `Classify a webpage into a specific page type to help decide the optimal parsing strategy.

Fetches the page HTML and uses LLM-powered analysis to determine the page type from URL patterns, structured data (LD+JSON, meta tags), and page content.

**Page Type Categories:**
- **General:** home_page, login_page, registration_page, terms_of_service_page, privacy_policy_page, contact_page, about_us_page
- **E-Commerce:** product_page, product_search_page, product_reviews_page, product_category_page, product_seller_page, cart_page
- **Search:** serp_search_page
- **Content:** article_page, article_list_page, author_page
- **Company:** company_page, company_search_page, company_review_page, company_location_page, company_job_page
- **Jobs:** job_page, job_search_page, job_advert_page
- **Real Estate:** real_estate_page, real_estate_search_page, real_estate_profile_page
- **News:** news_page, news_search_page
- **Forum:** forum_page, forum_search_page
- **Social Media:** social_media_post_page, social_media_search_page, social_media_profile_page
- **Error:** 404_page, captcha_page, ban_page, maintenance_page
- **Other:** code_repo_page, event_page, stats_page, faq_page, portfolio_page, unknown

**Returns:**
- Page type classification
- Reasoning for the classification
- Confidence level (low/medium/high/unknown)
- URL regex pattern for matching similar pages

\`\`\`json
{
  "name": "classify_page_type",
  "arguments": {
    "url": "https://example.com/products/blue-widget-123"
  }
}
\`\`\``,
  parameters: classifyPageTypeSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof classifyPageTypeSchema>;
    const apiKey = getApiKey(session);

    log.info('Classifying page type', { url: params.url });

    try {
      // 1. Fetch the page HTML via ScrapeOps proxy
      const fetchResult = await makeRequest(apiKey, removeEmptyValues({ url: params.url }), log);
      const htmlContent = extractHtml(fetchResult);

      if (!htmlContent || htmlContent.length === 0) {
        return JSON.stringify({
          success: false,
          url: params.url,
          error: 'Failed to fetch page HTML. The page may be blocking requests.',
          status_code: fetchResult.statusCode,
          recommendation: 'Try using the browse_webpage tool with render_js or bypass_level options to fetch the page first.',
    }, null, 2);
      }

      // 2. Call the Go parser determine-page-type endpoint
      const endpoint = `${PARSER_BASE_URL}determine-page-type`;
      log.info('Calling determine-page-type', { endpoint, url: params.url });

      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Api_key': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': `ScrapeOps-MCP/${ORIGIN}`,
          },
          body: JSON.stringify({
            url: params.url,
            html_content: htmlContent,
          }),
        },
        'Page type classification (determine-page-type)'
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Page type classification failed with status ${response.status}: ${errorText}`);
      }

      const result = (await response.json()) as DeterminePageTypeResponse;

      if (result.status !== 'valid') {
        return JSON.stringify({
          success: false,
          url: params.url,
          error: `Classification failed: ${result.error || result.status}`,
          recommendation: 'The page content may be insufficient for classification. Try with a different URL.',
        }, null, 2);
      }

      // The data field can be a string (from cache) or an object (from LLM)
      const pageTypeData = typeof result.data === 'string'
        ? { page_type: result.data, reasoning: 'Matched from cached URL pattern', confidence_level: 'high', page_regex: '' }
        : result.data;

      // Build parsing strategy recommendations based on page type
      const parsingRecommendations = getParsingRecommendations(pageTypeData.page_type);

      return JSON.stringify({
        success: true,
        url: params.url,
        classification: {
          page_type: pageTypeData.page_type,
          reasoning: pageTypeData.reasoning,
          confidence_level: pageTypeData.confidence_level,
          page_regex: pageTypeData.page_regex || undefined,
        },
        parsing_strategy: parsingRecommendations,
      }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Page type classification failed', { url: params.url, error: errorMessage });

      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to classify page type: ${errorMessage}`,
        recommendations: [
          'Ensure the Go parser service is running and accessible',
          'Try again with a different URL',
        ],
      }, null, 2);
    }
  },
});

/**
 * Returns parsing strategy recommendations based on the classified page type.
 */
function getParsingRecommendations(pageType: string): {
  approach: string;
  data_schema?: string;
  key_fields: string[];
  tips: string[];
} {
  const recommendations: Record<string, { approach: string; data_schema?: string; key_fields: string[]; tips: string[] }> = {
    product_page: {
      approach: 'Structured extraction — target product details, pricing, and availability',
      data_schema: 'product_page',
      key_fields: ['name', 'price', 'description', 'images', 'availability', 'reviews', 'sku', 'brand'],
      tips: ['Check for LD+JSON Product schema', 'Look for price in meta tags', 'Images often in og:image or gallery containers'],
    },
    product_search_page: {
      approach: 'List extraction — iterate over product cards/tiles in search results',
      data_schema: 'product_search_page',
      key_fields: ['product_name', 'price', 'url', 'image', 'rating', 'review_count'],
      tips: ['Look for repeating CSS patterns for product cards', 'Pagination links for next pages', 'Check for total results count'],
    },
    product_category_page: {
      approach: 'List extraction — similar to search results but organized by category',
      data_schema: 'product_search_page',
      key_fields: ['product_name', 'price', 'url', 'image', 'category', 'subcategory'],
      tips: ['Check for breadcrumb navigation', 'Category filters in sidebar', 'May have subcategory links'],
    },
    article_page: {
      approach: 'Content extraction — target article body, metadata, and author info',
      key_fields: ['title', 'author', 'published_date', 'content', 'tags', 'category'],
      tips: ['Check for article schema in LD+JSON', 'Main content usually in <article> tag', 'Published date often in <time> element'],
    },
    article_list_page: {
      approach: 'List extraction — iterate over article cards/summaries',
      key_fields: ['title', 'url', 'excerpt', 'author', 'date', 'image'],
      tips: ['Look for repeating article preview patterns', 'Pagination or infinite scroll', 'RSS feed link may exist'],
    },
    serp_search_page: {
      approach: 'Search results extraction — parse individual result entries',
      data_schema: 'serp_search_page',
      key_fields: ['title', 'url', 'snippet', 'position', 'featured_snippets'],
      tips: ['Results typically in ordered list or repeated divs', 'Check for ads vs organic results', 'Related searches at bottom'],
    },
    job_page: {
      approach: 'Structured extraction — target job details and requirements',
      data_schema: 'job_page',
      key_fields: ['title', 'company', 'location', 'salary', 'description', 'requirements', 'posted_date'],
      tips: ['Check for JobPosting schema in LD+JSON', 'Apply button link', 'Company info section'],
    },
    job_search_page: {
      approach: 'List extraction — iterate over job listing cards',
      data_schema: 'job_search_page',
      key_fields: ['title', 'company', 'location', 'salary_range', 'url', 'posted_date'],
      tips: ['Pagination or load-more buttons', 'Filter sidebar for location/salary', 'Sort options'],
    },
    real_estate_page: {
      approach: 'Structured extraction — target property details and pricing',
      data_schema: 'real_estate_page',
      key_fields: ['address', 'price', 'bedrooms', 'bathrooms', 'square_feet', 'description', 'images', 'agent'],
      tips: ['Check for RealEstateListing schema', 'Photo gallery for property images', 'Map embed for location'],
    },
    real_estate_search_page: {
      approach: 'List extraction — iterate over property listing cards',
      data_schema: 'real_estate_search_page',
      key_fields: ['address', 'price', 'bedrooms', 'bathrooms', 'url', 'image'],
      tips: ['Map view vs list view', 'Filter by price/beds/location', 'Pagination or infinite scroll'],
    },
    company_page: {
      approach: 'Structured extraction — target company profile information',
      data_schema: 'company_page',
      key_fields: ['name', 'description', 'industry', 'location', 'employees', 'website', 'founded'],
      tips: ['Check for Organization schema in LD+JSON', 'About section for key details', 'Social media links'],
    },
    home_page: {
      approach: 'Navigation extraction — identify key sections and links for crawling deeper pages',
      key_fields: ['navigation_links', 'featured_content', 'categories', 'search_form'],
      tips: ['Use as starting point for site crawl', 'Identify main content categories', 'Look for sitemap link'],
    },
    news_page: {
      approach: 'Content extraction — similar to article page, focus on news-specific metadata',
      key_fields: ['headline', 'author', 'published_date', 'content', 'source', 'category'],
      tips: ['Check for NewsArticle schema in LD+JSON', 'Byline for author info', 'Related articles section'],
    },
  };

  const defaultRec = {
    approach: 'General extraction — analyze page structure and extract visible content',
    data_schema: undefined,
    key_fields: ['title', 'content', 'links', 'images'],
    tips: ['Inspect the page HTML structure', 'Look for repeating patterns', 'Check for structured data in LD+JSON or meta tags'],
  };

  return recommendations[pageType] || defaultRec;
}


// ============================================================================
// Tool 9: identify_data_sources
// ============================================================================

const identifyDataSourcesSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to analyze for data source identification. Must include protocol (http:// or https://)'),
});

server.addTool({
  name: 'identify_data_sources',
  description: `Identify where the key data is sourced from on a webpage.

Fetches the page with both simple HTTP and JavaScript rendering (capturing XHR/API calls), then uses LLM analysis to determine whether target data comes from static HTML, embedded JSON (e.g. JSON-LD, Next.js data), API/XHR calls, or inline JavaScript variables.

**Data Source Types:**
- **raw_html** — Data is in static HTML elements (e.g. product titles, article text, meta tags)
- **network_requests** — Data is loaded via XHR/API calls (e.g. dynamic product listings, search results, pagination)
- **embedded_json** — Data is in embedded JSON structures (e.g. JSON-LD schema, Next.js __NEXT_DATA__, inline script tags)

**Returns:**
- Data source breakdown with locations identified
- Extracted data items with exact values, CSS selectors, and source type
- Recommendations for the best scraping approach
- Page type classification

**Note:** This analysis fetches the page with JS rendering to capture network requests.

\`\`\`json
{
  "name": "identify_data_sources",
  "arguments": {
    "url": "https://example.com/products/blue-widget"
  }
}
\`\`\``,
  parameters: identifyDataSourcesSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof identifyDataSourcesSchema>;
    const apiKey = getApiKey(session);

    log.info('Identifying data sources', { url: params.url });

    try {
      // Call web-analyzer with data_extraction flag to trigger LLM data location analysis
      const analyzerResponse = await callWebAnalyzer(
        apiKey,
        params.url,
        { data_extraction: true },
        log,
      );

      const dataLocations = analyzerResponse.data_locations || [];
      const extractedData = analyzerResponse.extracted_data || [];

      // Group extracted data by source type
      const dataBySource: Record<string, typeof extractedData> = {};
      for (const item of extractedData) {
        const sourceType = item.type || 'unknown';
        if (!dataBySource[sourceType]) {
          dataBySource[sourceType] = [];
        }
        dataBySource[sourceType].push(item);
      }

      // Build source breakdown
      const sourceBreakdown: Record<string, {
        found: boolean;
        item_count: number;
        fields: { name: string; value: string; selector: string }[];
        description: string;
      }> = {};

      const sourceDescriptions: Record<string, string> = {
        raw_html: 'Data embedded directly in static HTML elements — available without JavaScript rendering',
        network_requests: 'Data loaded dynamically via XHR/API calls — requires JS rendering or direct API access',
        embedded_json: 'Data in structured JSON (JSON-LD, Next.js __NEXT_DATA__, inline scripts) — parseable without rendering',
      };

      for (const sourceType of ['raw_html', 'network_requests', 'embedded_json']) {
        const items = dataBySource[sourceType] || [];
        sourceBreakdown[sourceType] = {
          found: dataLocations.includes(sourceType),
          item_count: items.length,
          fields: items.map(item => ({
            name: item.name,
            value: item.value.length > 200 ? item.value.substring(0, 200) + '...' : item.value,
            selector: item.source,
          })),
          description: sourceDescriptions[sourceType] || 'Unknown data source',
        };
      }

      // Determine primary data source
      let primarySource = 'raw_html';
      let maxItems = 0;
      for (const [sourceType, items] of Object.entries(dataBySource)) {
        if (items.length > maxItems) {
          maxItems = items.length;
          primarySource = sourceType;
        }
      }

      // Build extraction strategy based on primary source
      const extractionStrategy = buildExtractionStrategy(primarySource, dataLocations, analyzerResponse.requires_javascript);

      return JSON.stringify({
        success: true,
        url: analyzerResponse.url,
        domain: analyzerResponse.domain,
        page_type: analyzerResponse.page_type,
        analysis_status: analyzerResponse.analysis_status,
        data_sources: {
          locations_identified: dataLocations,
          primary_source: primarySource,
          breakdown: sourceBreakdown,
        },
        extracted_data: extractedData.map(item => ({
          id: item.id,
          parent_id: item.parent_id || undefined,
          name: item.name,
          value: item.value.length > 500 ? item.value.substring(0, 500) + '...' : item.value,
          type: item.type,
          source: item.source,
        })),
        extraction_strategy: extractionStrategy,
        requires_javascript: analyzerResponse.requires_javascript,
        rendering_type: analyzerResponse.rendering_type,
      }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Data source identification failed', { url: params.url, error: errorMessage });

      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to identify data sources: ${errorMessage}`,
        recommendations: [
          'Ensure the Go parser service is running and accessible',
          'Verify your API key is valid',
          'Try again with a different URL',
        ],
      }, null, 2);
    }
  },
});

/**
 * Builds an extraction strategy recommendation based on the identified data sources.
 */
function buildExtractionStrategy(
  primarySource: string,
  dataLocations: string[],
  requiresJs: boolean,
): {
  recommended_approach: string;
  steps: string[];
  scrapeops_options: Record<string, unknown>;
  tips: string[];
} {
  if (primarySource === 'network_requests') {
    return {
      recommended_approach: 'API/XHR Interception — data is loaded dynamically via API calls',
      steps: [
        '1. Use render_js: true to capture XHR/API calls during page load',
        '2. Identify the API endpoint URLs from the network requests',
        '3. Call the API endpoints directly for structured JSON data (faster and more reliable)',
        '4. If API requires authentication cookies, use session_number to maintain sessions',
        '5. Implement pagination by following the API\'s pagination parameters',
      ],
      scrapeops_options: {
        render_js: true,
        json_response: true,
      },
      tips: [
        'Direct API calls are faster and return structured data — prefer over HTML parsing',
        'Check API response headers for pagination info (Link, X-Total-Count, etc.)',
        'API responses are usually JSON — no HTML parsing needed',
        'Watch for API rate limits — they may be stricter than page-level limits',
      ],
    };
  }

  if (primarySource === 'embedded_json') {
    return {
      recommended_approach: 'Embedded JSON Extraction — data is in structured JSON within the page',
      steps: [
        '1. Fetch the page with a basic request (render_js may not be needed)',
        '2. Parse JSON-LD from <script type="application/ld+json"> tags',
        '3. Check for Next.js data in <script id="__NEXT_DATA__"> or window.__NEXT_DATA__',
        '4. Look for other inline JSON in <script> tags (e.g., window.__INITIAL_STATE__)',
        '5. Parse the JSON directly — no HTML selector logic needed',
      ],
      scrapeops_options: {
        render_js: false,
      },
      tips: [
        'JSON-LD often contains the most complete product/article data',
        'Next.js __NEXT_DATA__ contains the full page props — very rich data source',
        'Embedded JSON is the most reliable source — not affected by CSS changes',
        'No JavaScript rendering needed — faster and cheaper requests',
      ],
    };
  }

  // Default: raw_html
  return {
    recommended_approach: 'HTML Parsing — data is in static HTML elements',
    steps: [
      requiresJs
        ? '1. Fetch the page with render_js: true (page requires JavaScript to load content)'
        : '1. Fetch the page with a basic request (no JavaScript rendering needed)',
      '2. Use CSS selectors to target specific data elements',
      '3. Extract text content from the identified HTML elements',
      '4. Handle any data that spans multiple elements (e.g., price + currency)',
      '5. Implement pagination by following next-page links',
    ],
    scrapeops_options: {
      render_js: requiresJs,
      ...(dataLocations.includes('network_requests') ? { json_response: true } : {}),
    },
    tips: [
      'Use specific CSS selectors — IDs and semantic class names are most stable',
      'Avoid selectors that depend on layout (nth-child, position-based)',
      'Check for CSS selector stability — dynamic class names may change between deploys',
      requiresJs
        ? 'This page requires JavaScript rendering — use render_js: true'
        : 'JavaScript rendering is not required — basic requests are faster and cheaper',
      ...(dataLocations.includes('embedded_json')
        ? ['Also check embedded JSON (JSON-LD) as a more reliable alternative for some fields']
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers for analyze_api_endpoints: segment requests and describe API usage
// ---------------------------------------------------------------------------

function getTargetDataUrls(extractedData: { type?: string; source?: string }[]): Set<string> {
  const urls = new Set<string>();
  for (const item of extractedData || []) {
    if (item.type === 'network_requests' && item.source) {
      try {
        const u = new URL(item.source);
        u.hash = '';
        const normalized = u.toString().replace(/\/$/, '');
        urls.add(normalized);
        urls.add(item.source);
      } catch {
        urls.add(item.source);
      }
    }
  }
  return urls;
}

function requestUrlMatchesTarget(url: string, targetUrls: Set<string>): boolean {
  try {
    const u = new URL(url);
    u.hash = '';
    const normalized = u.toString().replace(/\/$/, '');
    if (targetUrls.has(normalized) || targetUrls.has(url)) return true;
    for (const t of targetUrls) {
      if (normalized.startsWith(t) || t.startsWith(normalized)) return true;
    }
  } catch {
    if (targetUrls.has(url)) return true;
  }
  return false;
}

function parseQueryParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(url);
    u.searchParams.forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    // ignore
  }
  return out;
}

function getAuthRequirements(headers: Record<string, unknown> | undefined): string[] {
  const auth: string[] = [];
  if (!headers || typeof headers !== 'object') return auth;
  const h = headers as Record<string, string>;
  if (h['authorization'] || h['Authorization']) auth.push('Authorization header present');
  if (h['cookie'] || h['Cookie']) auth.push('Cookie header (session/auth cookies may be required)');
  if (h['x-api-key'] || h['X-Api-Key'] || h['x-auth-token'] || h['X-Auth-Token']) auth.push('API key or auth token in header');
  if (auth.length === 0) auth.push('None detected from request headers (may still require cookies or session)');
  return auth;
}

const PAGINATION_KEYS: Record<string, string[]> = {
  page: ['page', 'current_page', 'currentPage', 'p'],
  page_size: ['per_page', 'page_size', 'pageSize', 'limit', 'size'],
  total_items: ['total', 'total_items', 'totalItems', 'count'],
  total_pages: ['total_pages', 'totalPages', 'pages'],
  next: ['next', 'next_page', 'nextPage', 'hasNext', 'next_cursor', 'cursor'],
  offset: ['offset', 'skip'],
};

function detectPaginationInResponse(body: string | undefined): Record<string, unknown> | null {
  if (!body || body.length > 256 * 1024) return null;
  const cleaned = body.replace(/^\s*(?:while\s*\(\s*1\s*\)\s*;|\)\]\}\'\}\s*|for\s*\(\s*;\s*;\s*\)\s*;|\)\]\}')\s*/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const pagination: Record<string, unknown> = {};
  const scan = (node: unknown, depth: number): void => {
    if (depth > 2) return;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const obj = node as Record<string, unknown>;
      for (const [target, candidates] of Object.entries(PAGINATION_KEYS)) {
        for (const key of candidates) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            pagination[target] = obj[key];
          }
        }
      }
      for (const key of ['pagination', 'paging', 'meta', 'pageInfo', 'page_info']) {
        if (obj[key] && typeof obj[key] === 'object') {
          scan(obj[key], depth + 1);
        }
      }
    } else if (Array.isArray(node) && node.length > 0) {
      scan(node[0], depth + 1);
    }
  };
  scan(parsed, 0);
  return Object.keys(pagination).length > 0 ? pagination : null;
}

function sampleTopLevelFields(body: string | undefined): string[] {
  if (!body || body.length > 64 * 1024) return [];
  try {
    const parsed = JSON.parse(body.replace(/^\s*(?:while\s*\(\s*1\s*\)\s*;|\)\]\}\'\}\s*)\s*/i, '').trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).slice(0, 10);
    }
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
      return Object.keys(parsed[0] as object).slice(0, 10);
    }
  } catch {
    // ignore
  }
  return [];
}

function buildEndpointAnalysis(
  req: NetworkRequestResult,
  options: { isTargetData: boolean },
): ApiEndpointAnalysis {
  const query = parseQueryParams(req.url);
  let bodyParams: Record<string, unknown> | undefined;
  if (req.request_body) {
    try {
      const b = JSON.parse(req.request_body);
      if (b && typeof b === 'object') bodyParams = b as Record<string, unknown>;
    } catch {
      // leave undefined
    }
  }
  const pagination = detectPaginationInResponse(req.response_body);
  return {
    endpoint: {
      url: req.url,
      method: req.method || 'GET',
      status_code: req.status_code,
    },
    parameters: {
      query,
      ...(bodyParams ? { body: bodyParams } : {}),
    },
    authentication_requirements: getAuthRequirements(req.request_headers),
    pagination_strategy: pagination,
    contains_target_data: options.isTargetData,
    sample_fields: sampleTopLevelFields(req.response_body),
  };
}

// ============================================================================
// Tool 10: analyze_api_endpoints
// ============================================================================

const analyzeApiEndpointsSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to analyze. Fetches the page with JS rendering to capture network requests, then segments them and describes API usage.'),
});

server.addTool({
  name: 'analyze_api_endpoints',
  description: `Analyze captured network requests to identify which return primary/target data and how to use them for API scraping (replace browser scraping with API scraping when possible).

Uses the web-analyzer API to load the page with JavaScript rendering, capture XHR/fetch requests, then:
- Identifies which requests contain the target data (from data location analysis and extracted_data)
- Segments all requests into "contains target data" vs "does not contain"
- For each request that contains target data: describes endpoint, parameters, authentication requirements, and pagination strategy

**Returns:**
- **primary_data_requests**: Requests that return the main page data (products, listings, search results, etc.) with full API endpoint details
- **other_requests**: Requests that do not contain target data (assets, analytics, scripts, etc.)
- **all_requests_segmented**: Same network requests grouped into contains_target_data and does_not_contain_target_data
- **endpoint details**: For each primary request: URL, method, query/body parameters, auth requirements, pagination strategy

\`\`\`json
{
  "name": "analyze_api_endpoints",
  "arguments": {
    "url": "https://example.com/products"
  }
}
\`\`\``,
  parameters: analyzeApiEndpointsSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger },
  ): Promise<string> => {
    const params = args as z.infer<typeof analyzeApiEndpointsSchema>;
    const apiKey = getApiKey(session);

    log.info('Analyzing API endpoints from network requests', { url: params.url });

    try {
      const analyzerResponse = await callWebAnalyzer(
        apiKey,
        params.url,
        { data_extraction: true },
        log,
      );

      const networkRequests = (analyzerResponse.network_requests || []) as NetworkRequestResult[];
      const extractedData = analyzerResponse.extracted_data || [];
      const targetUrls = getTargetDataUrls(extractedData);

      const containsTargetData: NetworkRequestResult[] = [];
      const doesNotContainTargetData: NetworkRequestResult[] = [];

      const dataLocations = analyzerResponse.data_locations || [];
      const preferNetworkRequests = dataLocations.includes('network_requests') || dataLocations.includes('api_endpoints');

      for (const req of networkRequests) {
        let isTarget = requestUrlMatchesTarget(req.url, targetUrls);
        if (!isTarget && preferNetworkRequests && targetUrls.size === 0 && (req.request_type === 'xhr' || req.request_type === 'fetch') &&
            (req.data_format === 'json' || (req.content_type || '').includes('json')) && req.status_code === 200 &&
            (req.response_body?.length ?? 0) > 0) {
          isTarget = true;
        }
        if (isTarget) {
          containsTargetData.push(req);
        } else {
          doesNotContainTargetData.push(req);
        }
      }

      const primaryDataAnalyses: ApiEndpointAnalysis[] = containsTargetData.map((req) =>
        buildEndpointAnalysis(req, { isTargetData: true }),
      );

      const otherRequestsSummary = doesNotContainTargetData.map((req) => ({
        url: req.url,
        method: req.method,
        status_code: req.status_code,
        content_type: req.content_type,
        request_type: req.request_type,
      }));

      return JSON.stringify({
        success: true,
        url: analyzerResponse.url,
        domain: analyzerResponse.domain,
        page_type: analyzerResponse.page_type,
        data_locations: analyzerResponse.data_locations || [],
        primary_data_requests: primaryDataAnalyses,
        other_requests: otherRequestsSummary,
        all_requests_segmented: {
          contains_target_data: containsTargetData.map((r) => ({
            url: r.url,
            method: r.method,
            status_code: r.status_code,
            content_type: r.content_type,
          })),
          does_not_contain_target_data: doesNotContainTargetData.map((r) => ({
            url: r.url,
            method: r.method,
            status_code: r.status_code,
            content_type: r.content_type,
          })),
        },
        summary: {
          total_captured: networkRequests.length,
          with_target_data: containsTargetData.length,
          without_target_data: doesNotContainTargetData.length,
        },
      }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('analyze_api_endpoints failed', { url: params.url, error: errorMessage });
      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to analyze API endpoints: ${errorMessage}`,
      }, null, 2);
    }
  },
});


// ============================================================================
// Tool 11: detect_tech_stack
// ============================================================================

const detectTechStackSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to analyze. Must include protocol (http:// or https://)'),
});

server.addTool({
  name: 'detect_tech_stack',
  description: `Detect the technology stack used to build a webpage.

Analyzes both the page HTML and network requests to identify frameworks, libraries, CMS platforms, CSS frameworks, ecommerce platforms, analytics tools, payment processors, and build tools.

**Detectable Technologies:**
- **Frameworks:** React, Next.js, Vue.js, Nuxt.js, Angular, Svelte, SolidJS, Qwik, Astro, Remix, Gatsby, Eleventy
- **Libraries:** jQuery, HTMX, Alpine.js, Turbo, Stimulus
- **CMS:** WordPress, Strapi, Sanity
- **CSS Frameworks:** Bootstrap, Tailwind CSS
- **Ecommerce:** Shopify, WooCommerce, BigCommerce, Magento
- **Analytics:** Google Analytics
- **Payment:** Stripe
- **Build Tools:** Vite

**Returns:**
- List of detected technologies with their type and version (when available)
- Grouped technologies by category
- Rendering characteristics (SSR, CSR, SSG, ISR)
- Whether JavaScript rendering is required for scraping
- CSS selector stability assessment
- Scraping implications of the detected stack

\`\`\`json
{
  "name": "detect_tech_stack",
  "arguments": {
    "url": "https://example.com"
  }
}
\`\`\``,
  parameters: detectTechStackSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof detectTechStackSchema>;
    const apiKey = getApiKey(session);

    log.info('Detecting tech stack', { url: params.url });

    try {
      // Call web-analyzer — technology detection always runs (no special flag needed)
      const analyzerResponse = await callWebAnalyzer(
        apiKey,
        params.url,
        {},
        log,
      );

      const technologies = analyzerResponse.detected_technologies || [];

      // Group technologies by category
      const grouped: Record<string, { name: string; version: string }[]> = {};
      for (const tech of technologies) {
        const category = techTypeLabel(tech.type);
        if (!grouped[category]) {
          grouped[category] = [];
        }
        grouped[category].push({
          name: tech.name,
          version: tech.version || '',
        });
      }

      // Derive scraping implications from the stack
      const implications = deriveTechStackImplications(
        technologies,
        analyzerResponse.rendering_type,
        analyzerResponse.requires_javascript,
        analyzerResponse.css_selector_stability,
      );

      return JSON.stringify({
        success: true,
        url: analyzerResponse.url,
        domain: analyzerResponse.domain,
        page_type: analyzerResponse.page_type,
        tech_stack: {
          technologies: technologies.map(t => ({
            name: t.name,
            type: t.type,
            category: techTypeLabel(t.type),
            version: t.version || undefined,
          })),
          by_category: grouped,
          count: technologies.length,
        },
        rendering: {
          type: analyzerResponse.rendering_type,
          requires_javascript: analyzerResponse.requires_javascript,
          css_selector_stability: analyzerResponse.css_selector_stability,
        },
        scraping_implications: implications,
      }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Tech stack detection failed', { url: params.url, error: errorMessage });

      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to detect tech stack: ${errorMessage}`,
        recommendations: [
          'Ensure the Go parser service is running and accessible',
          'Verify your API key is valid',
          'Try again with a different URL',
        ],
      }, null, 2);
    }
  },
});

/**
 * Maps technology type codes to human-readable category labels.
 */
function techTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    framework: 'Frameworks',
    library: 'Libraries',
    css_framework: 'CSS Frameworks',
    cms: 'CMS',
    ecommerce: 'Ecommerce Platforms',
    analytics: 'Analytics',
    payment: 'Payment',
    build_tool: 'Build Tools',
    unknown: 'Other',
  };
  return labels[type] || 'Other';
}

/**
 * Derives scraping-relevant implications from the detected tech stack.
 */
function deriveTechStackImplications(
  technologies: { name: string; type: string; version: string }[],
  renderingType: string,
  requiresJs: boolean,
  cssSelectorStability: string,
): {
  rendering_approach: string;
  data_loading_pattern: string;
  selector_strategy: string;
  tips: string[];
} {
  const techNames = new Set(technologies.map(t => t.name));

  // Determine rendering approach
  let renderingApproach: string;
  if (requiresJs) {
    if (techNames.has('Next.js') || techNames.has('Nuxt.js') || techNames.has('Remix') || techNames.has('Astro')) {
      renderingApproach = 'Hybrid SSR/CSR — initial HTML is server-rendered but dynamic content may require JavaScript. Use render_js: true for complete data.';
    } else if (techNames.has('React') || techNames.has('Vue.js') || techNames.has('Angular') || techNames.has('Svelte') || techNames.has('SolidJS')) {
      renderingApproach = 'Client-Side Rendering (CSR) — page content is rendered by JavaScript in the browser. render_js: true is required.';
    } else {
      renderingApproach = `JavaScript rendering required (${renderingType}). Use render_js: true to get full page content.`;
    }
  } else {
    if (techNames.has('Next.js') || techNames.has('Nuxt.js') || techNames.has('Gatsby') || techNames.has('Astro') || techNames.has('Eleventy')) {
      renderingApproach = 'Server-Side Rendered / Static — HTML contains full content. Basic HTTP requests are sufficient, no JavaScript rendering needed.';
    } else if (techNames.has('WordPress')) {
      renderingApproach = 'Server-Side Rendered (WordPress) — HTML is fully rendered by the server. Basic HTTP requests work well.';
    } else {
      renderingApproach = 'Static / Server-Rendered — page content is in the initial HTML. No JavaScript rendering needed.';
    }
  }

  // Determine data loading pattern
  let dataLoadingPattern: string;
  if (techNames.has('Next.js')) {
    dataLoadingPattern = 'Next.js — check for __NEXT_DATA__ JSON in the HTML (contains page props), plus potential API routes at /api/* paths.';
  } else if (techNames.has('Nuxt.js')) {
    dataLoadingPattern = 'Nuxt.js — check for __NUXT__ data payload embedded in the HTML, plus Nuxt API routes.';
  } else if (techNames.has('Gatsby')) {
    dataLoadingPattern = 'Gatsby — static HTML with data pre-baked at build time. Also check /page-data/ JSON files for structured data.';
  } else if (techNames.has('Shopify')) {
    dataLoadingPattern = 'Shopify — product data available via structured JSON-LD, plus Shopify product.json endpoints (append .json to product URLs).';
  } else if (techNames.has('WordPress') || techNames.has('WooCommerce')) {
    dataLoadingPattern = 'WordPress — check for wp-json REST API (/wp-json/wp/v2/*), structured data in HTML, and WooCommerce product endpoints.';
  } else if (techNames.has('React') || techNames.has('Vue.js') || techNames.has('Angular')) {
    dataLoadingPattern = 'SPA framework — data is typically loaded via XHR/API calls. Use render_js: true and inspect network requests for API endpoints.';
  } else if (techNames.has('HTMX') || techNames.has('Turbo')) {
    dataLoadingPattern = 'Progressive enhancement — initial HTML contains data, with AJAX fragments loaded for updates. Parse the HTML directly.';
  } else {
    dataLoadingPattern = 'Standard HTML — data is embedded directly in page markup. Parse HTML elements using CSS selectors.';
  }

  // Determine selector strategy
  let selectorStrategy: string;
  if (cssSelectorStability === 'stable' || cssSelectorStability === 'high') {
    selectorStrategy = 'CSS selectors are stable — safe to use class names and IDs for targeting elements.';
  } else if (cssSelectorStability === 'medium') {
    selectorStrategy = 'CSS selectors have moderate stability — prefer data attributes and semantic tags over class names that may change.';
  } else if (techNames.has('Tailwind CSS')) {
    selectorStrategy = 'Tailwind CSS detected — avoid Tailwind utility classes as selectors (they are verbose and may change). Use semantic HTML tags, IDs, or data attributes instead.';
  } else {
    selectorStrategy = 'CSS selectors may be unstable — use data attributes, IDs, or structural selectors (tag names) for more reliable targeting.';
  }

  // Build tips
  const tips: string[] = [];

  if (requiresJs) {
    tips.push('Use render_js: true in your requests to get JavaScript-rendered content.');
  } else {
    tips.push('No JavaScript rendering needed — basic HTTP requests will return full content (faster and cheaper).');
  }

  if (techNames.has('Next.js')) {
    tips.push('Next.js: Extract data from the <script id="__NEXT_DATA__"> tag for structured JSON — often the most complete data source.');
  }
  if (techNames.has('Nuxt.js')) {
    tips.push('Nuxt.js: Look for window.__NUXT__ in the page source for pre-loaded data.');
  }
  if (techNames.has('Shopify')) {
    tips.push('Shopify: Append .json to product/collection URLs for structured API access (e.g., /products/item.json).');
  }
  if (techNames.has('WordPress')) {
    tips.push('WordPress: The REST API at /wp-json/wp/v2/ provides structured data access without HTML parsing.');
  }
  if (techNames.has('WooCommerce')) {
    tips.push('WooCommerce: Product data may be available at /wp-json/wc/v3/ endpoints.');
  }
  if (techNames.has('Gatsby')) {
    tips.push('Gatsby: Check /page-data/*.json files for pre-built data payloads.');
  }
  if (techNames.has('React') || techNames.has('Vue.js') || techNames.has('Angular')) {
    tips.push('SPA detected: Intercept API calls during page load for the cleanest data extraction.');
  }
  if (techNames.has('Tailwind CSS')) {
    tips.push('Tailwind CSS: Do not use Tailwind utility classes as CSS selectors — they are too long and may change. Target semantic elements instead.');
  }
  if (techNames.has('Google Analytics')) {
    tips.push('Google Analytics present — be mindful of request tracking. Use appropriate headers to reduce fingerprinting.');
  }
  if (techNames.has('Stripe')) {
    tips.push('Stripe detected — this page processes payments. Pricing data may be loaded dynamically via Stripe APIs.');
  }

  if (tips.length === 0) {
    tips.push('Standard HTML page — use CSS selectors to extract data from the rendered HTML.');
  }

  return {
    rendering_approach: renderingApproach,
    data_loading_pattern: dataLoadingPattern,
    selector_strategy: selectorStrategy,
    tips,
  };
}


// ============================================================================
// Tool 11: check_css_selectors
// ============================================================================

interface CSSSelectorStabilityResponse {
  css_selector_stability: string;
  is_dynamic: boolean;
  is_obfuscated: boolean;
  analysis_method: string;
  successful_requests: number;
  total_requests: number;
  selector_comparison: {
    stability_score?: number;
    random_ratio?: number;
    average_entropy?: number;
    common_selectors?: number;
    changing_selectors?: number;
    total_unique?: number;
    structured_dynamic?: number;
    responses_analyzed?: number;
    status?: string;
    [key: string]: unknown;
  } | null;
  errors: string[] | null;
}

const checkCssSelectorsSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to analyze CSS selector stability for. Must include protocol (http:// or https://)'),
});

server.addTool({
  name: 'check_css_selectors',
  description: `Analyze the stability of CSS selectors on a webpage to determine if they are static, auto-generated, or obfuscated.

Makes multiple JS-rendered requests to the same URL and compares the CSS classes, IDs, and data attributes across responses. This reveals whether selectors change between page loads (dynamic/auto-generated) or remain consistent (stable).

**Classification:**
- **stable** — Selectors are identical across requests. Safe to use class names and IDs for scraping.
- **dynamic** — Some selectors change between requests (e.g., CSS Modules with hash suffixes, build-time generated classes). Use structural selectors or data attributes instead.
- **obfuscated** — Selectors appear random/high-entropy (e.g., Tailwind JIT, styled-components hash classes). Avoid class-based selectors entirely.

**Analysis Method:**
- Fetches the page 3 times with JavaScript rendering
- Extracts all CSS classes, IDs, and data attributes from each response
- Compares fingerprints: if all match, selectors are stable
- If mismatched, performs entropy analysis to distinguish dynamic from obfuscated
- Computes stability score, random ratio, and average entropy

**Returns:**
- Stability classification (stable / dynamic / obfuscated)
- Whether selectors are dynamic or obfuscated (boolean flags)
- Detailed comparison metrics (stability score, random ratio, entropy)
- Count of common vs changing selectors
- Recommended selector strategies based on the findings

\`\`\`json
{
  "name": "check_css_selectors",
  "arguments": {
    "url": "https://example.com/products"
  }
}
\`\`\``,
  parameters: checkCssSelectorsSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof checkCssSelectorsSchema>;
    const apiKey = getApiKey(session);

    log.info('Checking CSS selector stability', { url: params.url });

    try {
      // Call the dedicated css-selector-stability endpoint for full detail
      const endpoint = `${PARSER_BASE_URL}web-analyzer/css-selector-stability`;
      log.info('Calling css-selector-stability endpoint', { endpoint, url: params.url });

      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Api_key': apiKey,
            'User-Agent': `ScrapeOps-MCP/${ORIGIN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: params.url }),
        },
        'CSS selector stability request'
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`CSS selector stability request failed with status ${response.status}: ${errorText}`);
      }

      const data: CSSSelectorStabilityResponse = await response.json();

      const comparison = data.selector_comparison || {};
      const stabilityScore = typeof comparison.stability_score === 'number' ? comparison.stability_score : null;
      const randomRatio = typeof comparison.random_ratio === 'number' ? comparison.random_ratio : null;
      const avgEntropy = typeof comparison.average_entropy === 'number' ? comparison.average_entropy : null;

      // Build human-readable assessment
      const assessment = buildSelectorAssessment(data, stabilityScore, randomRatio, avgEntropy);

      return JSON.stringify({
        success: true,
        url: params.url,
        classification: data.css_selector_stability,
        is_dynamic: data.is_dynamic,
        is_obfuscated: data.is_obfuscated,
        analysis: {
          method: data.analysis_method,
          successful_requests: data.successful_requests,
          total_requests: data.total_requests,
          metrics: {
            stability_score: stabilityScore,
            random_ratio: randomRatio,
            average_entropy: avgEntropy,
            common_selectors: comparison.common_selectors ?? null,
            changing_selectors: comparison.changing_selectors ?? null,
            total_unique_selectors: comparison.total_unique ?? null,
            structured_dynamic: comparison.structured_dynamic ?? null,
          },
          errors: data.errors?.length ? data.errors : undefined,
        },
        assessment: assessment.summary,
        selector_strategy: assessment.strategy,
        recommendations: assessment.recommendations,
      }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('CSS selector stability check failed', { url: params.url, error: errorMessage });

      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to check CSS selector stability: ${errorMessage}`,
        recommendations: [
          'Verify your API key is valid',
          'Try again with a different URL',
        ],
      }, null, 2);
    }
  },
});

/**
 * Builds a human-readable assessment and recommendations from CSS selector stability data.
 */
function buildSelectorAssessment(
  data: CSSSelectorStabilityResponse,
  stabilityScore: number | null,
  randomRatio: number | null,
  avgEntropy: number | null,
): {
  summary: string;
  strategy: { approach: string; use: string[]; avoid: string[] };
  recommendations: string[];
} {
  const stability = data.css_selector_stability;

  if (stability === 'stable') {
    const scoreText = stabilityScore !== null ? ` (stability score: ${(stabilityScore * 100).toFixed(0)}%)` : '';
    return {
      summary: `CSS selectors are stable${scoreText}. Class names and IDs are consistent across page loads — safe to use for scraping.`,
      strategy: {
        approach: 'Standard CSS selectors — class names and IDs are reliable',
        use: [
          'CSS class selectors (e.g., .product-title, .price)',
          'ID selectors (e.g., #product-name)',
          'Data attributes (e.g., [data-product-id])',
          'Combined selectors for precision (e.g., .product-card .title)',
        ],
        avoid: [
          'Overly long selector chains that break on minor DOM changes',
          'Position-based selectors like :nth-child() unless necessary',
        ],
      },
      recommendations: [
        'CSS selectors are stable — you can reliably use class names and IDs.',
        'Prefer semantic class names over structural selectors for maintainability.',
        'Use data-* attributes when available — they are typically the most stable.',
        'Test selectors periodically, as stability can change with site updates.',
      ],
    };
  }

  if (stability === 'obfuscated') {
    const entropyText = avgEntropy !== null ? ` (avg entropy: ${avgEntropy.toFixed(2)})` : '';
    const randomText = randomRatio !== null ? ` ${(randomRatio * 100).toFixed(0)}% of selectors appear random.` : '';
    return {
      summary: `CSS selectors are obfuscated${entropyText}.${randomText} Class names appear auto-generated with high randomness (e.g., hash-based names from CSS-in-JS, styled-components, or Tailwind JIT). Do NOT rely on class names.`,
      strategy: {
        approach: 'Avoid class-based selectors entirely — use structural and attribute-based targeting',
        use: [
          'Semantic HTML tags (e.g., h1, h2, article, main, nav, section)',
          'Data attributes (e.g., [data-testid], [data-product-id])',
          'ARIA attributes (e.g., [role="heading"], [aria-label])',
          'Tag + attribute combinations (e.g., input[name="price"])',
          'XPath for complex structural targeting',
          'JSON-LD or embedded JSON as an alternative to HTML parsing',
        ],
        avoid: [
          'CSS class selectors — they change on every build/deploy',
          'ID selectors unless they are clearly semantic (not hashed)',
          'Any selector containing random strings or hash-like patterns',
        ],
      },
      recommendations: [
        'Class names are obfuscated — do NOT use them in scraping selectors.',
        'Use semantic HTML elements (h1, article, main) and data-* attributes instead.',
        'Check for JSON-LD or embedded JSON data — often more reliable than parsing obfuscated HTML.',
        'Use the identify_data_sources tool to check if data is available via API/XHR calls (avoids HTML parsing entirely).',
        'Consider using XPath expressions with text content matching for last-resort targeting.',
        'If using render_js, use the extract_data tool with LLM mode — it can handle obfuscated selectors.',
      ],
    };
  }

  if (stability === 'dynamic') {
    const scoreText = stabilityScore !== null ? ` (stability score: ${(stabilityScore * 100).toFixed(0)}%)` : '';
    const changingCount = data.selector_comparison?.changing_selectors;
    const changingText = typeof changingCount === 'number' ? ` ${changingCount} selectors change between loads.` : '';
    return {
      summary: `CSS selectors are partially dynamic${scoreText}.${changingText} Some selectors change between page loads (likely CSS Modules or build-time generated suffixes), but many remain consistent.`,
      strategy: {
        approach: 'Mixed strategy — use stable selectors where possible, avoid dynamic ones',
        use: [
          'ID selectors (usually more stable than classes)',
          'Data attributes (e.g., [data-testid], [data-id])',
          'Stable class names (semantic names without hash suffixes)',
          'Attribute selectors with partial matching (e.g., [class*="product"])',
          'Tag-based selectors for structural navigation',
        ],
        avoid: [
          'Class names with hash suffixes (e.g., .product-card_a3x7f)',
          'Classes that contain random alphanumeric sequences',
          'Full class name matching — use partial/contains matching if needed',
        ],
      },
      recommendations: [
        'Some selectors are dynamic — look for patterns with stable base names and changing hash suffixes.',
        'Use partial class matching (e.g., [class*="product"]) to match the stable prefix while ignoring the dynamic suffix.',
        'Prefer data-* attributes and IDs over class names.',
        'Check for JSON-LD or embedded JSON as a more stable data source.',
        'Monitor for selector changes — dynamic selectors may shift on each deployment.',
      ],
    };
  }

  // Unknown / insufficient data
  return {
    summary: `Unable to determine CSS selector stability — insufficient data (${data.successful_requests}/${data.total_requests} requests succeeded).`,
    strategy: {
      approach: 'Conservative — assume selectors may be unstable',
      use: [
        'Semantic HTML tags (h1, h2, article, main)',
        'Data attributes',
        'ID selectors',
        'JSON-LD or embedded JSON data',
      ],
      avoid: [
        'Class-based selectors until stability is confirmed',
        'Complex selector chains',
      ],
    },
    recommendations: [
      'The analysis could not complete — the page may be blocking automated requests.',
      'Try running analyze_scraping_difficulty to check for anti-bot protections.',
      'Consider using detect_anti_bots to identify specific protection systems.',
      'If the page is accessible via browser, try with render_js: true.',
    ],
  };
}


// ============================================================================
// Tool 12: generate_data_schema
// ============================================================================

interface DataSchemaResponse {
  status: string;
  page_type: string;
  schema_file?: string;
  schema?: Record<string, unknown>;
  message?: string;
  supported_types?: string[];
}

const generateDataSchemaSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The website URL to generate a data schema for. Must include protocol (http:// or https://)'),
  page_type: z
    .string()
    .optional()
    .describe('Optional page type override. If not provided, the page will be classified automatically. Examples: product_page, job_page, real_estate_page'),
});

server.addTool({
  name: 'generate_data_schema',
  description: `Generate a clean JSON data schema for extracting structured data from a webpage.

Automatically classifies the page type (or accepts a manual override), then returns the appropriate barebones data schema with field names, types, required/optional status, and recommended null values.

**How it works:**
1. If no page_type is provided, the tool first classifies the page using LLM analysis
2. Looks up the matching data schema from the ScrapeOps schema library
3. Returns a stripped-down schema (no internal descriptions or priority flags) ready for use

**Supported page types with schemas:**
- **E-Commerce:** product_page, product_search_page, product_reviews_page, product_category_page, product_seller_page
- **Search Engines:** serp_search_page, image_search_page, video_search_page, article_search_page
- **Jobs:** job_page, job_search_page, job_advert_page
- **Company:** company_page, company_review_page, company_location_page, company_job_page, company_social_media_page
- **Real Estate:** real_estate_page, real_estate_search_page, real_estate_profile_page

**Schema fields include:**
- Field name (the JSON key)
- Type (string, number, boolean, list, object)
- Required status (true/false)
- Null value (recommended default when data is missing)
- Nested structure (items for arrays, properties for objects)
- Enum values (allowed values where applicable)

\`\`\`json
{
  "name": "generate_data_schema",
  "arguments": {
    "url": "https://example.com/products/blue-widget"
  }
}
\`\`\``,
  parameters: generateDataSchemaSchema,
  execute: async (
    args: unknown,
    { session, log }: { session?: SessionData; log: Logger }
  ): Promise<string> => {
    const params = args as z.infer<typeof generateDataSchemaSchema>;
    const apiKey = getApiKey(session);

    log.info('Generating data schema', { url: params.url, page_type: params.page_type });

    try {
      // Step 1: Determine the page type
      let pageType = params.page_type;
      let classificationInfo: {
        page_type: string;
        reasoning?: string;
        confidence_level?: string;
      } | undefined;

      if (!pageType) {
        // Classify the page automatically
        log.info('No page_type provided, classifying page', { url: params.url });

        const fetchResult = await makeRequest(apiKey, removeEmptyValues({ url: params.url }), log);
        const htmlContent = extractHtml(fetchResult);

        if (!htmlContent || htmlContent.length === 0) {
          return JSON.stringify({
            success: false,
            url: params.url,
            error: 'Failed to fetch page HTML for classification.',
            status_code: fetchResult.statusCode,
            recommendation: 'Provide the page_type parameter manually, or try a different URL.',
          }, null, 2);
        }

        // Call determine-page-type
        const classifyEndpoint = `${PARSER_BASE_URL}determine-page-type`;
        const classifyResponse = await fetchWithTimeout(
          classifyEndpoint,
          {
            method: 'POST',
            headers: {
              'Api_key': apiKey,
              'Content-Type': 'application/json',
              'User-Agent': `ScrapeOps-MCP/${ORIGIN}`,
            },
            body: JSON.stringify({ url: params.url, html_content: htmlContent }),
          },
          'Page classification (determine-page-type)'
        );

        if (!classifyResponse.ok) {
          const errorText = await classifyResponse.text().catch(() => '');
          throw new Error(`Page classification failed with status ${classifyResponse.status}: ${errorText}`);
        }

        const classifyResult = (await classifyResponse.json()) as DeterminePageTypeResponse;

        if (classifyResult.status !== 'valid') {
          return JSON.stringify({
            success: false,
            url: params.url,
            error: `Page classification failed: ${classifyResult.error || classifyResult.status}`,
            recommendation: 'Provide the page_type parameter manually.',
          }, null, 2);
        }

        const classifyData = typeof classifyResult.data === 'string'
          ? { page_type: classifyResult.data, reasoning: 'Matched from cached URL pattern', confidence_level: 'high' }
          : classifyResult.data;

        pageType = classifyData.page_type;
        classificationInfo = {
          page_type: classifyData.page_type,
          reasoning: classifyData.reasoning,
          confidence_level: classifyData.confidence_level,
        };
      }

      // Step 2: Fetch the barebones schema for this page type
      const schemaEndpoint = `${PARSER_BASE_URL}web-analyzer/data-schema`;
      log.info('Fetching data schema', { endpoint: schemaEndpoint, page_type: pageType });

      const schemaResponse = await fetchWithTimeout(
        schemaEndpoint,
        {
          method: 'POST',
          headers: {
            'Api_key': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': `ScrapeOps-MCP/${ORIGIN}`,
          },
          body: JSON.stringify({ page_type: pageType }),
        },
        'Data schema request'
      );

      if (!schemaResponse.ok) {
        const errorText = await schemaResponse.text().catch(() => '');
        throw new Error(`Data schema request failed with status ${schemaResponse.status}: ${errorText}`);
      }

      const schemaData: DataSchemaResponse = await schemaResponse.json();

      if (schemaData.status === 'no_schema') {
        return JSON.stringify({
          success: false,
          url: params.url,
          page_type: pageType,
          error: `No pre-built schema available for page type: ${pageType}`,
          supported_types: schemaData.supported_types,
          classification: classificationInfo,
          recommendation: 'This page type does not have a pre-built schema. Use the identify_data_sources tool to discover available data fields, or provide one of the supported page types.',
        }, null, 2);
      }

      // Step 3: Build the response with schema and usage guidance
      const fieldSummary = summarizeSchemaFields(schemaData.schema || {});

      return JSON.stringify({
        success: true,
        url: params.url,
        page_type: pageType,
        classification: classificationInfo,
        schema: schemaData.schema,
        summary: {
          total_fields: fieldSummary.totalFields,
          required_fields: fieldSummary.requiredFields,
          optional_fields: fieldSummary.optionalFields,
          field_types: fieldSummary.fieldTypes,
          top_level_fields: fieldSummary.topLevelFields,
        },
        usage: {
          description: `Use this schema as a template for extracting structured data from ${pageType} pages.`,
          tips: [
            'Fields marked "required": true are expected on most pages of this type.',
            'Use the "null_value" as the default when a field cannot be found.',
            'Fields with "type": "list" contain arrays — check the "items" sub-schema for the array element structure.',
            'Fields with "type": "object" are nested — check the "properties" sub-schema.',
            'Fields with "enum" should be constrained to the listed values.',
            'Use this schema with the extract_data tool (LLM mode) for automatic extraction.',
          ],
        },
      }, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Data schema generation failed', { url: params.url, error: errorMessage });

      return JSON.stringify({
        success: false,
        url: params.url,
        error: `Failed to generate data schema: ${errorMessage}`,
        recommendations: [
          'Ensure the Go parser service is running and accessible',
          'Verify your API key is valid',
          'Try providing the page_type parameter manually',
        ],
      }, null, 2);
    }
  },
});

/**
 * Summarizes a schema's top-level field structure.
 */
function summarizeSchemaFields(schema: Record<string, unknown>): {
  totalFields: number;
  requiredFields: number;
  optionalFields: number;
  fieldTypes: Record<string, number>;
  topLevelFields: string[];
} {
  let totalFields = 0;
  let requiredFields = 0;
  let optionalFields = 0;
  const fieldTypes: Record<string, number> = {};
  const topLevelFields: string[] = [];

  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    totalFields++;
    topLevelFields.push(fieldName);

    const def = fieldDef as Record<string, unknown> | undefined;
    if (def) {
      const fieldType = (def.type as string) || 'unknown';
      fieldTypes[fieldType] = (fieldTypes[fieldType] || 0) + 1;

      if (def.required === true) {
        requiredFields++;
      } else {
        optionalFields++;
      }
    }
  }

  return { totalFields, requiredFields, optionalFields, fieldTypes, topLevelFields };
}


// ============================================================================
// Server Startup
// ============================================================================

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

if (port) {
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      port,
    },
  });
  console.error(`ScrapeOps MCP Server running on port ${port} (SSE transport)`);
  console.error(`Endpoint: http://localhost:${port}/sse`);
} else {
  await server.start({
    transportType: 'stdio',
  });
}
