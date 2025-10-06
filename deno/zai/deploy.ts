// Deno Deploy version of ZtoApi - Self-contained version
// Optimized for serverless deployment with no file system access

// Configuration constants
const DEFAULT_KEY = Deno.env.get("DEFAULT_KEY") || "sk-your-key";
const MODEL_NAME = Deno.env.get("MODEL_NAME") || "glm-4.5";
const DEBUG_MODE = (Deno.env.get("DEBUG_MODE") || "false").toLowerCase() === "true";
const DEFAULT_STREAM = (Deno.env.get("DEFAULT_STREAM") || "true").toLowerCase() === "true";
const DASHBOARD_ENABLED = (Deno.env.get("DASHBOARD_ENABLED") || "true").toLowerCase() === "true";
const ENABLE_THINKING = (Deno.env.get("ENABLE_THINKING") || "false").toLowerCase() === "true";
const UPSTREAM_TOKEN = Deno.env.get("UPSTREAM_TOKEN") || Deno.env.get("ZAI_TOKEN") || "";
const X_FE_VERSION = Deno.env.get("X_FE_VERSION") || "prod-fe-1.0.94";

// Platform configuration
const PLATFORM_ID = Deno.env.get("PLATFORM_ID") || "zread";
const PROVIDER_NAME = Deno.env.get("PROVIDER_NAME") || "zread.ai";
const PROVIDER_BRAND = Deno.env.get("PROVIDER_BRAND") || "zread.ai";
const PROVIDER_HOME_URL = Deno.env.get("PROVIDER_HOME_URL") || "https://zread.ai";
const ORIGIN_BASE = Deno.env.get("ORIGIN_BASE") || "https://zread.ai";
const PLATFORM_API_BASE = Deno.env.get("PLATFORM_API_BASE") || "https://zread.ai";
const UPSTREAM_URL = Deno.env.get("UPSTREAM_URL") || "https://zread.ai/api/v1/talk";
const REFERER_PREFIX = Deno.env.get("REFERER_PREFIX") || "/chat/";
const DEFAULT_UPSTREAM_MODEL_ID = Deno.env.get("DEFAULT_UPSTREAM_MODEL_ID") || "glm-4.5";

// Model routing configuration
let MODEL_PLATFORM_MAP: Record<string, {platform: string, upstream: string}> = {};
try {
  const mapStr = Deno.env.get("MODEL_PLATFORM_MAP") || "{}";
  MODEL_PLATFORM_MAP = JSON.parse(mapStr);
} catch (e) {
  console.warn("Failed to parse MODEL_PLATFORM_MAP:", e);
  MODEL_PLATFORM_MAP = {
    [MODEL_NAME]: {platform: "zread", upstream: DEFAULT_UPSTREAM_MODEL_ID}
  };
}

// Performance optimization: connection pool for upstream requests
const connectionCache = new Map<string, ConnectionInfo>();

interface ConnectionInfo {
  lastUsed: number;
  keepAlive: boolean;
  requestCount: number;
}

// Request cache for identical requests (short TTL)
const requestCache = new Map<string, CachedResponse>();

interface CachedResponse {
  data: string;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

// In-memory stats for Deno Deploy (no persistent storage)
let totalRequests = 0;
let successfulRequests = 0;
let failedRequests = 0;
let totalResponseTime = 0;
const modelUsage = new Map<string, number>();
const recentRequests: Array<{
  timestamp: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  model?: string;
  platform?: string;
}> = [];

// Keep only last 50 requests in memory
function addRecentRequest(request: any) {
  recentRequests.push(request);
  if (recentRequests.length > 50) {
    recentRequests.shift();
  }
}

// Cleanup expired cache entries periodically
function cleanupCache() {
  const now = Date.now();
  for (const [key, response] of requestCache.entries()) {
    if (now - response.timestamp > response.ttl) {
      requestCache.delete(key);
    }
  }

  // Cleanup old connection cache entries
  for (const [key, conn] of connectionCache.entries()) {
    if (now - conn.lastUsed > 30000) { // 30 seconds
      connectionCache.delete(key);
    }
  }
}

// Generate cache key for requests
function generateCacheKey(request: any): string {
  const model = request.model;
  const messages = JSON.stringify(request.messages);
  const stream = request.stream || false;
  return `${model}:${messages.substring(0, 100)}:${stream}`;
}

// Get cached response if available
function getCachedResponse(cacheKey: string): string | null {
  const cached = requestCache.get(cacheKey);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.timestamp > cached.ttl) {
    requestCache.delete(cacheKey);
    return null;
  }

