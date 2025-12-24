import { jest } from '@jest/globals';

// Set test timeout
jest.setTimeout(30000);

// Mock ScrapeOps API responses
const mockHtmlResponse = `
<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1>Test Content</h1>
  <p>This is test content from ScrapeOps proxy.</p>
</body>
</html>
`;

const mockJsonResponse = {
  success: true,
  data: {
    title: 'Test Product',
    price: 99.99,
    description: 'Test product description',
  },
  initial_status_code: 200,
  final_status_code: 200,
};

const mockScreenshotResponse = {
  success: true,
  screenshot: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  initial_status_code: 200,
  final_status_code: 200,
};

const mockExtractResponse = {
  success: true,
  data: {
    product_name: 'Test Product',
    price: '$99.99',
    availability: 'In Stock',
    reviews_count: 150,
    rating: 4.5,
  },
};

// Mock global fetch
const mockFetch = jest.fn().mockImplementation(async (url: string) => {
  const urlObj = new URL(url);
  const params = Object.fromEntries(urlObj.searchParams.entries());

  // Determine response based on parameters
  if (params.screenshot === 'true') {
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => mockScreenshotResponse,
      text: async () => JSON.stringify(mockScreenshotResponse),
    };
  }

  if (params.llm_extract === 'true' || params.auto_extract) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => mockExtractResponse,
      text: async () => JSON.stringify(mockExtractResponse),
    };
  }

  if (params.json_response === 'true') {
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => mockJsonResponse,
      text: async () => JSON.stringify(mockJsonResponse),
    };
  }

  // Default HTML response
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/html']]),
    json: async () => { throw new Error('Not JSON'); },
    text: async () => mockHtmlResponse,
  };
});

// @ts-expect-error - Mock global fetch
global.fetch = mockFetch;

// Export mocks for test assertions
export {
  mockFetch,
  mockHtmlResponse,
  mockJsonResponse,
  mockScreenshotResponse,
  mockExtractResponse,
};
