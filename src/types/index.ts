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


// ============================================================================
// WebAnalyzer Response Types (mirrors Go parser webAnalyzer/types/types.go)
// ============================================================================

export interface DetectedTechnology {
  name: string;
  type: string;
  version: string;
}

export interface AntiBotMeasure {
  type: string;
  provider: string;
}

export interface ExtractedDataItem {
  id: string;
  parent_id?: string;
  name: string;
  value: string;
  type: string;
  source: string;
}

export interface WebAnalyzerResponse {
  id?: number;
  url: string;
  domain: string;
  analysis_status: string;
  analysis_started_at: string;
  analysis_completed_at?: string;
  error_message?: string;

  account_id?: number;
  matrix?: Record<string, boolean>;

  page_type: string;
  classification_method: string;
  classification_confidence: number;
  detected_technologies: DetectedTechnology[];
  rendering_type: string;
  requires_javascript: boolean;
  css_selector_stability: string;

  anti_bot_measures: AntiBotMeasure[] | null;
  rate_limiting_detected: boolean;
  rate_limit_requests_per_minute: number;
  rate_limit_strategy: string;
  rate_limit_headers: Record<string, unknown> | null;
  bandwidth_per_page_kb: number;
  avg_response_time_ms: number;
  total_network_bytes_kb: number;
  recommended_proxy_type: string;
  scraping_complexity_score: number;
  estimated_cost_per_request: number;
  recommended_approach: string;
  next_steps: string;

  data_locations: string[] | null;
  extracted_data: ExtractedDataItem[] | null;
  network_requests?: NetworkRequestResult[] | null;

  requires_residential_ip: boolean;
  residential_ip_reason: string;

  lawsuits: Lawsuit[] | null;
  legal_data: MarketingWebsiteDetails | null;
  resources: unknown | null;
}

export interface Lawsuit {
  website?: string;
  title?: string;
  description?: string;
  prosecutor_name?: string;
  prosecutor_location?: string;
  prosecutor_claims?: string;
  jurisdiction?: string;
  affected_data_types?: string;
  defendant_name?: string;
  defendant_location?: string;
  defendant_claims?: string;
  status?: string;
  date_started?: string;
  date_ended?: string;
  conclusion?: string;
  ws_relevance?: string;
  ws_direct_issue?: boolean;
  means_for_ws_website?: string;
  means_for_ws_industry?: string;
  public_data?: string;
  more_info_links?: string[];
  impact_level?: string;
  legal_basis?: string;
}

export interface MarketingWebsiteDetails {
  website?: string;
  website_domain?: string;
  website_homepage_url?: string;
  website_image_url?: string;
  summary?: string;
  short_summary?: string;
  difficulty_score?: number;
  difficulty_category?: string;
  website_category?: string;
  popularity_score?: number;
  robots_url?: string;
  robots_allow_ws_status?: string;
  robots_allow_ws_text?: string;
  terms_url?: string;
  terms_allow_ws_status?: string;
  terms_allow_ws_text?: string;
  subdomains?: Record<string, unknown>;
  legality_summary?: string;
  lawsuit_summary?: string;
}

// Network request from web-analyzer (mirrors Go types.NetworkRequestResult)
export interface NetworkRequestResult {
  request_type: string;
  method: string;
  url: string;
  is_same_domain: boolean;
  request_headers?: Record<string, unknown>;
  response_headers?: Record<string, unknown>;
  status_code: number;
  content_type: string;
  response_time_ms: number;
  request_body?: string;
  response_body?: string;
  data_format: string;
  errors?: string[];
  sequence_number: number;
  initiated_by: string;
  request_id?: string;
  resource_type?: string;
  parsed_request_body?: unknown;
  parsed_response_body?: unknown;
}

// API endpoint analysis for "replace browser scraping with API scraping"
export interface ApiEndpointAnalysis {
  endpoint: {
    url: string;
    method: string;
    status_code: number;
  };
  parameters: {
    query: Record<string, string>;
    body?: Record<string, unknown>;
  };
  authentication_requirements: string[];
  pagination_strategy: Record<string, unknown> | null;
  contains_target_data: boolean;
  sample_fields?: string[];
  key_fields?: string[];
}

// Segmented network requests for API endpoint response
export interface SegmentedNetworkRequests {
  contains_target_data: NetworkRequestResult[];
  does_not_contain_target_data: NetworkRequestResult[];
}