  return cached.data;
}

// Cache response for future use
function setCachedResponse(cacheKey: string, data: string, ttl: number = 300000) { // 5 minutes default
  requestCache.set(cacheKey, {
    data,
    timestamp: Date.now(),
    ttl
  });
}

// Model routing
interface ModelResolution {
  platform: string;
  platformId: string;
  clientModel: string;
  upstreamModelId: string;
  originBase: string;
  refererPrefix: string;
}

function resolveModelRouting(requestedModel?: string): ModelResolution {
  const input = requestedModel?.trim() || MODEL_NAME;
  const key = input.toLowerCase();

  let route = MODEL_PLATFORM_MAP[key];
  if (!route) {
    // Fallback to default
    route = {platform: "zread", upstream: DEFAULT_UPSTREAM_MODEL_ID};
  }

  return {
    platform: route.platform,
    platformId: route.platform,
    clientModel: input,
    upstreamModelId: route.upstream,
    originBase: ORIGIN_BASE,
    refererPrefix: REFERER_PREFIX
  };
}

function listExposedModels() {
  return Object.keys(MODEL_PLATFORM_MAP).map(model => ({
    id: model,
    platformId: MODEL_PLATFORM_MAP[model].platform,
    upstreamModelId: MODEL_PLATFORM_MAP[model].upstream
  }));
}

function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function buildReferer(chatID: string): string {
  const prefix = REFERER_PREFIX.endsWith("/") ? REFERER_PREFIX : `${REFERER_PREFIX}/`;
  return `${normalizeOrigin(ORIGIN_BASE)}${prefix}${chatID}`;
}

// Browser fingerprint generator
function generateBrowserHeaders(chatID: string, authToken: string): Record<string, string> {
  const chromeVersion = Math.floor(Math.random() * 3) + 138; // 138-140

  const userAgents = [
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
  ];

  const platforms = ['"Windows"', '"macOS"', '"Linux"'];
  const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
  const randomPlatform = platforms[Math.floor(Math.random() * platforms.length)];
  const origin = normalizeOrigin(ORIGIN_BASE);

  return {
    "Content-Type": "application/json; charset=utf-8",
    "Accept": "*/*",
    "User-Agent": randomUA,
    "Authorization": `Bearer ${authToken}`,
    "Origin": origin,
    "Referer": buildReferer(chatID),
    "X-FE-Version": X_FE_VERSION,
    "sec-ch-ua": `"Not)A;Brand";v="8", "Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": randomPlatform,
    "Accept-Charset": "utf-8",
    "Connection": "keep-alive"
  };
}

// Get anonymous token with timeout protection
async function getAnonymousTokenWithTimeout(): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const authUrl = `${PLATFORM_API_BASE}/api/v1/auths/`;
    const response = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Accept": "application/json; charset=utf-8",
        "Accept-Charset": "utf-8"
      },
      body: JSON.stringify({
        "anonymous": true,
        "source": "default"
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Token request failed: ${response.status}`);
    }

    const data = await response.json();
    const token = data?.data?.token || data?.token;
    if (!token) {
      throw new Error("No token in response");
    }
    return token;

  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error("Token request timeout (10s)");
    }
    throw error;
  }
}

// Get auth token (fallback cascade)
async function getAuthToken(): Promise<string> {
  if (UPSTREAM_TOKEN) {
    return UPSTREAM_TOKEN;
  }

  return await getAnonymousTokenWithTimeout();
}

// Debug logging
function debugLog(...args: any[]) {
  if (DEBUG_MODE) {
    console.log("[DEBUG]", ...args);
  }
}

// Send message to zread.ai API with timeout protection
async function sendZreadMessageOptimized(messageRequest: any, authToken: string, stream: boolean = false): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout

  try {
    const messageUrl = `${UPSTREAM_URL}/31064d72-a25c-11f0-901e-1a109de107af/message`;
    const resolution = resolveModelRouting(messageRequest.model);
    const platform = resolution.platform;

    const response = await fetch(messageUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${authToken}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Origin": resolution.originBase,
        "Referer": resolution.originBase + resolution.refererPrefix,
        "Accept": stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
        "Connection": "keep-alive",
        "Accept-Charset": "utf-8"
      },
      body: JSON.stringify(messageRequest),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response;

  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error("Request timeout (25s)");
    }
    throw error;
  }
}

