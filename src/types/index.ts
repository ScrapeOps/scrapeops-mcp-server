
export type { Logger, TransportArgs, ToolContext, ToolExecute } from 'firecrawl-fastmcp';


export interface SessionData {
  scrapeOpsApiKey?: string;
  [key: string]: unknown;
}

export interface AuthenticateRequest {
  headers?: Record<string, string | string[] | undefined>;
}

export interface ScrapeOpsResponse {
  data?: string;
  screenshot?: string;
  status?: string;
  initial_status_code?: number;
  final_status_code?: number;
  url?: string;
  [key: string]: unknown;
}

export type ErrorType = 
  | 'auth_failed'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'bad_gateway'
  | 'service_unavailable'
  | 'network_error'
  | 'unknown';

export interface RequestResult {
  success: boolean;
  data?: ScrapeOpsResponse | string;
  error?: string;
  errorType?: ErrorType;
  statusCode?: number;
  retriesAttempted?: number;
}


export interface ScrapeOpsRequestParams {
  url: string;
  api_key?: string;
  country?: string;
  residential?: boolean;
  mobile?: boolean;
  premium?: string;
  render_js?: boolean;
  wait_for?: string;
  wait?: number;
  scroll?: number;
  screenshot?: boolean;
  json_response?: boolean;
  bypass?: string;
  device_type?: string;
  follow_redirects?: boolean;
  initial_status_code?: boolean;
  final_status_code?: boolean;
  keep_headers?: boolean;
  session_number?: number;
  optimize_request?: boolean;
  max_request_cost?: number;
  auto_extract?: boolean;
  llm_extract?: boolean;
  llm_data_schema?: string;
  llm_extract_response_type?: string;
  return_links?: boolean;
}

export interface UsedOptions {
  country?: string;
  residential?: boolean;
  mobile?: boolean;
  premium?: string;
  render_js?: boolean;
  wait_for?: string;
  wait?: number;
  scroll?: number;
  screenshot?: boolean;
  bypass_level?: string;
  device_type?: string;
  follow_redirects?: boolean;
  return_status_codes?: boolean;
  keep_headers?: boolean;
  session_number?: number;
  optimize_request?: boolean;
  max_request_cost?: number;
}


export interface ValidationParams {
  render_js?: boolean;
  wait_for?: string;
  scroll?: number;
  screenshot?: boolean;
  optimize_request?: boolean;
  bypass_level?: string;
  premium?: string;
  session_number?: number;
  max_request_cost?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface SuggestedAdvancedParams {
  residential?: boolean;
  bypass_level?: string;
  render_js?: boolean;
}

export interface ErrorResponse {
  success: false;
  url: string;
  error: string;
  error_type: ErrorType | 'unknown';
  status_code: number | undefined;
  retries_attempted: number;
  options_used: string | UsedOptions;
  permission_request?: {
    message: string;
    question: string;
    suggested_options: SuggestedAdvancedParams;
    estimated_additional_cost: string;
    action_required: string;
  };
  diagnostic?: {
    message: string;
    tried_options: string[];
    possible_causes: string[];
    recommendations: string[];
  };
}

