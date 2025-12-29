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

type AdvancedParam = typeof ADVANCED_PARAMS[number];


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

const BASE_URL = 'http://localhost:9000/v1/';
const ORIGIN = 'mcp-scrapeops';

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