// Handle zread.ai streaming response
async function handleZreadStreamResponse(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('event:answer')) {
              // Look for the data line that follows
              const nextLine = lines[i + 1]?.trim();
              if (nextLine && nextLine.startsWith('data:')) {
                try {
                  const jsonData = nextLine.substring(5); // Remove 'data:' prefix
                  const parsed = JSON.parse(jsonData);

                  if (parsed.text) {
                    // Convert zread format to OpenAI format
                    const openaiChunk = {
                      id: parsed.id || "chatcmpl-" + Math.random().toString(36).substr(2, 9),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: MODEL_NAME,
                      choices: [{
                        index: 0,
                        delta: { content: parsed.text },
                        finish_reason: null
                      }]
                    };

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                  }
                } catch (e) {
                  debugLog("Failed to parse SSE data:", nextLine);
                }
              }
            }
          }
        }

        // Send final chunk
        const finalChunk = {
          id: "chatcmpl-" + Math.random().toString(36).substr(2, 9),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: MODEL_NAME,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        };

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

      } catch (error) {
        debugLog("Stream processing error:", error);
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

// Handle zread.ai non-streaming response
async function handleZreadNonStreamResponseOptimized(response: Response, cacheKey?: string): Promise<any> {
  const responseText = await response.text();

  // Cache the raw response for future use
  if (cacheKey) {
    setCachedResponse(cacheKey, responseText, 300000); // 5 minutes
  }

  debugLog("Zread non-streaming response:", responseText.substring(0, 200));

  // Parse SSE format from zread.ai
  const lines = responseText.split('\n');
  let content = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('event:answer')) {
      // Look for the data line that follows
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && nextLine.startsWith('data:')) {
        try {
          const jsonData = nextLine.substring(5); // Remove 'data:' prefix
          const parsed = JSON.parse(jsonData);

          if (parsed.text) {
            content += parsed.text;
          }
        } catch (e) {
          debugLog("Failed to parse SSE data:", nextLine);
        }
      }
    }
  }

  debugLog("Extracted content:", content);

  // Return OpenAI-compatible response
  return {
    id: "chatcmpl-" + Math.random().toString(36).substr(2, 9),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || "I apologize, but I couldn't generate a response."
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

// Handle zread.ai chat completion
async function handleZreadAIChatCompletion(req: Request, path: string): Promise<Response> {
  const startTime = Date.now();
  let statusCode = 200;
  let errorMessage = "";
  let body: any;

  try {
    body = await req.json();
    const model = body.model || MODEL_NAME;
    const stream = body.stream !== false && (body.stream || DEFAULT_STREAM);

    // Generate cache key for non-streaming requests
    const cacheKey = stream ? null : generateCacheKey(body);

    // Check cache for non-streaming requests
    if (!stream && cacheKey) {
      const cachedResponse = getCachedResponse(cacheKey);
      if (cachedResponse) {
        debugLog("Cache hit for request:", cacheKey);
        const response = new Response(cachedResponse, {
          headers: { "Content-Type": "application/json" }
        });

        // Update stats
        const duration = Date.now() - startTime;
        totalRequests++;
        successfulRequests++;
        totalResponseTime += duration;

        addRecentRequest({
          timestamp: new Date().toISOString(),
          method: req.method,
          path,
          status: 200,
          duration,
          model,
          platform: "zread"
        });

        return response;
      }
    }

    const resolution = resolveModelRouting(model);
    const authToken = await getAuthToken();

    const messageRequest = {
      model: resolution.upstreamModelId,
      messages: body.messages,
      stream: false, // Always use false for zread.ai API
      temperature: body.temperature || 0.7,
      max_tokens: body.max_tokens || 2000,
      top_p: body.top_p || 1,
      frequency_penalty: body.frequency_penalty || 0,
      presence_penalty: body.presence_penalty || 0,
      enable_thinking: body.enable_thinking !== false && ENABLE_THINKING,
      variables: {
        "USER_NAME": "API User",
        "CURRENT_DATETIME": new Date().toISOString(),
        "REQUEST_ID": `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      }
    };

    debugLog("Sending message to zread.ai:", messageRequest);

    const response = await sendZreadMessageOptimized(messageRequest, authToken, stream);

    if (!response.ok) {
      statusCode = response.status;
      const errorText = await response.text();
      errorMessage = `Upstream error: ${response.status} ${errorText}`;
      debugLog("Upstream error:", errorMessage);
      throw new Error(errorMessage);
    }

    if (stream) {
      const streamResponse = await handleZreadStreamResponse(response);

      // Update stats for streaming
      const duration = Date.now() - startTime;
      totalRequests++;
      successfulRequests++;
      totalResponseTime += duration;

      addRecentRequest({
        timestamp: new Date().toISOString(),
        method: req.method,
        path,
        status: 200,
        duration,
        model,
        platform: "zread"
      });

      return streamResponse;
    } else {
      const result = await handleZreadNonStreamResponseOptimized(response, cacheKey || undefined);

      // Update model usage
      const currentUsage = modelUsage.get(model) || 0;
      modelUsage.set(model, currentUsage + 1);

      // Update stats
      const duration = Date.now() - startTime;
      totalRequests++;
      successfulRequests++;
      totalResponseTime += duration;

      addRecentRequest({
        timestamp: new Date().toISOString(),
        method: req.method,
        path,
        status: 200,
        duration,
        model,
        platform: "zread"
      });

      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

  } catch (error) {
    debugLog("Error in chat completion:", error);

    // Update error stats
    const duration = Date.now() - startTime;
    totalRequests++;
    failedRequests++;

    addRecentRequest({
      timestamp: new Date().toISOString(),
      method: req.method,
      path,
      status: statusCode,
      duration,
      model: body?.model || MODEL_NAME,
      platform: "zread"
    });

    const errorResponse = {
      error: {
        message: errorMessage || (error instanceof Error ? error.message : "Unknown error"),
        type: "upstream_error",
        code: "processing_failed"
      }
    };

    return new Response(JSON.stringify(errorResponse), {
      status: statusCode,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// Main request handler
async function handler(req: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(req.url);
  const path = url.pathname;

  // Cleanup cache on each request
  cleanupCache();

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Health check endpoint
  if (path === "/health") {
    return new Response(JSON.stringify({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "2.0.0-deno-deploy"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Models endpoint
  if (path === "/v1/models") {
    const models = listExposedModels();
    const openaiModels = models.map(m => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.platformId
    }));

    return new Response(JSON.stringify({
      object: "list",
      data: openaiModels
    }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }

  // Chat completions endpoint
  if (path === "/v1/chat/completions") {
    // Authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({
        error: {
          message: "Missing or invalid Authorization header",
          type: "authentication_error",
          code: "invalid_api_key"
        }
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    const token = authHeader.substring(7);
    if (token !== DEFAULT_KEY) {
      return new Response(JSON.stringify({
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: "invalid_api_key"
        }
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    return await handleZreadAIChatCompletion(req, path);
  }

  // Dashboard endpoints (simplified for Deno Deploy)
  if (path.startsWith("/dashboard")) {
    if (path === "/dashboard/stats") {
      const avgResponseTime = totalRequests > 0 ? Math.round(totalResponseTime / totalRequests) : 0;
      const stats = {
        totalRequests,
        successfulRequests,
        failedRequests,
        averageResponseTime: avgResponseTime,
        modelUsage: Object.fromEntries(modelUsage),
        recentRequests: recentRequests.slice(-20),
        startTime: new Date().toISOString(),
        version: "2.0.0-deno-deploy"
      };

      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (path === "/dashboard/requests") {
      return new Response(JSON.stringify({
        requests: recentRequests.slice(-20)
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (path === "/dashboard") {
      const html = `<!DOCTYPE html>
<html>
<head>
    <title>ZtoApi Dashboard (Deno Deploy)</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .metric { display: inline-block; margin: 10px 20px 10px 0; padding: 15px; background: #f8f9fa; border-radius: 6px; min-width: 120px; text-align: center; }
        .metric-value { font-size: 24px; font-weight: bold; color: #007bff; }
        .metric-label { font-size: 12px; color: #666; margin-top: 5px; }
        .section { margin: 30px 0; padding: 20px; background: #f8f9fa; border-radius: 6px; }
        h1 { color: #333; }
        h2 { color: #007bff; border-bottom: 2px solid #007bff; padding-bottom: 5px; }
        .request-item { padding: 8px 0; border-bottom: 1px solid #ddd; }
        .success { color: #28a745; }
        .error { color: #dc3545; }
        .model-badge { background: #6c757d; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
        .platform-badge { background: #17a2b8; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-left: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 ZtoApi Dashboard (Deno Deploy)</h1>
        <div class="section">
            <div class="metric">
                <div class="metric-value">${totalRequests}</div>
                <div class="metric-label">Total Requests</div>
            </div>
            <div class="metric">
                <div class="metric-value">${successfulRequests}</div>
                <div class="metric-label">Successful</div>
            </div>
            <div class="metric">
                <div class="metric-value">${failedRequests}</div>
                <div class="metric-label">Failed</div>
            </div>
            <div class="metric">
                <div class="metric-value">${totalRequests > 0 ? Math.round(totalResponseTime / totalRequests) : 0}ms</div>
                <div class="metric-label">Avg Response</div>
            </div>
        </div>
        <div class="section">
            <h2>📊 Model Usage</h2>
            ${Array.from(modelUsage.entries()).map(([model, count]) =>
                `<span class="model-badge">${model}: ${count}</span> `
            ).join('') || '<p>No usage data yet</p>'}
        </div>
        <div class="section">
            <h2>📋 Recent Requests</h2>
            <div id="requests">
                ${recentRequests.slice(-10).reverse().map(req => `
                    <div class="request-item">
                        <span class="${req.status === 200 ? 'success' : 'error'}">${req.method} ${req.path}</span>
                        <span>${req.status} (${req.duration}ms)</span>
                        ${req.model ? `<span class="model-badge">${req.model}</span>` : ''}
                        ${req.platform ? `<span class="platform-badge">${req.platform}</span>` : ''}
                        <small>${new Date(req.timestamp).toLocaleTimeString()}</small>
                    </div>
                `).join('') || '<p>No requests yet</p>'}
            </div>
        </div>
        <p><small><em>Dashboard refreshes on page reload. Deno Deploy version with in-memory storage.</em></small></p>
    </div>
</body>
</html>`;
      return new Response(html, {
        headers: { "Content-Type": "text/html" }
      });
    }
  }

  // API docs endpoint
  if (path === "/docs") {
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>ZtoApi API Documentation</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1000px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .endpoint { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 6px; background: #f9f9f9; }
        .method { display: inline-block; padding: 4px 8px; border-radius: 3px; color: white; font-weight: bold; margin-right: 10px; }
        .get { background: #28a745; }
        .post { background: #007bff; }
        pre { background: #f8f9fa; padding: 10px; border-radius: 4px; overflow-x: auto; }
        code { background: #f8f9fa; padding: 2px 4px; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📖 ZtoApi API Documentation</h1>
        <p><strong>Version:</strong> 2.0.0 (Deno Deploy)</p>
        <p><strong>Base URL:</strong> <code>${req.url.split('/')[0]}//${req.url.split('/')[2]}</code></p>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/v1/models</strong>
            <p>List available models</p>
        </div>

        <div class="endpoint">
            <span class="method post">POST</span><strong>/v1/chat/completions</strong>
            <p>Create chat completion</p>
            <pre>curl -X POST ${req.url.split('/')[0]}//${req.url.split('/')[2]}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${MODEL_NAME}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</pre>
        </div>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/dashboard</strong>
            <p>View dashboard with statistics and recent requests</p>
        </div>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/health</strong>
            <p>Health check endpoint</p>
        </div>

        <h2>🔑 Authentication</h2>
        <p>Include an Authorization header with Bearer token:</p>
        <pre>Authorization: Bearer YOUR_API_KEY</pre>

        <h2>🚀 Features</h2>
        <ul>
            <li>✅ OpenAI API compatible</li>
            <li>✅ Streaming and non-streaming responses</li>
            <li>✅ Performance caching (5-minute TTL)</li>
            <li>✅ UTF-8 character encoding support</li>
            <li>✅ Request timeout protection (25s)</li>
            <li>✅ CORS support</li>
            <li>✅ Real-time dashboard</li>
        </ul>
    </div>
</body>
</html>`;
      return new Response(html, {
        headers: { "Content-Type": "text/html" }
      });
  }

  return new Response("Not Found", { status: 404 });
}

// Start server - Deno Deploy handles this automatically
console.log(`🚀 ZtoApi (Deno Deploy) starting...`);
console.log(`📦 Model: ${MODEL_NAME}`);
console.log(`🌐 Upstream: ${UPSTREAM_URL}`);
console.log(`🐛 Debug mode: ${DEBUG_MODE}`);
console.log(`🌊 Default stream: ${DEFAULT_STREAM}`);
console.log(`📊 Dashboard enabled: ${DASHBOARD_ENABLED}`);
console.log(`🧠 Thinking enabled: ${ENABLE_THINKING}`);
console.log(`🔑 Token strategy: ${UPSTREAM_TOKEN ? "Static Token" : "Anonymous Token"}`);

// Deno Deploy will call the handler directly
export default handler;