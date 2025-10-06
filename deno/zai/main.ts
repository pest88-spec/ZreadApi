import { PlatformConfig, resolveModelRouting, RuntimeConfig, listExposedModels } from "./config.ts";

const PROVIDER_BRAND = PlatformConfig.brand;
const PROVIDER_HOME_URL = PlatformConfig.homeUrl;
const PROVIDER_HOST = PlatformConfig.host;
const ORIGIN_BASE = PlatformConfig.originBase;
const REFERER_PREFIX = PlatformConfig.refererPrefix;
const UPSTREAM_URL = PlatformConfig.upstreamUrl;
const MODELS_URL = PlatformConfig.modelsUrl;
const AUTH_URL = PlatformConfig.authUrl;
const OWNED_BY = PlatformConfig.ownedBy;
const X_FE_VERSION = RuntimeConfig.xFeVersion;
const DEFAULT_KEY = RuntimeConfig.defaultKey;
const ZAI_TOKEN = RuntimeConfig.upstreamToken;
const KV_URL = RuntimeConfig.kvUrl;
const MODEL_NAME = RuntimeConfig.modelName;
const PORT = RuntimeConfig.port;
const DEBUG_MODE = RuntimeConfig.debugMode;
const DEFAULT_STREAM = RuntimeConfig.defaultStream;
const DASHBOARD_ENABLED = RuntimeConfig.dashboardEnabled;
const ENABLE_THINKING = RuntimeConfig.enableThinking;
function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function buildReferer(chatID: string): string {
  const prefix = REFERER_PREFIX.endsWith("/") ? REFERER_PREFIX : `${REFERER_PREFIX}/`;
  return `${normalizeOrigin(ORIGIN_BASE)}${prefix}${chatID}`;
}

// Browser fingerprint generator
function generateBrowserHeaders(chatID: string, authToken: string): Record<string, string> {
  const chromeVersion = Math.floor(Math.random() * 3) + 138; // 138-140 (更新：Chrome 140)

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
    "Content-Type": "application/json",
    "Accept": "*/*",
    "User-Agent": randomUA,
    "Authorization": `Bearer ${authToken}`,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "sec-ch-ua":
      `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="24", "Google Chrome";v="${chromeVersion}"`, // 更新：Chrome 140 格式
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": randomPlatform,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "X-FE-Version": X_FE_VERSION,
    "Origin": origin,
    "Referer": buildReferer(chatID),
    "Priority": "u=1, i",
  };
}

// Token strategy configuration
// Parse ZAI_TOKEN to support multiple tokens separated by |
const ZAI_TOKEN_ARRAY = ZAI_TOKEN
  ? ZAI_TOKEN.split("|").map((t) => t.trim()).filter((t) => t.length > 0)
  : [];
const STATIC_TOKEN_POOL_ENABLED = ZAI_TOKEN_ARRAY.length > 0;
const KV_TOKEN_POOL_ENABLED = !!KV_URL;

// Token acquisition priority (fallback cascade):
// 1. X-ZAI-Token header (if provided)
// 2. Static Token Pool (ZAI_TOKEN environment variable)
// 3. KV Token Pool (KV_URL database)
// 4. Anonymous Token (auto-fetch from upstream provider)

// Thinking tags mode
const THINK_TAGS_MODE =
  (Deno.env.get("THINK_TAGS_MODE") as "strip" | "think" | "raw" | undefined) ?? "strip";

// Performance optimization: connection pool for upstream requests
const connectionCache = new Map<string, ConnectionInfo>();

interface ConnectionInfo {
  lastUsed: number;
  keepAlive: boolean;
  requestCount: number;
}

// Performance metrics
const performanceMetrics = {
  totalRequests: 0,
  totalUpstreamTime: 0,
  averageUpstreamTime: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

// Request cache for identical requests (short TTL)
const requestCache = new Map<string, CachedResponse>();

interface CachedResponse {
  data: string;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

function generateCacheKey(model: string, messages: OpenAIMessage[]): string {
  // Create a simple hash based on model and message content
  const content = messages.map(m => m.content).join('|');
  return `${model}:${content.slice(0, 100)}`; // Limit length to avoid huge keys
}

function getCachedResponse(key: string): string | null {
  const cached = requestCache.get(key);
  if (!cached) {
    performanceMetrics.cacheMisses++;
    return null;
  }

  if (Date.now() - cached.timestamp > cached.ttl) {
    requestCache.delete(key);
    performanceMetrics.cacheMisses++;
    return null;
  }

  performanceMetrics.cacheHits++;
  return cached.data;
}

function setCachedResponse(key: string, data: string, ttl: number = 30000): void {
  // Default TTL: 30 seconds for identical requests
  requestCache.set(key, {
    data,
    timestamp: Date.now(),
    ttl
  });

  // Clean old entries periodically
  if (requestCache.size > 100) {
    const now = Date.now();
    for (const [cacheKey, value] of requestCache.entries()) {
      if (now - value.timestamp > value.ttl) {
        requestCache.delete(cacheKey);
      }
    }
  }
}

// Request statistics
interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastRequestTime: Date;
  averageResponseTime: number; // in milliseconds
  homePageViews: number; // homepage visits
  apiCallsCount: number; // /v1/chat/completions calls
  modelsCallsCount: number; // /v1/models calls
  streamingRequests: number; // streaming mode requests
  nonStreamingRequests: number; // non-streaming mode requests
  totalTokensUsed: number; // total tokens (approximate)
  startTime: Date; // server start time
  fastestResponse: number; // fastest response time in ms
  slowestResponse: number; // slowest response time in ms
  modelUsage: Map<string, number>; // model name -> count
}

// Hourly and daily stats for persistent storage
interface HourlyStats {
  hour: string; // Format: YYYY-MM-DD-HH
  requests: number;
  success: number;
  failed: number;
  avgResponseTime: number;
  tokens: number;
  models?: Record<string, number>; // model usage
  streamingCount?: number; // streaming requests count
  nonStreamingCount?: number; // non-streaming requests count
  totalMessages?: number; // total messages sent
  uniqueIPs?: Set<string>; // unique client IPs (for this hour)
  errorTypes?: Record<string, number>; // error status codes
}

interface DailyStats {
  date: string; // Format: YYYY-MM-DD
  requests: number;
  success: number;
  failed: number;
  avgResponseTime: number;
  tokens: number;
  peakHour: string;
  models?: Record<string, number>; // model usage
  streamingCount?: number; // streaming requests count
  nonStreamingCount?: number; // non-streaming requests count
  totalMessages?: number; // total messages sent
  uniqueIPsCount?: number; // unique client IPs count for the day
  errorTypes?: Record<string, number>; // error status codes
  fastestResponse?: number; // fastest response of the day
  slowestResponse?: number; // slowest response of the day
}

interface LiveRequest {
  id: string;
  timestamp: Date;
  method: string;
  path: string;
  status: number;
  duration: number; // in milliseconds
  userAgent: string;
  model?: string; // model name if applicable
}

interface StoredAccount {
  email: string;
  password: string;
  token: string;
}

interface UpstreamModelsResponse {
  data?: Array<{ id?: string; name?: string }>;
}

// Global stats
const stats: RequestStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  lastRequestTime: new Date(),
  averageResponseTime: 0,
  homePageViews: 0,
  apiCallsCount: 0,
  modelsCallsCount: 0,
  streamingRequests: 0,
  nonStreamingRequests: 0,
  totalTokensUsed: 0,
  startTime: new Date(),
  fastestResponse: Infinity,
  slowestResponse: 0,
  modelUsage: new Map<string, number>(),
};

const liveRequests: LiveRequest[] = [];

// Initialize Deno KV database for token pool
let kvTokenPool: Deno.Kv | null = null;

// Initialize KV token pool connection
async function initKVTokenPool() {
  if (!KV_URL) {
    debugLog("KV_URL not configured, skipping KV token pool initialization");
    return;
  }

  try {
    kvTokenPool = await Deno.openKv(KV_URL);
    debugLog(`KV token pool initialized: ${KV_URL}`);
  } catch (error) {
    console.error("Failed to initialize KV token pool:", error);
    console.error("Will fall back to anonymous token mode");
  }
}

// Get random token from static token pool (ZAI_TOKEN)
function getTokenFromStaticPool(): string | null {
  if (!STATIC_TOKEN_POOL_ENABLED || ZAI_TOKEN_ARRAY.length === 0) {
    debugLog("Static token pool not available");
    return null;
  }

  // Randomly select a token from the array
  const randomToken = ZAI_TOKEN_ARRAY[Math.floor(Math.random() * ZAI_TOKEN_ARRAY.length)];
  debugLog(
    `Selected token from static pool (${ZAI_TOKEN_ARRAY.length} tokens available): ${
      randomToken.substring(0, 10)
    }...`,
  );
  return randomToken;
}

// Get random token from KV token pool
async function getTokenFromKVPool(): Promise<string | null> {
  if (!kvTokenPool) {
    debugLog("KV token pool not initialized");
    return null;
  }

  try {
    // Fetch all accounts from KV
    const accounts: StoredAccount[] = [];
    const entries = kvTokenPool.list<StoredAccount>({ prefix: ["zai_accounts"] });

    for await (const entry of entries) {
      const data = entry.value;
      if (data?.token) {
        accounts.push({ email: data.email, password: data.password, token: data.token });
      }
    }

    if (accounts.length === 0) {
      debugLog("No accounts found in KV token pool");
      return null;
    }

    // Randomly select an account
    const randomAccount = accounts[Math.floor(Math.random() * accounts.length)];
    debugLog(
      `Selected token from KV pool: ${randomAccount.email} (${accounts.length} accounts available)`,
    );
    return randomAccount.token;
  } catch (error) {
    console.error("Failed to get token from KV pool:", error);
    return null;
  }
}

// Initialize Deno KV database (for local storage)
let kv: Deno.Kv;

// Initialize database connection
async function initDB() {
  try {
    kv = await Deno.openKv();
    debugLog("Deno KV database initialized");
  } catch (error) {
    console.error("Failed to initialize Deno KV:", error);
  }
}

// Get current hour key (format: YYYY-MM-DD-HH)
function getHourKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${
    String(now.getUTCDate()).padStart(2, "0")
  }-${String(now.getUTCHours()).padStart(2, "0")}`;
}

// Get current date key (format: YYYY-MM-DD)
function getDateKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${
    String(now.getUTCDate()).padStart(2, "0")
  }`;
}

// Save hourly stats to KV
async function saveHourlyStats(
  duration: number,
  status: number,
  tokens: number,
  model?: string,
  isStreaming?: boolean,
  messageCount?: number,
  clientIP?: string,
) {
  if (!kv) return;

  const hourKey = getHourKey();
  const key = ["stats", "hourly", hourKey];

  try {
    const existing = await kv.get<HourlyStats>(key);
    const current = existing.value || {
      hour: hourKey,
      requests: 0,
      success: 0,
      failed: 0,
      avgResponseTime: 0,
      tokens: 0,
      models: {},
      streamingCount: 0,
      nonStreamingCount: 0,
      totalMessages: 0,
      uniqueIPs: new Set<string>(),
      errorTypes: {},
    };

    current.requests++;
    if (status >= 200 && status < 300) {
      current.success++;
    } else {
      current.failed++;
      // Track error types
      if (!current.errorTypes) current.errorTypes = {};
      current.errorTypes[status] = (current.errorTypes[status] || 0) + 1;
    }

    // Update average response time
    const totalTime = current.avgResponseTime * (current.requests - 1) + duration;
    current.avgResponseTime = totalTime / current.requests;
    current.tokens += tokens;

    // Track model usage
    if (model && current.models) {
      current.models[model] = (current.models[model] || 0) + 1;
    }

    // Track streaming vs non-streaming
    if (isStreaming !== undefined) {
      if (isStreaming) {
        current.streamingCount = (current.streamingCount || 0) + 1;
      } else {
        current.nonStreamingCount = (current.nonStreamingCount || 0) + 1;
      }
    }

    // Track message count
    if (messageCount) {
      current.totalMessages = (current.totalMessages || 0) + messageCount;
    }

    // Track unique IPs
    if (clientIP && clientIP !== "unknown") {
      if (!current.uniqueIPs) current.uniqueIPs = new Set();
      current.uniqueIPs.add(clientIP);
    }

    // Convert Set to Array for storage
    const dataToStore = {
      ...current,
      uniqueIPs: Array.from(current.uniqueIPs || []),
    };

    await kv.set(key, dataToStore, { expireIn: 7 * 24 * 60 * 60 * 1000 }); // Expire after 7 days
  } catch (error) {
    debugLog("Error saving hourly stats:", error);
  }
}

// Save daily stats to KV
async function saveDailyStats() {
  if (!kv) return;

  const dateKey = getDateKey();
  const key = ["stats", "daily", dateKey];

  try {
    // Aggregate all hourly stats for today
    const prefix = ["stats", "hourly"];
    const entries = kv.list<HourlyStats>({ prefix });

    let totalRequests = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalResponseTime = 0;
    let totalTokens = 0;
    let peakHour = "";
    let peakRequests = 0;
    const modelUsage: Record<string, number> = {};

    for await (const entry of entries) {
      if (entry.value.hour.startsWith(dateKey)) {
        totalRequests += entry.value.requests;
        totalSuccess += entry.value.success;
        totalFailed += entry.value.failed;
        totalResponseTime += entry.value.avgResponseTime * entry.value.requests;
        totalTokens += entry.value.tokens;

        if (entry.value.requests > peakRequests) {
          peakRequests = entry.value.requests;
          peakHour = entry.value.hour;
        }

        // Aggregate model usage
        if (entry.value.models) {
          for (const [model, count] of Object.entries(entry.value.models)) {
            modelUsage[model] = (modelUsage[model] || 0) + count;
          }
        }
      }
    }

    const dailyStat: DailyStats = {
      date: dateKey,
      requests: totalRequests,
      success: totalSuccess,
      failed: totalFailed,
      avgResponseTime: totalRequests > 0 ? totalResponseTime / totalRequests : 0,
      tokens: totalTokens,
      peakHour,
      models: modelUsage,
    };

    await kv.set(key, dailyStat, { expireIn: 30 * 24 * 60 * 60 * 1000 }); // Expire after 30 days
  } catch (error) {
    debugLog("Error saving daily stats:", error);
  }
}

// Get hourly stats for last N hours
async function getHourlyStats(hours = 24): Promise<HourlyStats[]> {
  if (!kv) return [];

  const result: HourlyStats[] = [];
  const prefix = ["stats", "hourly"];

  try {
    const entries = kv.list<HourlyStats>({ prefix }, { reverse: true, limit: hours });
    for await (const entry of entries) {
      result.push(entry.value);
    }
  } catch (error) {
    debugLog("Error getting hourly stats:", error);
  }

  return result.reverse();
}

// Get daily stats for last N days
async function getDailyStats(days = 30): Promise<DailyStats[]> {
  if (!kv) return [];

  const result: DailyStats[] = [];
  const prefix = ["stats", "daily"];

  try {
    const entries = kv.list<DailyStats>({ prefix }, { reverse: true, limit: days });
    for await (const entry of entries) {
      result.push(entry.value);
    }
  } catch (error) {
    debugLog("Error getting daily stats:", error);
  }

  return result.reverse();
}

// Cleanup old data (called periodically)
async function cleanupOldData() {
  if (!kv) return;

  try {
    // Delete hourly data older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const cutoffHour = `${sevenDaysAgo.getUTCFullYear()}-${
      String(sevenDaysAgo.getUTCMonth() + 1).padStart(2, "0")
    }-${String(sevenDaysAgo.getUTCDate()).padStart(2, "0")}-${
      String(sevenDaysAgo.getUTCHours()).padStart(2, "0")
    }`;

    const hourlyPrefix = ["stats", "hourly"];
    const hourlyEntries = kv.list({ prefix: hourlyPrefix });

    for await (const entry of hourlyEntries) {
      const hour = entry.key[2] as string;
      if (hour < cutoffHour) {
        await kv.delete(entry.key);
        debugLog("Deleted old hourly data:", hour);
      }
    }

    // Delete daily data older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cutoffDate = `${thirtyDaysAgo.getUTCFullYear()}-${
      String(thirtyDaysAgo.getUTCMonth() + 1).padStart(2, "0")
    }-${String(thirtyDaysAgo.getUTCDate()).padStart(2, "0")}`;

    const dailyPrefix = ["stats", "daily"];
    const dailyEntries = kv.list({ prefix: dailyPrefix });

    for await (const entry of dailyEntries) {
      const date = entry.key[2] as string;
      if (date < cutoffDate) {
        await kv.delete(entry.key);
        debugLog("Deleted old daily data:", date);
      }
    }
  } catch (error) {
    debugLog("Error cleaning up old data:", error);
  }
}

// OpenAI request/response types
interface Message {
  role: string;
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  enable_thinking?: boolean;
}

interface UpstreamRequest {
  stream: boolean;
  model: string;
  messages: Message[];
  params: Record<string, unknown>;
  features: Record<string, unknown>;
  background_tasks?: Record<string, boolean>;
  chat_id?: string;
  id?: string;
  mcp_servers?: string[];
  model_item?: {
    id: string;
    name: string;
    owned_by: string;
  };
  tool_servers?: string[];
  variables?: Record<string, string>;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

interface Choice {
  index: number;
  message?: Message;
  delta?: Delta;
  finish_reason?: string;
}

interface Delta {
  role?: string;
  content?: string;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface UpstreamData {
  type?: string;
  data: {
    delta_content: string;
    phase: string;
    done: boolean;
    usage?: Usage;
    error?: UpstreamError;
    data?: {
      error?: UpstreamError;
    };
  };
  error?: UpstreamError;
}

interface UpstreamError {
  detail: string;
  code: number;
}

interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

// Debug logger
function debugLog(...args: unknown[]) {
  if (DEBUG_MODE) {
    console.log("[DEBUG]", ...args);
  }
}

// Record request stats
function recordRequestStats(
  startTime: number,
  path: string,
  status: number,
  tokens = 0,
  model?: string,
  isStreaming?: boolean,
  messageCount?: number,
  clientIP?: string,
) {
  const duration = Date.now() - startTime;

  stats.totalRequests++;
  stats.lastRequestTime = new Date();

  if (status >= 200 && status < 300) {
    stats.successfulRequests++;
  } else {
    stats.failedRequests++;
  }

  // Track endpoint-specific stats
  if (path === "/v1/chat/completions") {
    stats.apiCallsCount++;
  } else if (path === "/v1/models") {
    stats.modelsCallsCount++;
  }

  // Track tokens
  if (tokens > 0) {
    stats.totalTokensUsed += tokens;
  }

  // Track model usage
  if (model) {
    const count = stats.modelUsage.get(model) || 0;
    stats.modelUsage.set(model, count + 1);
  }

  // Update response time stats
  if (duration < stats.fastestResponse) {
    stats.fastestResponse = duration;
  }
  if (duration > stats.slowestResponse) {
    stats.slowestResponse = duration;
  }

  // Update average response time
  if (stats.totalRequests > 0) {
    const totalDuration = stats.averageResponseTime * (stats.totalRequests - 1) + duration;
    stats.averageResponseTime = totalDuration / stats.totalRequests;
  } else {
    stats.averageResponseTime = duration;
  }

  // Save to KV database (async, don't await to avoid blocking)
  saveHourlyStats(duration, status, tokens, model, isStreaming, messageCount, clientIP).catch((
    err,
  ) => debugLog("Error saving hourly stats:", err));
}

// Add live request
function addLiveRequest(
  method: string,
  path: string,
  status: number,
  duration: number,
  _clientIP: string,
  userAgent: string,
  model?: string,
) {
  const request: LiveRequest = {
    id: `${Date.now()}${Math.random()}`,
    timestamp: new Date(),
    method,
    path,
    status,
    duration,
    userAgent,
    model,
  };

  liveRequests.push(request);

  // Keep only last 100 requests
  if (liveRequests.length > 100) {
    liveRequests.shift();
  }
}

// Get client IP
function getClientIP(req: Request): string {
  const xff = req.headers.get("X-Forwarded-For");
  if (xff) {
    const ips = xff.split(",");
    if (ips.length > 0) {
      return ips[0].trim();
    }
  }

  const xri = req.headers.get("X-Real-IP");
  if (xri) {
    return xri;
  }

  return "unknown";
}

// Get anonymous token
async function getAnonymousToken(): Promise<string> {
  try {
    // 使用 Chrome 140 的 User-Agent
    const chromeVersion = 140;
    const userAgent =
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`;
    const secChUa =
      `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="24", "Google Chrome";v="${chromeVersion}"`;
    const origin = normalizeOrigin(ORIGIN_BASE);

    const response = await fetch(AUTH_URL, {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "X-FE-Version": X_FE_VERSION,
        "sec-ch-ua": secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Origin": origin,
        "Referer": `${origin}/`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get anon token: ${response.status}`);
    }

    const data = await response.json();
    if (!data.token) {
      throw new Error("Empty token in response");
    }

    return data.token;
  } catch (error) {
    debugLog("Anonymous token error:", error);
    throw error;
  }
}

// Transform thinking content
function transformThinking(s: string): string {
  // Remove <summary>…</summary>
  s = s.replace(/<summary>.*?<\/summary>/gs, "");
  // Clean up custom tags
  s = s.replace(/<\/thinking>/g, "");
  s = s.replace(/<Full>/g, "");
  s = s.replace(/<\/Full>/g, "");
  s = s.trim();

  switch (THINK_TAGS_MODE) {
    case "think":
      s = s.replace(/<details[^>]*>/g, "<think>");
      s = s.replace(/<\/details>/g, "</think>");
      break;
    case "strip":
      s = s.replace(/<details[^>]*>/g, "");
      s = s.replace(/<\/details>/g, "");
      break;
  }

  // Remove "> " prefix
  s = s.replace(/^> /, "");
  s = s.replace(/\n> /g, "\n");

  return s.trim();
}

// Call upstream API
async function callUpstream(
  upstreamReq: UpstreamRequest,
  chatID: string,
  authToken: string,
): Promise<Response> {
  // 构建请求体
  const reqBody = JSON.stringify(upstreamReq);

  debugLog("Calling upstream:", UPSTREAM_URL);
  debugLog("Request body:", reqBody);

  // 生成 X-Signature - 基于请求体的 SHA-256 哈希（426错误修复）
  const encoder = new TextEncoder();
  const data = encoder.encode(reqBody);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  debugLog("Generated X-Signature:", signature);

  // Generate dynamic browser headers for better fingerprinting
  const headers: Record<string, string> = generateBrowserHeaders(chatID, authToken);

  // 添加 X-Signature header
  headers["X-Signature"] = signature;

  // 添加额外的请求头
  headers["Connection"] = "keep-alive";
  headers["sec-fetch-dest"] = "empty";
  headers["sec-fetch-mode"] = "cors";
  headers["sec-fetch-site"] = "same-origin";

  // 添加 Cookie
  headers["Cookie"] = `token=${authToken}`;

  const response = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: headers,
    body: reqBody,
  });

  debugLog("Upstream response status:", response.status);
  return response;
}

// Handle stream response
async function handleStreamResponse(
  upstreamReq: UpstreamRequest,
  chatID: string,
  authToken: string,
  startTime: number,
  path: string,
  clientIP: string,
  userAgent: string,
  model: string,
  messageCount: number,
): Promise<Response> {
  debugLog("Handling stream response, chat_id:", chatID);

  const upstreamResp = await callUpstream(upstreamReq, chatID, authToken);

  if (!upstreamResp.ok) {
    debugLog("Upstream error status:", upstreamResp.status);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502, 0, model, true, messageCount, clientIP);
    addLiveRequest("POST", path, 502, duration, clientIP, userAgent, model);

    // Return OpenAI-compatible error response
    const errorResponse = {
      error: {
        message:
          `Upstream server returned error: ${upstreamResp.status} ${upstreamResp.statusText}`,
        type: "upstream_error",
        code: "upstream_error",
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let isFirstChunk = true;

  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;

      const safeEnqueue = (data: Uint8Array) => {
        if (!streamClosed) {
          try {
            controller.enqueue(data);
          } catch (e) {
            debugLog("Enqueue error:", e);
            streamClosed = true;
          }
        }
      };

      const safeClose = () => {
        if (!streamClosed) {
          try {
            controller.close();
            streamClosed = true;
          } catch (e) {
            debugLog("Close error:", e);
            streamClosed = true;
          }
        }
      };

      try {
        const reader = upstreamResp.body?.getReader();
        if (!reader) {
          safeClose();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        // Send first chunk with role
        if (isFirstChunk) {
          const firstChunk: OpenAIResponse = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { role: "assistant" },
            }],
          };
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
          isFirstChunk = false;
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const dataStr = line.substring(6);
            if (!dataStr) continue;

            try {
              const upstreamData: UpstreamData = JSON.parse(dataStr);

              // Check for errors
              if (
                upstreamData.error || upstreamData.data?.error ||
                upstreamData.data?.data?.error
              ) {
                debugLog("Upstream error detected:", JSON.stringify(upstreamData));
                const endChunk: OpenAIResponse = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  }],
                };
                safeEnqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                safeEnqueue(encoder.encode("data: [DONE]\n\n"));
                safeClose();
                // Record stats before returning
                const duration = Date.now() - startTime;
                recordRequestStats(startTime, path, 200, 0, model, true, messageCount, clientIP);
                addLiveRequest("POST", path, 200, duration, clientIP, userAgent, model);
                return;
              }

              // Process content
              if (upstreamData.data.delta_content) {
                let out = upstreamData.data.delta_content;
                if (upstreamData.data.phase === "thinking") {
                  out = transformThinking(out);
                }

                if (out) {
                  const chunk: OpenAIResponse = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: { content: out },
                    }],
                  };
                  safeEnqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              }

              // Check if done
              if (upstreamData.data.done || upstreamData.data.phase === "done") {
                debugLog("Stream done");
                const endChunk: OpenAIResponse = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  }],
                };
                safeEnqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                safeEnqueue(encoder.encode("data: [DONE]\n\n"));
                safeClose();
                // Record stats before returning
                const duration = Date.now() - startTime;
                recordRequestStats(startTime, path, 200, 0, model, true, messageCount, clientIP);
                addLiveRequest("POST", path, 200, duration, clientIP, userAgent, model);
                return;
              }
            } catch (e) {
              debugLog("Parse error:", e);
            }
          }
        }

        safeClose();

        // Record stats
        const duration = Date.now() - startTime;
        recordRequestStats(startTime, path, 200, 0, model, true, messageCount, clientIP);
        addLiveRequest("POST", path, 200, duration, clientIP, userAgent, model);
      } catch (error) {
        debugLog("Stream error:", error);
        if (!streamClosed) {
          try {
            controller.error(error);
            streamClosed = true;
          } catch (e) {
            debugLog("Error calling controller.error:", e);
          }
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Handle non-stream response
async function handleNonStreamResponse(
  upstreamReq: UpstreamRequest,
  chatID: string,
  authToken: string,
  startTime: number,
  path: string,
  clientIP: string,
  userAgent: string,
  model: string,
  messageCount: number,
): Promise<Response> {
  debugLog("Handling non-stream response, chat_id:", chatID);

  const upstreamResp = await callUpstream(upstreamReq, chatID, authToken);

  if (!upstreamResp.ok) {
    debugLog("Upstream error status:", upstreamResp.status);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 502, 0, model, false, messageCount, clientIP);
    addLiveRequest("POST", path, 502, duration, clientIP, userAgent, model);

    // Return OpenAI-compatible error response
    const errorResponse = {
      error: {
        message:
          `Upstream server returned error: ${upstreamResp.status} ${upstreamResp.statusText}`,
        type: "upstream_error",
        code: "upstream_error",
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const reader = upstreamResp.body?.getReader();
  if (!reader) {
    const errorResponse = {
      error: {
        message: "No response body from upstream server",
        type: "upstream_error",
        code: "no_response_body",
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;

      const dataStr = line.substring(6);
      if (!dataStr || dataStr === "[DONE]") continue; // Skip empty or DONE markers

      try {
        const upstreamData: UpstreamData = JSON.parse(dataStr);

        if (upstreamData.data.delta_content) {
          let out = upstreamData.data.delta_content;
          if (upstreamData.data.phase === "thinking") {
            out = transformThinking(out);
          }
          if (out) {
            fullContent += out;
          }
        }

        if (upstreamData.data.done || upstreamData.data.phase === "done") {
          break;
        }
      } catch (e) {
        debugLog("Parse error:", e);
      }
    }
  }

  const response: OpenAIResponse = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: fullContent,
      },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  const duration = Date.now() - startTime;
  recordRequestStats(startTime, path, 200, 0, model, false, messageCount, clientIP);
  addLiveRequest("POST", path, 200, duration, clientIP, userAgent, model);

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// CORS headers
function setCORSHeaders(headers: Headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Credentials", "true");
}

// Handle models endpoint
async function handleModels(req: Request): Promise<Response> {
  const startTime = Date.now();
  const clientIP = getClientIP(req);
  const userAgent = req.headers.get("User-Agent") || "";

  try {
    // Get exposed models from config
    const exposedModels = listExposedModels();

    // Transform to OpenAI format
    const models = exposedModels.map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: model.platformId, // Show which platform owns this model
    }));

    const response = {
      object: "list",
      data: models,
    };

    debugLog(`Returning ${models.length} configured models: ${models.map(m => m.id).join(", ")}`);

    const headers = new Headers({ "Content-Type": "application/json" });
    setCORSHeaders(headers);

    // Record successful stats
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, "/v1/models", 200, 0, undefined, undefined, undefined, clientIP);
    addLiveRequest("GET", "/v1/models", 200, duration, clientIP, userAgent);

    return new Response(JSON.stringify(response), { status: 200, headers });
  } catch (error) {
    debugLog(`Error building models list: ${error}`);

    // Fallback to default model
    const response = {
      object: "list",
      data: [{
        id: MODEL_NAME,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: PlatformConfig.ownedBy,
      }],
    };

    const headers = new Headers({ "Content-Type": "application/json" });
    setCORSHeaders(headers);

    // Record error stats (still return 200 with fallback data)
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, "/v1/models", 200, 0, undefined, undefined, undefined, clientIP);
    addLiveRequest("GET", "/v1/models", 200, duration, clientIP, userAgent);

    return new Response(JSON.stringify(response), { status: 200, headers });
  }
}

// Handle zread.ai chat completions using two-step API
async function handleZreadAIChatCompletion(body: OpenAIRequest, authToken: string, platform: any): Promise<Response> {
  const startTime = Date.now();
  debugLog("Using zread.ai two-step API flow");

  try {
    // Performance optimization: Check cache for non-streaming requests
    if (!body.stream) {
      const cacheKey = generateCacheKey(body.model || MODEL_NAME, body.messages);
      const cachedResponse = getCachedResponse(cacheKey);

      if (cachedResponse) {
        debugLog("Cache hit! Returning cached response");
        performanceMetrics.totalRequests++;

        // Return cached response as OpenAI format
        const openaiResponse = {
          id: "chatcmpl-" + Math.random().toString(36).substr(2, 9),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model || MODEL_NAME,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: cachedResponse
            },
            finish_reason: "stop"
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
          }
        };

        return new Response(JSON.stringify(openaiResponse), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Skip talk creation and use existing talk ID to avoid parameter errors
    const talkId = "31064d72-a25c-11f0-901e-1a109de107af";
    debugLog("Using existing talk ID:", talkId);

    // Get the last user message
    const lastMessage = body.messages[body.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      return new Response(
        JSON.stringify({
          error: { message: "No user message found", type: "invalid_request", code: "no_user_message" }
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 2: Send message to the talk with timeout
    const messageResponse = await sendZreadMessageOptimized(talkId, lastMessage.content, body.model, body.stream, authToken, platform);
    if (!messageResponse.ok) {
      const errorText = await messageResponse.text();
      debugLog("Failed to send zread message:", messageResponse.status, errorText);
      return new Response(
        JSON.stringify({
          error: { message: `Failed to send message: ${messageResponse.status} ${errorText}`, type: "upstream_error", code: "message_send_failed" }
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (body.stream) {
      // Handle streaming response
      return handleZreadStreamResponse(messageResponse);
    } else {
      // Handle non-streaming response with caching
      return await handleZreadNonStreamResponseOptimized(messageResponse, body.model, body.messages);
    }
  } catch (error) {
    debugLog("Zread.ai API error:", error);
    return new Response(
      JSON.stringify({
        error: { message: `Zread.ai API error: ${error.message}`, type: "upstream_error", code: "zread_api_error" }
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Create a new zread talk
async function createZreadTalk(authToken: string, platform: any): Promise<Response> {
  // Based on detailed network capture analysis:
  // The talk creation might need to be associated with a specific context
  // From the capture, we see talk ID: 31064d72-a25c-11f0-901e-1a109de107af
  // Let's try to replicate the exact browser behavior

  // Based on latest network capture: Content-Length: 62
  // Testing hypothesis: talk creation only needs repo_id (50 bytes) + maybe other fields
  const talkRequest = {
    repo_id: "d421b459-67dd-11f0-bb48-0e6fb57b239c"
  };

  debugLog("Creating zread talk with request:", JSON.stringify(talkRequest));

  const response = await fetch(platform.upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Origin": platform.originBase,
      "Referer": platform.originBase + platform.refererPrefix,
      "Accept": "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "X-Locale": "zh"
    },
    body: JSON.stringify(talkRequest)
  });

  return response;
}

// Send message to zread talk
async function sendZreadMessage(talkId: string, content: string, model: string, stream: boolean, authToken: string, platform: any): Promise<Response> {
  // Based on network capture data from 1.txt - use the correct zread.ai format
  const messageRequest = {
    parent_message_id: "", // Empty for first message in conversation
    query: content, // User's actual message content
    context: {
      wiki: {
        page_id: "45c64cba-0529-4ca6-8cd5-e36cf26fae31",
        wiki_id: "690a5a77-fe7e-4fee-9a04-c89e71c3af04"
      },
      repo: {
        repo_id: "d421b459-67dd-11f0-bb48-0e6fb57b239c" // DeepCode project repo ID
      }
    },
    model: model
  };

  const messageUrl = `${platform.upstreamUrl}/${talkId}/message`;
  debugLog("Sending zread message to:", messageUrl, "with body:", JSON.stringify(messageRequest));

  const response = await fetch(messageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Origin": platform.originBase,
      "Referer": platform.originBase + platform.refererPrefix,
      "Accept": stream ? "text/event-stream" : "application/json"
    },
    body: JSON.stringify(messageRequest)
  });

  return response;
}

// Optimized version with timeout and performance tracking
async function sendZreadMessageOptimized(talkId: string, content: string, model: string, stream: boolean, authToken: string, platform: any): Promise<Response> {
  const startTime = Date.now();

  // Based on network capture data from 1.txt - use the correct zread.ai format
  const messageRequest = {
    parent_message_id: "", // Empty for first message in conversation
    query: content, // User's actual message content
    context: {
      wiki: {
        page_id: "45c64cba-0529-4ca6-8cd5-e36cf26fae31",
        wiki_id: "690a5a77-fe7e-4fee-9a04-c89e71c3af04"
      },
      repo: {
        repo_id: "d421b459-67dd-11f0-bb48-0e6fb57b239c" // DeepCode project repo ID
      }
    },
    model: model
  };

  const messageUrl = `${platform.upstreamUrl}/${talkId}/message`;
  debugLog("Sending optimized zread message to:", messageUrl);

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    debugLog("Request timeout, aborting...");
    controller.abort();
  }, 45000); // 45 second timeout (zread.ai can be slow)

  try {
    const response = await fetch(messageUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${authToken}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Origin": platform.originBase,
        "Referer": platform.originBase + platform.refererPrefix,
        "Accept": stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
        "Connection": "keep-alive",
        "Accept-Charset": "utf-8"
      },
      body: JSON.stringify(messageRequest),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Track performance metrics
    const duration = Date.now() - startTime;
    performanceMetrics.totalRequests++;
    performanceMetrics.totalUpstreamTime += duration;
    performanceMetrics.averageUpstreamTime = performanceMetrics.totalUpstreamTime / performanceMetrics.totalRequests;

    debugLog(`Request completed in ${duration}ms`);

    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      debugLog("Request was aborted due to timeout");
      throw new Error("Request timeout after 45 seconds");
    }

    debugLog("Request failed:", error);
    throw error;
  }
}

// Handle zread streaming response
async function handleZreadStreamResponse(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');

          // Keep the last incomplete line in buffer
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
                      model: "glm-4.5",
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
            } else if (line.startsWith('event:finish')) {
              // Send final chunk
              const finalChunk = {
                id: "chatcmpl-" + Math.random().toString(36).substr(2, 9),
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "glm-4.5",
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: "stop"
                }]
              };

              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
          }
        }
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
      "Access-Control-Allow-Headers": "Cache-Control"
    }
  });
}

// Handle zread non-streaming response
async function handleZreadNonStreamResponse(response: Response, model: string): Promise<Response> {
  const responseText = await response.text();
  debugLog("Zread non-stream response:", responseText);

  try {
    // Parse SSE format to extract content
    let content = "";
    const lines = responseText.split('\n');

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

    // If no content was extracted from SSE format, try legacy parsing
    if (!content) {
      try {
        const responseData = JSON.parse(responseText);
        content = responseData.content || responseData.response || responseText;
      } catch (e) {
        content = responseText;
      }
    }

    const openaiResponse = {
      id: "chatcmpl-" + Math.random().toString(36).substr(2, 9),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    debugLog("Processed zread response, content length:", content.length);
    return new Response(JSON.stringify(openaiResponse), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    debugLog("Error processing zread response:", error);
    return new Response(
      JSON.stringify({
        error: { message: `Response processing error: ${error.message}`, type: "processing_error", code: "response_processing_failed" }
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Optimized non-streaming response handler with caching
async function handleZreadNonStreamResponseOptimized(response: Response, model: string, messages: OpenAIMessage[]): Promise<Response> {
  const responseText = await response.text();
  debugLog("Zread non-stream response (optimized):", responseText.substring(0, 200) + "...");

  try {
    // Parse SSE format to extract content
    let content = "";
    const lines = responseText.split('\n');

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

    // If no content was extracted from SSE format, try legacy parsing
    if (!content) {
      try {
        const responseData = JSON.parse(responseText);
        content = responseData.content || responseData.response || responseText;
      } catch (e) {
        content = responseText;
      }
    }

    // Cache the response for future requests (only if we have meaningful content)
    if (content && content.length > 10) {
      const cacheKey = generateCacheKey(model || MODEL_NAME, messages);
      setCachedResponse(cacheKey, content, 60000); // Cache for 60 seconds
      debugLog(`Cached response for key: ${cacheKey.substring(0, 50)}...`);
    }

    const openaiResponse = {
      id: "chatcmpl-" + Math.random().toString(36).substr(2, 9),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    debugLog("Processed optimized zread response, content length:", content.length);
    return new Response(JSON.stringify(openaiResponse), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    debugLog("Error processing optimized zread response:", error);
    return new Response(
      JSON.stringify({
        error: { message: `Response processing error: ${error.message}`, type: "processing_error", code: "response_processing_failed" }
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle chat completions
async function handleChatCompletions(req: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(req.url);
  const path = url.pathname;
  const clientIP = getClientIP(req);
  const userAgent = req.headers.get("User-Agent") || "";

  debugLog("Received chat completions request");

  // Verify API key
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    debugLog("Missing or invalid Authorization header");
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 401);
    addLiveRequest("POST", path, 401, duration, clientIP, userAgent);
    return new Response("Missing or invalid Authorization header", { status: 401 });
  }

  const apiKey = authHeader.substring(7);
  if (apiKey !== DEFAULT_KEY) {
    debugLog("Invalid API key:", apiKey);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 401);
    addLiveRequest("POST", path, 401, duration, clientIP, userAgent);
    return new Response("Invalid API key", { status: 401 });
  }

  debugLog("API key verified");

  // Parse request
  let body: OpenAIRequest;
  try {
    body = await req.json();
  } catch (e) {
    debugLog("JSON parse error:", e);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest("POST", path, 400, duration, clientIP, userAgent);
    return new Response("Invalid JSON", { status: 400 });
  }

  // Set default stream if not specified
  if (body.stream === undefined) {
    body.stream = DEFAULT_STREAM;
    debugLog("Using default stream value:", DEFAULT_STREAM);
  }

  // Track streaming vs non-streaming requests
  if (body.stream) {
    stats.streamingRequests++;
  } else {
    stats.nonStreamingRequests++;
  }

  debugLog(
    `Request parsed - model: ${body.model}, stream: ${body.stream}, messages: ${body.messages.length}`,
  );

  // Generate chat IDs
  const chatID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const msgID = `${Date.now()}`;

  // Determine thinking setting
  const enableThinking = body.enable_thinking !== undefined
    ? body.enable_thinking
    : ENABLE_THINKING;
  debugLog("Enable thinking:", enableThinking);

  // Resolve target model and platform
  const modelResolution = resolveModelRouting(body.model);
  const { platform, clientModel, upstreamModelId } = modelResolution;
  debugLog("Resolved model -> client: " + clientModel + ", upstream: " + upstreamModelId + ", platform: " + platform.id);

  // Build upstream request
  const upstreamReq: UpstreamRequest = {
    stream: true,
    chat_id: chatID,
    id: msgID,
    model: upstreamModelId,
    messages: body.messages,
    params: {},
    features: {
      enable_thinking: enableThinking,
    },
    background_tasks: {
      title_generation: false,
      tags_generation: false,
    },
    mcp_servers: [],
    model_item: {
      id: upstreamModelId,
      name: clientModel,
      owned_by: OWNED_BY,
    },
    tool_servers: [],
    variables: {
      "{{USER_NAME}}": "User",
      "{{USER_LOCATION}}": "Unknown",
      "{{CURRENT_DATETIME}}": new Date().toISOString().replace("T", " ").substring(0, 19),
    },
  };

  body.model = clientModel;

  // Get auth token with fallback cascade
  // Priority: X-ZAI-Token header > Static Token Pool > KV Token Pool > Anonymous Token
  const customZaiToken = req.headers.get("X-ZAI-Token");
  let authToken = customZaiToken || "";

  // Fallback 1: Try static token pool (ZAI_TOKEN)
  if (!authToken && STATIC_TOKEN_POOL_ENABLED) {
    const staticToken = getTokenFromStaticPool();
    if (staticToken) {
      authToken = staticToken;
      debugLog("Token obtained from static pool");
    }
  }

  // Fallback 2: Try KV token pool
  if (!authToken && KV_TOKEN_POOL_ENABLED) {
    try {
      const kvToken = await getTokenFromKVPool();
      if (kvToken) {
        authToken = kvToken;
        debugLog("Token obtained from KV pool");
      }
    } catch (e) {
      debugLog("Failed to get token from KV pool:", e);
    }
  }

  // Fallback 3: Try anonymous token
  if (!authToken) {
    try {
      authToken = await getAnonymousToken();
      debugLog("Token obtained from anonymous auth");
    } catch (e) {
      debugLog("Failed to get anonymous token:", e);
    }
  }

  // Log token source
  if (customZaiToken) {
    debugLog("Using custom ZAI token from X-ZAI-Token header");
  }

  // If still no token after all attempts, return server configuration error
  if (!authToken) {
    const errorMessage =
      `Server configuration error: No valid ${PROVIDER_BRAND} token available. Please configure UPSTREAM_TOKEN, ZAI_TOKEN, or KV_URL environment variable.`;
    debugLog(errorMessage);
    return new Response(
      JSON.stringify({
        error: {
          message: errorMessage,
          type: "server_error",
          code: "token_unavailable",
        },
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Special handling for zread.ai platform (two-step API)
  debugLog("Platform detected:", JSON.stringify(platform));
  if (platform.id === "zread") {
    debugLog("Using zread.ai two-step API handler");
    return handleZreadAIChatCompletion(body, authToken, platform);
  }

  // Call upstream
  if (body.stream) {
    return await handleStreamResponse(
      upstreamReq,
      chatID,
      authToken,
      startTime,
      path,
      clientIP,
      userAgent,
      clientModel,
      body.messages.length,
    );
  } else {
    return await handleNonStreamResponse(
      upstreamReq,
      chatID,
      authToken,
      startTime,
      path,
      clientIP,
      userAgent,
      clientModel,
      body.messages.length,
    );
  }
}

// Dashboard HTML
const dashboardHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - ZtoApi</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex items-center justify-between">
                <a href="/" class="flex items-center space-x-2 text-purple-600 hover:text-purple-700 transition">
                    <span class="text-2xl">🦕</span>
                    <span class="text-xl font-bold">ZtoApi</span>
                </a>
                <div class="flex space-x-4">
                    <a href="/" class="text-gray-600 hover:text-purple-600 transition">首页</a>
                    <a href="/docs" class="text-gray-600 hover:text-purple-600 transition">文档</a>
                    <a href="/playground" class="text-gray-600 hover:text-purple-600 transition">Playground</a>
                    <a href="/deploy" class="text-gray-600 hover:text-purple-600 transition">部署</a>
                    <a href="/dashboard" class="text-purple-600 font-semibold">Dashboard</a>
                </div>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8 max-w-7xl">
        <div class="text-center mb-8">
            <h1 class="text-4xl font-bold text-gray-900 mb-3">📊 Dashboard</h1>
            <p class="text-gray-600">实时监控 API 请求和性能统计</p>
        </div>

        <!-- Stats Cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
            <div class="bg-white rounded-xl shadow-sm border p-6 hover:shadow-md transition">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-600 text-sm mb-1">总请求数</p>
                        <p class="text-3xl font-bold text-gray-900" id="total">0</p>
                    </div>
                    <div class="bg-purple-100 p-3 rounded-lg">
                        <span class="text-3xl">📈</span>
                    </div>
                </div>
            </div>

            <div class="bg-white rounded-xl shadow-sm border p-6 hover:shadow-md transition">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-600 text-sm mb-1">成功请求</p>
                        <p class="text-3xl font-bold text-green-600" id="success">0</p>
                    </div>
                    <div class="bg-green-100 p-3 rounded-lg">
                        <span class="text-3xl">✅</span>
                    </div>
                </div>
            </div>

            <div class="bg-white rounded-xl shadow-sm border p-6 hover:shadow-md transition">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-600 text-sm mb-1">失败请求</p>
                        <p class="text-3xl font-bold text-red-600" id="failed">0</p>
                    </div>
                    <div class="bg-red-100 p-3 rounded-lg">
                        <span class="text-3xl">❌</span>
                    </div>
                </div>
            </div>

            <div class="bg-white rounded-xl shadow-sm border p-6 hover:shadow-md transition">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-600 text-sm mb-1">平均响应时间</p>
                        <p class="text-3xl font-bold text-blue-600" id="avgtime">0ms</p>
                    </div>
                    <div class="bg-blue-100 p-3 rounded-lg">
                        <span class="text-3xl">⚡</span>
                    </div>
                </div>
            </div>

            <div class="bg-white rounded-xl shadow-sm border p-6 hover:shadow-md transition">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-gray-600 text-sm mb-1">首页访问</p>
                        <p class="text-3xl font-bold text-indigo-600" id="homeviews">0</p>
                    </div>
                    <div class="bg-indigo-100 p-3 rounded-lg">
                        <span class="text-3xl">🏠</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Detailed Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
            <!-- API Stats -->
            <div class="bg-white rounded-xl shadow-sm border p-6">
                <h3 class="text-lg font-bold text-gray-900 mb-4 flex items-center">
                    <span class="text-2xl mr-2">🎯</span> API 统计
                </h3>
                <div class="space-y-3">
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">Chat Completions</span>
                        <span class="font-bold text-purple-600" id="api-calls">0</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">Models 查询</span>
                        <span class="font-bold text-purple-600" id="models-calls">0</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">流式请求</span>
                        <span class="font-bold text-blue-600" id="streaming">0</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">非流式请求</span>
                        <span class="font-bold text-blue-600" id="non-streaming">0</span>
                    </div>
                </div>
            </div>

            <!-- Performance Stats -->
            <div class="bg-white rounded-xl shadow-sm border p-6">
                <h3 class="text-lg font-bold text-gray-900 mb-4 flex items-center">
                    <span class="text-2xl mr-2">⚡</span> 性能指标
                </h3>
                <div class="space-y-3">
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">平均响应</span>
                        <span class="font-bold text-blue-600" id="avg-time-detail">0ms</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">最快响应</span>
                        <span class="font-bold text-green-600" id="fastest">0ms</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">最慢响应</span>
                        <span class="font-bold text-orange-600" id="slowest">0ms</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">成功率</span>
                        <span class="font-bold text-green-600" id="success-rate">0%</span>
                    </div>
                </div>
            </div>

            <!-- System Info -->
            <div class="bg-white rounded-xl shadow-sm border p-6">
                <h3 class="text-lg font-bold text-gray-900 mb-4 flex items-center">
                    <span class="text-2xl mr-2">📊</span> 系统信息
                </h3>
                <div class="space-y-3">
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">运行时长</span>
                        <span class="font-bold text-indigo-600" id="uptime">0</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">Token 使用</span>
                        <span class="font-bold text-indigo-600" id="tokens">0</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">最后请求</span>
                        <span class="font-bold text-gray-600 text-xs" id="last-request">-</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-600 text-sm">首页访问</span>
                        <span class="font-bold text-indigo-600" id="home-visits">0</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Top Models Card -->
        <div class="bg-white rounded-xl shadow-sm border p-6 mb-8">
            <h3 class="text-lg font-bold text-gray-900 mb-4 flex items-center">
                <span class="text-2xl mr-2">🏆</span> 热门模型 Top 3
            </h3>
            <div id="top-models" class="space-y-3">
                <p class="text-gray-500 text-sm">暂无数据</p>
            </div>
        </div>

        <!-- Chart -->
        <div class="bg-white rounded-xl shadow-sm border p-6 mb-8">
            <div class="flex items-center justify-between mb-4">
                <h2 class="text-xl font-bold text-gray-900">📉 请求趋势分析</h2>
                <div class="flex gap-2">
                    <button id="view-hourly" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm font-semibold">按小时</button>
                    <button id="view-daily" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm font-semibold">按天</button>
                </div>
            </div>

            <!-- Info banner -->
            <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3">
                <p class="text-sm text-blue-800">
                    💡 <strong>提示：</strong>此图表显示基于 Deno KV 持久化存储的历史数据。数据会在每次 API 请求后自动保存，并在 Deno Deploy 上永久保留（本地开发环境可能在重启后丢失）。
                </p>
            </div>

            <div class="mb-3 flex items-center gap-4">
                <div class="flex items-center gap-2">
                    <span class="text-sm text-gray-600">时间范围:</span>
                    <select id="time-range" class="px-3 py-1 border rounded-lg text-sm">
                        <option value="12">最近12个</option>
                        <option value="24" selected>最近24个</option>
                        <option value="48">最近48个</option>
                        <option value="72">最近72个</option>
                    </select>
                </div>
                <div class="text-sm text-gray-500" id="chart-subtitle">显示最近24小时的数据</div>
            </div>
            <canvas id="chart" height="80"></canvas>
        </div>

        <!-- Requests Table -->
        <div class="bg-white rounded-xl shadow-sm border p-6">
            <div class="flex items-center justify-between mb-4">
                <h2 class="text-xl font-bold text-gray-900">🔔 实时请求</h2>
                <span class="text-sm text-gray-500">自动刷新（每5秒）</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full">
                    <thead>
                        <tr class="border-b">
                            <th class="text-left py-3 px-4 text-gray-700 font-semibold">时间</th>
                            <th class="text-left py-3 px-4 text-gray-700 font-semibold">方法</th>
                            <th class="text-left py-3 px-4 text-gray-700 font-semibold">路径</th>
                            <th class="text-left py-3 px-4 text-gray-700 font-semibold">模型</th>
                            <th class="text-left py-3 px-4 text-gray-700 font-semibold">状态</th>
                            <th class="text-left py-3 px-4 text-gray-700 font-semibold">耗时</th>
                        </tr>
                    </thead>
                    <tbody id="requests" class="divide-y"></tbody>
                </table>
            </div>
            <div id="empty" class="text-center py-8 text-gray-500 hidden">
                暂无请求记录
            </div>
            <!-- Pagination -->
            <div id="pagination" class="mt-4 flex items-center justify-between">
                <div class="flex items-center gap-4">
                    <div class="text-sm text-gray-600">
                        共 <span id="total-requests">0</span> 条记录，第 <span id="current-page">1</span> / <span id="total-pages">1</span> 页
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-sm text-gray-600">每页:</span>
                        <select id="page-size" class="px-2 py-1 border rounded text-sm">
                            <option value="5">5</option>
                            <option value="10">10</option>
                            <option value="20" selected>20</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                        </select>
                    </div>
                </div>
                <div class="flex gap-2">
                    <button id="prev-page" class="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed">上一页</button>
                    <button id="next-page" class="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed">下一页</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let chart = null;
        const chartData = { labels: [], data: [] };
        let currentPage = 1;
        let pageSize = 20;
        let chartViewMode = 'hourly'; // 'hourly' or 'daily'
        let chartTimeRange = 24; // hours or days

        async function update() {
            try {
                const statsRes = await fetch('/dashboard/stats');
                const stats = await statsRes.json();

                // Top cards
                document.getElementById('total').textContent = stats.totalRequests;
                document.getElementById('success').textContent = stats.successfulRequests;
                document.getElementById('failed').textContent = stats.failedRequests;
                document.getElementById('avgtime').textContent = Math.round(stats.averageResponseTime) + 'ms';
                document.getElementById('homeviews').textContent = stats.homePageViews;

                // API Stats
                document.getElementById('api-calls').textContent = stats.apiCallsCount || 0;
                document.getElementById('models-calls').textContent = stats.modelsCallsCount || 0;
                document.getElementById('streaming').textContent = stats.streamingRequests || 0;
                document.getElementById('non-streaming').textContent = stats.nonStreamingRequests || 0;

                // Performance Stats
                document.getElementById('avg-time-detail').textContent = Math.round(stats.averageResponseTime) + 'ms';
                document.getElementById('fastest').textContent = stats.fastestResponse === Infinity ? '-' : Math.round(stats.fastestResponse) + 'ms';
                document.getElementById('slowest').textContent = stats.slowestResponse === 0 ? '-' : Math.round(stats.slowestResponse) + 'ms';
                const successRate = stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : '0';
                document.getElementById('success-rate').textContent = successRate + '%';

                // System Info
                const uptime = Date.now() - new Date(stats.startTime).getTime();
                const hours = Math.floor(uptime / 3600000);
                const minutes = Math.floor((uptime % 3600000) / 60000);
                document.getElementById('uptime').textContent = hours + 'h ' + minutes + 'm';
                document.getElementById('tokens').textContent = (stats.totalTokensUsed || 0).toLocaleString();
                document.getElementById('last-request').textContent = stats.lastRequestTime ? new Date(stats.lastRequestTime).toLocaleTimeString() : '-';
                document.getElementById('home-visits').textContent = stats.homePageViews;

                // Top Models
                const topModelsDiv = document.getElementById('top-models');
                if (stats.topModels && stats.topModels.length > 0) {
                    topModelsDiv.innerHTML = stats.topModels.map((m, i) => \`
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2">
                                <span class="text-lg">\${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}</span>
                                <span class="font-mono text-sm text-gray-700">\${m.model}</span>
                            </div>
                            <span class="font-bold text-purple-600">\${m.count}</span>
                        </div>
                    \`).join('');
                } else {
                    topModelsDiv.innerHTML = '<p class="text-gray-500 text-sm">暂无数据</p>';
                }

                // Fetch paginated requests
                const reqsRes = await fetch(\`/dashboard/requests?page=\${currentPage}&pageSize=\${pageSize}\`);
                const data = await reqsRes.json();
                const tbody = document.getElementById('requests');
                const empty = document.getElementById('empty');

                tbody.innerHTML = '';

                if (data.requests.length === 0) {
                    empty.classList.remove('hidden');
                } else {
                    empty.classList.add('hidden');
                    data.requests.forEach(r => {
                        const row = tbody.insertRow();
                        const time = new Date(r.timestamp).toLocaleTimeString();
                        const statusClass = r.status >= 200 && r.status < 300 ? 'text-green-600 bg-green-50' : 'text-red-600 bg-red-50';
                        const modelDisplay = r.model ? r.model : '-';

                        row.innerHTML = \`
                            <td class="py-3 px-4 text-gray-700">\${time}</td>
                            <td class="py-3 px-4"><span class="bg-blue-100 text-blue-700 px-2 py-1 rounded text-sm font-mono">\${r.method}</span></td>
                            <td class="py-3 px-4 font-mono text-sm text-gray-600">\${r.path}</td>
                            <td class="py-3 px-4 font-mono text-xs text-gray-600">\${modelDisplay}</td>
                            <td class="py-3 px-4"><span class="\${statusClass} px-2 py-1 rounded font-semibold text-sm">\${r.status}</span></td>
                            <td class="py-3 px-4 text-gray-700">\${r.duration}ms</td>
                        \`;
                    });

                    // Update pagination info
                    document.getElementById('total-requests').textContent = data.total;
                    document.getElementById('current-page').textContent = data.page;
                    document.getElementById('total-pages').textContent = data.totalPages;

                    // Enable/disable pagination buttons
                    document.getElementById('prev-page').disabled = data.page <= 1;
                    document.getElementById('next-page').disabled = data.page >= data.totalPages;
                }
            } catch (e) {
                console.error('Update error:', e);
            }
        }

        async function updateChartData() {
            try {
                let endpoint, labelKey, subtitle;

                if (chartViewMode === 'hourly') {
                    endpoint = \`/dashboard/hourly?hours=\${chartTimeRange}\`;
                    labelKey = 'hour';
                    subtitle = \`显示最近\${chartTimeRange}小时的数据\`;
                } else {
                    endpoint = \`/dashboard/daily?days=\${chartTimeRange}\`;
                    labelKey = 'date';
                    subtitle = \`显示最近\${chartTimeRange}天的数据\`;
                }

                const res = await fetch(endpoint);
                const data = await res.json();

                if (data && data.length > 0) {
                    chartData.labels = data.map(d => {
                        if (chartViewMode === 'hourly') {
                            // Format: 2025-09-30-14 -> 09-30 14:00
                            const parts = d[labelKey].split('-');
                            return \`\${parts[1]}-\${parts[2]} \${parts[3]}:00\`;
                        } else {
                            // Format: 2025-09-30 -> 09-30
                            const parts = d[labelKey].split('-');
                            return \`\${parts[1]}-\${parts[2]}\`;
                        }
                    });
                    chartData.data = data.map(d => Math.round(d.avgResponseTime));
                    subtitle += \` (共\${data.length}条记录)\`;
                } else {
                    chartData.labels = [];
                    chartData.data = [];
                    subtitle += ' - ⚠️ 暂无持久化数据，请发送API请求后稍等片刻';
                }

                document.getElementById('chart-subtitle').textContent = subtitle;
                updateChart();
            } catch (e) {
                console.error('Chart update error:', e);
                document.getElementById('chart-subtitle').textContent = '⚠️ 加载数据失败: ' + e.message;
            }
        }

        function updateChart() {
            const ctx = document.getElementById('chart').getContext('2d');

            if (chart) {
                chart.data.labels = chartData.labels;
                chart.data.datasets[0].data = chartData.data;
                chart.update();
            } else {
                chart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: chartData.labels,
                        datasets: [{
                            label: '响应时间 (ms)',
                            data: chartData.data,
                            borderColor: 'rgb(147, 51, 234)',
                            backgroundColor: 'rgba(147, 51, 234, 0.1)',
                            tension: 0.4,
                            fill: true
                        }]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: {
                                    label: (ctx) => \`响应时间: \${ctx.parsed.y}ms\`
                                }
                            }
                        },
                        scales: {
                            y: {
                                beginAtZero: true,
                                ticks: { callback: (val) => val + 'ms' }
                            }
                        }
                    }
                });
            }
        }

        // Pagination handlers
        document.getElementById('prev-page').addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                update();
            }
        });

        document.getElementById('next-page').addEventListener('click', () => {
            currentPage++;
            update();
        });

        // Chart view mode handlers
        document.getElementById('view-hourly').addEventListener('click', () => {
            chartViewMode = 'hourly';
            document.getElementById('view-hourly').className = 'px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm font-semibold';
            document.getElementById('view-daily').className = 'px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm font-semibold';
            updateChartData();
        });

        document.getElementById('view-daily').addEventListener('click', () => {
            chartViewMode = 'daily';
            document.getElementById('view-daily').className = 'px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm font-semibold';
            document.getElementById('view-hourly').className = 'px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm font-semibold';
            updateChartData();
        });

        // Time range handler
        document.getElementById('time-range').addEventListener('change', (e) => {
            chartTimeRange = parseInt(e.target.value);
            updateChartData();
        });

        // Page size handler
        document.getElementById('page-size').addEventListener('change', (e) => {
            pageSize = parseInt(e.target.value);
            currentPage = 1; // Reset to first page
            update();
        });

        update();
        updateChartData();
        setInterval(update, 5000);
        setInterval(updateChartData, 60000); // Update chart every minute
    </script>
</body>
</html>`;

// Playground test page HTML
const playgroundHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Playground - ZtoApi</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- Marked.js for Markdown parsing -->
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <!-- Highlight.js for code syntax highlighting -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css">
    <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>
    <style>
        #response {
            line-height: 1.6;
        }
        #response h1, #response h2, #response h3 {
            font-weight: bold;
            margin-top: 1em;
            margin-bottom: 0.5em;
        }
        #response h1 { font-size: 1.5em; }
        #response h2 { font-size: 1.3em; }
        #response h3 { font-size: 1.1em; }
        #response p { margin-bottom: 0.8em; }
        #response ul, #response ol { margin-left: 1.5em; margin-bottom: 0.8em; }
        #response li { margin-bottom: 0.3em; }
        #response pre {
            background: #f6f8fa;
            padding: 1em;
            border-radius: 0.375rem;
            overflow-x: auto;
            margin-bottom: 1em;
        }
        #response code {
            background: #f6f8fa;
            padding: 0.2em 0.4em;
            border-radius: 0.25rem;
            font-size: 0.9em;
        }
        #response pre code {
            background: transparent;
            padding: 0;
        }
        #response blockquote {
            border-left: 4px solid #ddd;
            padding-left: 1em;
            margin: 1em 0;
            color: #666;
        }
        #response a {
            color: #3b82f6;
            text-decoration: underline;
        }
    </style>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex items-center justify-between">
                <a href="/" class="flex items-center space-x-2 text-purple-600 hover:text-purple-700 transition">
                    <span class="text-2xl">🦕</span>
                    <span class="text-xl font-bold">ZtoApi</span>
                </a>
                <div class="flex items-center space-x-6">
                    <a href="/" class="text-gray-600 hover:text-purple-600 transition">首页</a>
                    <a href="/docs" class="text-gray-600 hover:text-purple-600 transition">文档</a>
                    <a href="/playground" class="text-purple-600 font-semibold">Playground</a>
                    <a href="/deploy" class="text-gray-600 hover:text-purple-600 transition">部署</a>
                    <a href="/dashboard" class="text-gray-600 hover:text-purple-600 transition">Dashboard</a>
                </div>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8 max-w-7xl">
        <div class="text-center mb-8">
            <h1 class="text-4xl font-bold text-gray-900 mb-3">🎮 Playground</h1>
            <p class="text-gray-600">在线测试 ${PROVIDER_BRAND} ${MODEL_NAME} API 请求和响应</p>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <!-- Request Panel -->
            <div class="bg-white rounded-xl shadow-sm border p-6">
                <h2 class="text-xl font-bold text-gray-900 mb-4 flex items-center">
                    <span class="text-2xl mr-2">📤</span> 请求配置
                </h2>

                <!-- API Key -->
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-2">API Key</label>
                    <input type="text" id="apiKey" value="${DEFAULT_KEY}"
                           class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                           placeholder="sk-your-key">
                </div>

                <!-- ZAI Token (Optional) -->
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-2">ZAI Token (可选)</label>
                    <input type="text" id="zaiToken" value=""
                           class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm"
                           placeholder="留空则使用匿名 token">
                    <p class="text-xs text-gray-500 mt-1">自定义 ${PROVIDER_BRAND} 上游 token（高级选项）</p>
                </div>

                <!-- Model Selection -->
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-2">模型</label>
                    <select id="model" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500">
                        <option value="">加载中...</option>
                    </select>
                </div>

                <!-- Parameters Row -->
                <div class="grid grid-cols-2 gap-3 mb-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">Temperature</label>
                        <input type="number" id="temperature" min="0" max="2" step="0.1" value="0.7"
                               class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                               placeholder="0.7">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">Max Tokens</label>
                        <input type="number" id="maxTokens" min="1" max="8192" step="1" value="2048"
                               class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                               placeholder="2048">
                    </div>
                </div>

                <!-- Stream -->
                <div class="mb-4">
                    <label class="flex items-center">
                        <input type="checkbox" id="stream" checked class="mr-2">
                        <span class="text-sm font-medium text-gray-700">启用流式响应</span>
                    </label>
                </div>

                <!-- Enable Thinking -->
                <div class="mb-4">
                    <label class="flex items-center">
                        <input type="checkbox" id="enableThinking" ${
  ENABLE_THINKING ? "checked" : ""
} class="mr-2">
                        <span class="text-sm font-medium text-gray-700">启用思维链</span>
                    </label>
                    <p class="text-xs text-gray-500 mt-1">启用后将显示 AI 的思考过程</p>
                </div>

                <!-- System Message -->
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-2">System (可选)</label>
                    <textarea id="system" rows="3"
                              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-sm"
                              placeholder="你是一个乐于助人的AI助手..."></textarea>
                    <p class="text-xs text-gray-500 mt-1">系统提示词，用于设定角色和行为</p>
                </div>

                <!-- User Message -->
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-2">Message</label>
                    <textarea id="message" rows="6"
                              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-sm"
                              placeholder="输入你的问题...">你好，请介绍一下你自己</textarea>
                    <p class="text-xs text-gray-500 mt-1">用户消息内容</p>
                </div>

                <!-- Send Button -->
                <button id="sendBtn"
                        class="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-4 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
                    🚀 发送请求
                </button>

                <!-- Clear Button -->
                <button id="clearBtn"
                        class="w-full mt-2 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-2 px-4 rounded-lg transition">
                    🗑️ 清空响应
                </button>
            </div>

            <!-- Response Panel -->
            <div class="bg-white rounded-xl shadow-sm border p-6">
                <h2 class="text-xl font-bold text-gray-900 mb-4 flex items-center">
                    <span class="text-2xl mr-2">📥</span> 响应结果
                </h2>

                <!-- Status -->
                <div id="status" class="mb-4 p-3 bg-gray-100 rounded-lg hidden">
                    <span class="font-mono text-sm"></span>
                </div>

                <!-- Response -->
                <div class="mb-4">
                    <div class="flex items-center justify-between mb-2">
                        <label class="block text-sm font-medium text-gray-700">响应内容</label>
                        <button id="copyBtn" class="text-xs text-purple-600 hover:text-purple-700 hidden">📋 复制</button>
                    </div>
                    <div id="response"
                         class="w-full h-96 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm overflow-auto">
                        <!-- Empty state -->
                        <div id="emptyState" class="flex flex-col items-center justify-center h-full text-gray-400">
                            <div class="text-6xl mb-4">💬</div>
                            <p class="text-lg font-medium mb-2">等待请求</p>
                            <p class="text-sm">配置参数后点击"发送请求"开始测试</p>
                        </div>
                        <!-- Loading state -->
                        <div id="loadingState" class="hidden flex-col items-center justify-center h-full">
                            <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mb-4"></div>
                            <p class="text-gray-600 font-medium">正在请求中...</p>
                            <p class="text-gray-400 text-sm mt-1">请稍候</p>
                        </div>
                        <!-- Error state -->
                        <div id="errorState" class="hidden flex-col items-center justify-center h-full text-red-600">
                            <div class="text-6xl mb-4">❌</div>
                            <p class="text-lg font-medium mb-2">请求失败</p>
                            <p id="errorMessage" class="text-sm text-gray-600 text-center px-4"></p>
                        </div>
                        <!-- Content area -->
                        <div id="contentArea" class="hidden"></div>
                    </div>
                </div>

                <!-- Stats -->
                <div id="stats" class="grid grid-cols-2 gap-3 hidden">
                    <div class="bg-purple-50 p-3 rounded-lg">
                        <p class="text-xs text-gray-600">耗时</p>
                        <p id="duration" class="text-lg font-bold text-purple-600">-</p>
                    </div>
                    <div class="bg-green-50 p-3 rounded-lg">
                        <p class="text-xs text-gray-600">状态</p>
                        <p id="statusCode" class="text-lg font-bold text-green-600">-</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Request/Response Examples -->
        <div class="mt-8 bg-white rounded-xl shadow-sm border p-6">
            <h2 class="text-xl font-bold text-gray-900 mb-4 flex items-center">
                <span class="text-2xl mr-2">💡</span> 示例
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <button class="text-left p-4 border border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition example-btn"
                        data-example="simple">
                    <p class="font-semibold text-gray-900">简单对话</p>
                    <p class="text-sm text-gray-600">单轮对话示例</p>
                </button>
                <button class="text-left p-4 border border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition example-btn"
                        data-example="thinking">
                    <p class="font-semibold text-gray-900">思维链示例</p>
                    <p class="text-sm text-gray-600">展示 AI 思考过程</p>
                </button>
                <button class="text-left p-4 border border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition example-btn"
                        data-example="code">
                    <p class="font-semibold text-gray-900">代码生成</p>
                    <p class="text-sm text-gray-600">生成代码示例</p>
                </button>
                <button class="text-left p-4 border border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition example-btn"
                        data-example="creative">
                    <p class="font-semibold text-gray-900">创意写作</p>
                    <p class="text-sm text-gray-600">高温度创意输出</p>
                </button>
            </div>
        </div>
    </div>

    <footer class="bg-white border-t mt-12 py-6">
        <div class="container mx-auto px-4 text-center text-gray-500 text-sm">
            <p>Powered by <span class="font-semibold">Deno 🦕</span> | <a href="/" class="text-purple-600 hover:underline">返回首页</a> | <a href="https://github.com/libaxuan/ZtoApi" target="_blank" rel="noopener noreferrer" class="text-purple-600 hover:underline">⭐ GitHub</a></p>
        </div>
    </footer>

    <script>
        const examples = {
            simple: {
                model: 'GLM-4.5',
                system: '',
                message: '你好，请介绍一下你自己',
                enableThinking: false
            },
            thinking: {
                model: 'GLM-4.5',
                system: '你是一个专业的数学老师，擅长用清晰的思路解决问题。',
                message: '一个正方形的边长是5厘米，求它的面积和周长。',
                enableThinking: true
            },
            code: {
                model: 'GLM-4.5',
                system: '你是一个专业的编程助手，提供清晰、高效的代码示例。',
                message: '用 JavaScript 写一个函数，判断一个字符串是否为回文',
                enableThinking: false
            },
            creative: {
                model: 'GLM-4.5',
                system: '你是一个富有创意的作家，擅长创作引人入胜的故事。',
                message: '写一个关于未来城市的短故事（100字以内）',
                enableThinking: false,
                temperature: 1.2
            }
        };

        const sendBtn = document.getElementById('sendBtn');
        const clearBtn = document.getElementById('clearBtn');
        const copyBtn = document.getElementById('copyBtn');
        const responseDiv = document.getElementById('response');
        const statusDiv = document.getElementById('status');
        const statsDiv = document.getElementById('stats');
        const emptyState = document.getElementById('emptyState');
        const loadingState = document.getElementById('loadingState');
        const errorState = document.getElementById('errorState');
        const contentArea = document.getElementById('contentArea');
        const errorMessage = document.getElementById('errorMessage');

        // Show specific state
        function showState(state) {
            emptyState.classList.add('hidden');
            loadingState.classList.add('hidden');
            errorState.classList.add('hidden');
            contentArea.classList.add('hidden');

            emptyState.classList.remove('flex');
            loadingState.classList.remove('flex');
            errorState.classList.remove('flex');

            if (state === 'empty') {
                emptyState.classList.remove('hidden');
                emptyState.classList.add('flex');
            } else if (state === 'loading') {
                loadingState.classList.remove('hidden');
                loadingState.classList.add('flex');
            } else if (state === 'error') {
                errorState.classList.remove('hidden');
                errorState.classList.add('flex');
            } else if (state === 'content') {
                contentArea.classList.remove('hidden');
            }
        }

        // Load models from API
        async function loadModels() {
            try {
                const response = await fetch('/v1/models');
                const data = await response.json();
                const modelSelect = document.getElementById('model');

                // Clear loading option
                modelSelect.innerHTML = '';

                // Add models from API
                if (data.data && Array.isArray(data.data) && data.data.length > 0) {
                    data.data.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.id;
                        option.textContent = model.id;
                        // Set default selection
                        if (model.id === 'GLM-4.5') {
                            option.selected = true;
                        }
                        modelSelect.appendChild(option);
                    });
                } else {
                    // Fallback to default if API returns empty or invalid data
                    const option = document.createElement('option');
                    option.value = 'GLM-4.5';
                    option.textContent = 'GLM-4.5 (默认)';
                    option.selected = true;
                    modelSelect.appendChild(option);
                }
            } catch (error) {
                console.error('Failed to load models:', error);
                // Fallback to default on network error
                const modelSelect = document.getElementById('model');
                modelSelect.innerHTML = '';
                const option = document.createElement('option');
                option.value = 'GLM-4.5';
                option.textContent = 'GLM-4.5 (默认)';
                option.selected = true;
                modelSelect.appendChild(option);
            }
        }

        // Load models on page load
        loadModels();

        // Example buttons
        document.querySelectorAll('.example-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const example = examples[btn.dataset.example];
                document.getElementById('model').value = example.model;
                document.getElementById('system').value = example.system;
                document.getElementById('message').value = example.message;
                document.getElementById('enableThinking').checked = example.enableThinking || false;
                if (example.temperature) {
                    document.getElementById('temperature').value = example.temperature;
                }
            });
        });

        // Send request
        sendBtn.addEventListener('click', async () => {
            const apiKey = document.getElementById('apiKey').value;
            const zaiToken = document.getElementById('zaiToken').value.trim();
            const model = document.getElementById('model').value;
            const stream = document.getElementById('stream').checked;
            const temperature = parseFloat(document.getElementById('temperature').value);
            const maxTokens = parseInt(document.getElementById('maxTokens').value);
            const enableThinking = document.getElementById('enableThinking').checked;
            const systemText = document.getElementById('system').value.trim();
            const messageText = document.getElementById('message').value.trim();

            if (!messageText) {
                showState('error');
                errorMessage.textContent = '请输入消息内容';
                return;
            }

            // Build messages array
            const messages = [];
            if (systemText) {
                messages.push({ role: 'system', content: systemText });
            }
            messages.push({ role: 'user', content: messageText });

            sendBtn.disabled = true;
            sendBtn.textContent = '⏳ 请求中...';
            showState('loading');
            statusDiv.classList.add('hidden');
            statsDiv.classList.add('hidden');
            copyBtn.classList.add('hidden');

            const startTime = Date.now();

            try {
                const requestBody = { model, messages, stream };

                // Add optional parameters
                if (temperature !== 0.7) requestBody.temperature = temperature;
                if (maxTokens !== 2048) requestBody.max_tokens = maxTokens;
                if (enableThinking) requestBody.enable_thinking = true;

                // Build headers
                const headers = {
                    'Content-Type': 'application/json',
                    'Authorization': \`Bearer \${apiKey}\`
                };

                // Add custom ZAI token if provided
                if (zaiToken) {
                    headers['X-ZAI-Token'] = zaiToken;
                }

                const response = await fetch('/v1/chat/completions', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(requestBody)
                });

                const duration = Date.now() - startTime;

                // Show status
                statusDiv.classList.remove('hidden');
                statusDiv.querySelector('span').textContent = \`HTTP \${response.status} \${response.statusText}\`;
                statusDiv.className = \`mb-4 p-3 rounded-lg \${response.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}\`;

                // Show stats
                statsDiv.classList.remove('hidden');
                document.getElementById('duration').textContent = duration + 'ms';
                document.getElementById('statusCode').textContent = response.status;

                if (stream && response.ok) {
                    // Handle streaming response with Markdown rendering
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let fullText = '';

                    showState('content');

                    // Configure marked for better rendering
                    marked.setOptions({
                        breaks: true,
                        gfm: true,
                        highlight: function(code, lang) {
                            if (lang && hljs.getLanguage(lang)) {
                                try {
                                    return hljs.highlight(code, { language: lang }).value;
                                } catch (e) {}
                            }
                            return hljs.highlightAuto(code).value;
                        }
                    });

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\\n');

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') continue;

                                try {
                                    const json = JSON.parse(data);
                                    const content = json.choices[0]?.delta?.content || '';
                                    fullText += content;
                                    // Render as Markdown
                                    contentArea.innerHTML = marked.parse(fullText);
                                    // Apply syntax highlighting
                                    contentArea.querySelectorAll('pre code').forEach(block => {
                                        hljs.highlightElement(block);
                                    });
                                } catch (e) {
                                    // Ignore parse errors
                                }
                            }
                        }
                    }

                    copyBtn.classList.remove('hidden');
                } else {
                    // Handle non-streaming response with Markdown rendering
                    const data = await response.json();
                    if (data.choices && data.choices[0]?.message?.content) {
                        showState('content');
                        // Render response content as Markdown
                        const content = data.choices[0].message.content;
                        marked.setOptions({
                            breaks: true,
                            gfm: true,
                            highlight: function(code, lang) {
                                if (lang && hljs.getLanguage(lang)) {
                                    try {
                                        return hljs.highlight(code, { language: lang }).value;
                                    } catch (e) {}
                                }
                                return hljs.highlightAuto(code).value;
                        }
                        });
                        contentArea.innerHTML = marked.parse(content);
                        contentArea.querySelectorAll('pre code').forEach(block => {
                            hljs.highlightElement(block);
                        });
                    } else {
                        // Show raw JSON for errors or unexpected responses
                        showState('content');
                        contentArea.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
                    }
                    copyBtn.classList.remove('hidden');
                }
            } catch (error) {
                showState('error');
                errorMessage.textContent = error.message;
                statusDiv.classList.remove('hidden');
                statusDiv.className = 'mb-4 p-3 rounded-lg bg-red-100 text-red-700';
                statusDiv.querySelector('span').textContent = 'Error: ' + error.message;
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = '🚀 发送请求';
            }
        });

        // Clear response
        clearBtn.addEventListener('click', () => {
            showState('empty');
            statusDiv.classList.add('hidden');
            statsDiv.classList.add('hidden');
            copyBtn.classList.add('hidden');
        });

        // Copy response (copy plain text, not HTML)
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(contentArea.innerText);
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '✅ 已复制';
            setTimeout(() => {
                copyBtn.textContent = originalText;
            }, 2000);
        });

        // Support Enter key to send (Ctrl+Enter in textarea)
        document.getElementById('message').addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                sendBtn.click();
            }
        });
    </script>
</body>
</html>`;

// Deploy guide HTML
const deployHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>部署指南 - ZtoApi</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex items-center justify-between">
                <a href="/" class="flex items-center space-x-2 text-purple-600 hover:text-purple-700 transition">
                    <span class="text-2xl">🦕</span>
                    <span class="text-xl font-bold">ZtoApi</span>
                </a>
                <div class="flex space-x-4">
                    <a href="/" class="text-gray-600 hover:text-purple-600 transition">首页</a>
                    <a href="/docs" class="text-gray-600 hover:text-purple-600 transition">文档</a>
                    <a href="/playground" class="text-gray-600 hover:text-purple-600 transition">Playground</a>
                    <a href="/deploy" class="text-purple-600 font-semibold">部署</a>
                    <a href="/dashboard" class="text-gray-600 hover:text-purple-600 transition">Dashboard</a>
                </div>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8 max-w-5xl">
        <div class="text-center mb-12">
            <h1 class="text-4xl font-bold text-gray-900 mb-3">🚀 Deno Deploy 部署指南</h1>
            <p class="text-gray-600">快速部署到 Deno Deploy 平台</p>
        </div>

        <!-- Current Deployment -->
        <div class="bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl p-8 mb-8 text-white">
            <div class="flex items-center space-x-4 mb-4">
                <span class="text-4xl">🌐</span>
                <div>
                    <h2 class="text-2xl font-bold mb-2">当前部署地址</h2>
                    <a href="https://zto2api.deno.dev" target="_blank" class="text-white/90 hover:text-white underline text-lg font-mono">
                        https://zto2api.deno.dev
                    </a>
                </div>
            </div>
            <p class="text-white/80">✅ 已部署并运行中</p>
        </div>

        <!-- Quick Start -->
        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-6 flex items-center">
                <span class="mr-3">⚡</span> 快速开始
            </h2>
            <div class="space-y-4">
                <div class="flex items-start">
                    <span class="bg-purple-100 text-purple-700 rounded-full w-8 h-8 flex items-center justify-center font-bold mr-4 flex-shrink-0">1</span>
                    <div class="flex-1">
                        <h3 class="font-semibold text-gray-900 mb-2">Fork 仓库</h3>
                        <p class="text-gray-600">前往 <a href="https://github.com/libaxuan/ZtoApi" target="_blank" class="text-purple-600 hover:underline">GitHub 仓库</a>，点击右上角的 Fork 按钮</p>
                    </div>
                </div>

                <div class="flex items-start">
                    <span class="bg-purple-100 text-purple-700 rounded-full w-8 h-8 flex items-center justify-center font-bold mr-4 flex-shrink-0">2</span>
                    <div class="flex-1">
                        <h3 class="font-semibold text-gray-900 mb-2">登录 Deno Deploy</h3>
                        <p class="text-gray-600 mb-2">访问 <a href="https://dash.deno.com" target="_blank" class="text-purple-600 hover:underline">Deno Deploy</a> 并使用 GitHub 账号登录</p>
                    </div>
                </div>

                <div class="flex items-start">
                    <span class="bg-purple-100 text-purple-700 rounded-full w-8 h-8 flex items-center justify-center font-bold mr-4 flex-shrink-0">3</span>
                    <div class="flex-1">
                        <h3 class="font-semibold text-gray-900 mb-2">创建新项目</h3>
                        <p class="text-gray-600">点击 "New Project"，选择你 Fork 的仓库，入口文件选择 <code class="bg-gray-100 px-2 py-1 rounded font-mono text-sm">main.ts</code></p>
                    </div>
                </div>

                <div class="flex items-start">
                    <span class="bg-purple-100 text-purple-700 rounded-full w-8 h-8 flex items-center justify-center font-bold mr-4 flex-shrink-0">4</span>
                    <div class="flex-1">
                        <h3 class="font-semibold text-gray-900 mb-2">配置环境变量</h3>
                        <p class="text-gray-600">在项目设置中添加必要的环境变量（见下方详细说明）</p>
                    </div>
                </div>

                <div class="flex items-start">
                    <span class="bg-purple-100 text-purple-700 rounded-full w-8 h-8 flex items-center justify-center font-bold mr-4 flex-shrink-0">5</span>
                    <div class="flex-1">
                        <h3 class="font-semibold text-gray-900 mb-2">部署完成！</h3>
                        <p class="text-gray-600">Deno Deploy 会自动部署，几秒钟后即可访问</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Environment Variables -->
        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-6 flex items-center">
                <span class="mr-3">🔐</span> 环境变量配置
            </h2>

            <div class="space-y-6">
                <!-- ZAI_TOKEN -->
                <div class="border-l-4 border-yellow-400 bg-yellow-50 p-4 rounded-r-lg">
                    <h3 class="font-bold text-gray-900 mb-2 flex items-center">
                        <code class="bg-yellow-100 px-2 py-1 rounded mr-2 text-sm">ZAI_TOKEN</code>
                        <span class="text-yellow-600 text-sm">(可选)</span>
                    </h3>
                    <p class="text-gray-700 mb-3">${PROVIDER_BRAND} 的访问令牌。如不设置，系统会自动获取匿名 token。</p>
                    <div class="bg-white rounded p-3 mb-2">
                        <p class="font-semibold text-gray-800 mb-2">获取方式：</p>
                        <ol class="list-decimal list-inside space-y-1 text-sm text-gray-600">
                            <li>访问 <a href="${PROVIDER_HOME_URL}" target="_blank" class="text-purple-600 hover:underline">${PROVIDER_HOST}</a> 并登录</li>
                            <li>打开浏览器开发者工具（F12）</li>
                            <li>切换到 Network 标签</li>
                            <li>发送一条消息</li>
                            <li>在请求头中找到 <code class="bg-gray-100 px-1 rounded">Authorization: Bearer ...</code></li>
                            <li>复制 Bearer 后面的 token</li>
                        </ol>
                    </div>
                    <p class="text-sm text-yellow-700">💡 如果使用匿名 token，每次请求都会创建新的会话，不会保留历史记录</p>
                </div>

                <!-- DEFAULT_KEY -->
                <div class="border-l-4 border-blue-400 bg-blue-50 p-4 rounded-r-lg">
                    <h3 class="font-bold text-gray-900 mb-2 flex items-center">
                        <code class="bg-blue-100 px-2 py-1 rounded mr-2 text-sm">DEFAULT_KEY</code>
                        <span class="text-blue-600 text-sm">(推荐设置)</span>
                    </h3>
                    <p class="text-gray-700 mb-2">客户端调用 API 时需要的密钥。</p>
                    <div class="bg-white rounded p-3">
                        <p class="text-sm text-gray-600 mb-1">默认值：<code class="bg-gray-100 px-2 py-1 rounded font-mono">sk-your-key</code></p>
                        <p class="text-sm text-blue-700">🔒 建议设置为复杂的随机字符串，例如：<code class="bg-gray-100 px-2 py-1 rounded font-mono text-xs">sk-1a2b3c4d5e6f...</code></p>
                    </div>
                </div>

                <!-- Other Variables -->
                <div class="border-l-4 border-gray-400 bg-gray-50 p-4 rounded-r-lg">
                    <h3 class="font-bold text-gray-900 mb-3">其他可选变量</h3>
                    <div class="space-y-2 text-sm">
                        <div class="bg-white rounded p-2">
                            <code class="text-purple-600 font-mono">MODEL_NAME</code>
                            <span class="text-gray-600 ml-2">- 模型显示名称（默认：GLM-4.5）</span>
                        </div>
                        <div class="bg-white rounded p-2">
                            <code class="text-purple-600 font-mono">DEBUG_MODE</code>
                            <span class="text-gray-600 ml-2">- 调试模式（默认：true）</span>
                        </div>
                        <div class="bg-white rounded p-2">
                            <code class="text-purple-600 font-mono">DEFAULT_STREAM</code>
                            <span class="text-gray-600 ml-2">- 默认流式响应（默认：true）</span>
                        </div>
                        <div class="bg-white rounded p-2">
                            <code class="text-purple-600 font-mono">ENABLE_THINKING</code>
                            <span class="text-gray-600 ml-2">- 启用思考功能（默认：false）</span>
                        </div>
                        <div class="bg-white rounded p-2">
                            <code class="text-purple-600 font-mono">DASHBOARD_ENABLED</code>
                            <span class="text-gray-600 ml-2">- 启用 Dashboard（默认：true）</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Usage Example -->
        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-6 flex items-center">
                <span class="mr-3">💻</span> 使用示例
            </h2>

            <p class="text-gray-700 mb-4">部署完成后，使用以下代码调用 API：</p>

            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto mb-4">
                <pre class="text-green-400 font-mono text-sm">import openai

client = openai.OpenAI(
    api_key="你设置的 DEFAULT_KEY",
    base_url="https://zto2api.deno.dev/v1"
)

response = client.chat.completions.create(
    model="GLM-4.5",
    messages=[{"role": "user", "content": "你好"}]
)

print(response.choices[0].message.content)</pre>
            </div>

            <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p class="text-sm text-blue-800">
                    <strong>提示：</strong> 确保使用你在环境变量中设置的 <code class="bg-white px-2 py-1 rounded">DEFAULT_KEY</code> 作为 api_key
                </p>
            </div>
        </div>

        <!-- Tips -->
        <div class="bg-gradient-to-r from-green-50 to-blue-50 border border-green-200 rounded-xl p-6 mb-6">
            <h3 class="font-bold text-gray-900 mb-3 flex items-center">
                <span class="text-2xl mr-2">💡</span> 小贴士
            </h3>
            <ul class="space-y-2 text-gray-700">
                <li class="flex items-start">
                    <span class="text-green-600 mr-2">✓</span>
                    <span>Deno Deploy 提供免费额度，适合个人使用</span>
                </li>
                <li class="flex items-start">
                    <span class="text-green-600 mr-2">✓</span>
                    <span>每次 git push 后会自动重新部署</span>
                </li>
                <li class="flex items-start">
                    <span class="text-green-600 mr-2">✓</span>
                    <span>支持自定义域名（在项目设置中配置）</span>
                </li>
                <li class="flex items-start">
                    <span class="text-green-600 mr-2">✓</span>
                    <span>可在 Deno Deploy 控制台查看日志和监控</span>
                </li>
            </ul>
        </div>

        <!-- Actions -->
        <div class="flex justify-center space-x-4">
            <a href="https://dash.deno.com/new" target="_blank" class="inline-block bg-purple-600 hover:bg-purple-700 text-white font-semibold px-8 py-3 rounded-lg transition">
                立即部署到 Deno Deploy
            </a>
            <a href="/" class="inline-block bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold px-8 py-3 rounded-lg transition">
                返回首页
            </a>
        </div>
    </div>
</body>
</html>`;

// Home page HTML
const homeHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZtoApi - OpenAI兼容API代理</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gradient-to-br from-purple-600 via-purple-700 to-indigo-800">
    <div class="container mx-auto px-4 py-12 flex items-center justify-center min-h-screen">
        <div class="max-w-4xl w-full">
            <!-- Header -->
            <div class="text-center mb-12 animate-fade-in">
                <h1 class="text-6xl font-bold text-white mb-4">
                    <span class="inline-block hover:scale-110 transition-transform">🦕</span> ZtoApi
                </h1>
                <p class="text-xl text-purple-100">OpenAI 兼容 API 代理 for ${PROVIDER_BRAND} ${MODEL_NAME}</p>
            </div>

            <!-- Status Card -->
            <div class="bg-white/10 backdrop-blur-lg rounded-2xl p-8 mb-8 border border-white/20 shadow-2xl">
                <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
                    <div class="text-center">
                        <div class="text-3xl mb-2">🟢</div>
                        <div class="text-white/60 text-sm mb-1">状态</div>
                        <div class="text-white font-semibold">运行中</div>
                    </div>
                    <div class="text-center">
                        <div class="text-3xl mb-2">🤖</div>
                        <div class="text-white/60 text-sm mb-1">模型</div>
                        <div class="text-white font-semibold font-mono">${MODEL_NAME}</div>
                    </div>
                    <div class="text-center">
                        <div class="text-3xl mb-2">🔌</div>
                        <div class="text-white/60 text-sm mb-1">端口</div>
                        <div class="text-white font-semibold font-mono">${PORT}</div>
                    </div>
                    <div class="text-center">
                        <div class="text-3xl mb-2">⚡</div>
                        <div class="text-white/60 text-sm mb-1">运行时</div>
                        <div class="text-white font-semibold">Deno</div>
                    </div>
                </div>
            </div>

            <!-- Navigation Cards -->
            <div class="grid md:grid-cols-4 gap-6 mb-8">
                <a href="/docs" class="group bg-white/10 backdrop-blur-lg rounded-xl p-6 border border-white/20 hover:bg-white/20 hover:border-white/40 transition-all duration-300 hover:-translate-y-2 hover:shadow-2xl">
                    <div class="text-5xl mb-4 group-hover:scale-110 transition-transform">📖</div>
                    <h3 class="text-white text-xl font-bold mb-2">API 文档</h3>
                    <p class="text-purple-100">查看完整的 API 使用文档和示例</p>
                </a>

                <a href="/playground" class="group bg-white/10 backdrop-blur-lg rounded-xl p-6 border border-white/20 hover:bg-white/20 hover:border-white/40 transition-all duration-300 hover:-translate-y-2 hover:shadow-2xl">
                    <div class="text-5xl mb-4 group-hover:scale-110 transition-transform">🎮</div>
                    <h3 class="text-white text-xl font-bold mb-2">Playground</h3>
                    <p class="text-purple-100">在线测试 API 请求和响应</p>
                </a>

                <a href="/deploy" class="group bg-white/10 backdrop-blur-lg rounded-xl p-6 border border-white/20 hover:bg-white/20 hover:border-white/40 transition-all duration-300 hover:-translate-y-2 hover:shadow-2xl">
                    <div class="text-5xl mb-4 group-hover:scale-110 transition-transform">🚀</div>
                    <h3 class="text-white text-xl font-bold mb-2">部署指南</h3>
                    <p class="text-purple-100">快速部署到 Deno Deploy</p>
                </a>

                <a href="/dashboard" class="group bg-white/10 backdrop-blur-lg rounded-xl p-6 border border-white/20 hover:bg-white/20 hover:border-white/40 transition-all duration-300 hover:-translate-y-2 hover:shadow-2xl">
                    <div class="text-5xl mb-4 group-hover:scale-110 transition-transform">📊</div>
                    <h3 class="text-white text-xl font-bold mb-2">Dashboard</h3>
                    <p class="text-purple-100">实时监控请求和性能统计</p>
                </a>
            </div>

            <!-- Footer -->
            <div class="text-center text-white/60 text-sm space-y-3">
                <p>Powered by <span class="font-semibold text-white">Deno 🦕</span> | OpenAI Compatible API</p>
                <div class="flex justify-center items-center gap-6 text-xs">
                    <a href="https://github.com/dext7r/ZtoApi/blob/main/deno/zai/main.ts" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">
                        📦 源码地址
                    </a>
                    <span class="text-white/40">|</span>
                    <a href="https://github.com/libaxuan/ZtoApi" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">
                        🔗 原仓库
                    </a>
                    <span class="text-white/40">|</span>
                    <a href="https://linux.do/t/topic/1000335" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">
                        💬 交流讨论
                    </a>
                </div>
                <p class="text-white/50 text-xs italic pt-2">欲买桂花同载酒 终不似 少年游</p>
            </div>
        </div>
    </div>
</body>
</html>`;

// API docs HTML
const apiDocsHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API Documentation - ZtoApi</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <nav class="bg-white shadow-sm border-b">
        <div class="container mx-auto px-4 py-4">
            <div class="flex items-center justify-between">
                <a href="/" class="flex items-center space-x-2 text-purple-600 hover:text-purple-700 transition">
                    <span class="text-2xl">🦕</span>
                    <span class="text-xl font-bold">ZtoApi</span>
                </a>
                <div class="flex space-x-4">
                    <a href="/" class="text-gray-600 hover:text-purple-600 transition">首页</a>
                    <a href="/docs" class="text-purple-600 font-semibold">文档</a>
                    <a href="/playground" class="text-gray-600 hover:text-purple-600 transition">Playground</a>
                    <a href="/deploy" class="text-gray-600 hover:text-purple-600 transition">部署</a>
                    <a href="/dashboard" class="text-gray-600 hover:text-purple-600 transition">Dashboard</a>
                </div>
            </div>
        </div>
    </nav>

    <div class="container mx-auto px-4 py-8 max-w-5xl">
        <div class="text-center mb-12">
            <h1 class="text-4xl font-bold text-gray-900 mb-3">📖 API Documentation</h1>
            <p class="text-gray-600">OpenAI 兼容的 API 接口文档</p>
        </div>

        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-4">概述</h2>
            <p class="text-gray-700 mb-4">ZtoApi 是一个为 ${PROVIDER_BRAND} ${MODEL_NAME} 模型提供 OpenAI 兼容 API 接口的代理服务器。</p>
            <div class="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <p class="text-sm text-gray-600 mb-2">基础 URL</p>
                <code class="text-purple-700 font-mono text-lg">https://zto2api.deno.dev/v1</code>
            </div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-4">🔐 身份验证</h2>
            <p class="text-gray-700 mb-4">所有 API 请求都需要在请求头中包含 Bearer Token：</p>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                <code class="text-green-400 font-mono text-sm">Authorization: Bearer ${DEFAULT_KEY}</code>
            </div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-6">🔌 API 端点</h2>

            <div class="mb-8">
                <div class="flex items-center space-x-3 mb-3">
                    <span class="bg-green-100 text-green-700 px-3 py-1 rounded-lg font-semibold text-sm">GET</span>
                    <code class="text-lg font-mono text-gray-800">/v1/models</code>
                </div>
                <p class="text-gray-700 mb-3">获取可用模型列表</p>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                    <pre class="text-green-400 font-mono text-sm">curl https://zto2api.deno.dev/v1/models \\
  -H "Authorization: Bearer ${DEFAULT_KEY}"</pre>
                </div>
            </div>

            <div>
                <div class="flex items-center space-x-3 mb-3">
                    <span class="bg-blue-100 text-blue-700 px-3 py-1 rounded-lg font-semibold text-sm">POST</span>
                    <code class="text-lg font-mono text-gray-800">/v1/chat/completions</code>
                </div>
                <p class="text-gray-700 mb-4">创建聊天完成（支持流式和非流式）</p>

                <div class="bg-gray-50 rounded-lg p-4 mb-4">
                    <h4 class="font-semibold text-gray-900 mb-3">请求参数</h4>
                    <div class="space-y-2 text-sm">
                        <div class="flex items-start">
                            <code class="bg-white px-2 py-1 rounded mr-3 text-purple-600 font-mono">model</code>
                            <span class="text-gray-600">string, 必需 - 模型名称 (如 "${MODEL_NAME}")</span>
                        </div>
                        <div class="flex items-start">
                            <code class="bg-white px-2 py-1 rounded mr-3 text-purple-600 font-mono">messages</code>
                            <span class="text-gray-600">array, 必需 - 消息列表</span>
                        </div>
                        <div class="flex items-start">
                            <code class="bg-white px-2 py-1 rounded mr-3 text-purple-600 font-mono">stream</code>
                            <span class="text-gray-600">boolean, 可选 - 是否流式响应（默认: ${DEFAULT_STREAM}）</span>
                        </div>
                        <div class="flex items-start">
                            <code class="bg-white px-2 py-1 rounded mr-3 text-purple-600 font-mono">enable_thinking</code>
                            <span class="text-gray-600">boolean, 可选 - 是否启用思考功能</span>
                        </div>
                    </div>
                </div>

                <h4 class="font-semibold text-gray-900 mb-3">请求示例</h4>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                    <pre class="text-green-400 font-mono text-sm">curl -X POST https://zto2api.deno.dev/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${DEFAULT_KEY}" \\
  -d '{
    "model": "${MODEL_NAME}",
    "messages": [
      {"role": "user", "content": "你好"}
    ],
    "stream": false
  }'</pre>
                </div>
            </div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-4">🐍 Python 示例</h2>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                <pre class="text-green-400 font-mono text-sm">import openai

client = openai.OpenAI(
    api_key="${DEFAULT_KEY}",
    base_url="https://zto2api.deno.dev/v1"
)

response = client.chat.completions.create(
    model="${MODEL_NAME}",
    messages=[{"role": "user", "content": "你好"}]
)

print(response.choices[0].message.content)</pre>
            </div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-4">🔑 Token 管理策略</h2>
            <p class="text-gray-700 mb-4">ZtoApi 支持四种 Token 管理策略，优先级从高到低：</p>

            <div class="space-y-4 mb-6">
                <div class="border-l-4 border-purple-500 bg-purple-50 p-4 rounded-r-lg">
                    <h3 class="font-semibold text-purple-900 mb-2">1. 静态 Token 池（ZAI_TOKEN 多 Token）⭐ 新功能</h3>
                    <p class="text-gray-700 text-sm mb-2">通过 <code class="bg-purple-100 px-1 rounded">|</code> 分隔配置多个 token，每次请求随机选择</p>
                    <div class="bg-gray-900 rounded p-3 mb-2">
                        <code class="text-green-400 font-mono text-xs">export ZAI_TOKEN="token1|token2|token3"</code>
                    </div>
                    <div class="flex items-start space-x-2 text-sm">
                        <span class="text-green-600">✓</span>
                        <span class="text-gray-600">多账号自动轮换，配置简单</span>
                    </div>
                    <div class="flex items-start space-x-2 text-sm">
                        <span class="text-green-600">✓</span>
                        <span class="text-gray-600">无需外部数据库，适合小规模部署</span>
                    </div>
                    <div class="flex items-start space-x-2 text-sm">
                        <span class="text-green-600">✓</span>
                        <span class="text-gray-600">负载均衡，降低单账号请求频率</span>
                    </div>
                </div>

                <div class="border-l-4 border-indigo-500 bg-indigo-50 p-4 rounded-r-lg">
                    <h3 class="font-semibold text-indigo-900 mb-2">2. 固定单 Token（ZAI_TOKEN）</h3>
                    <p class="text-gray-700 text-sm mb-2">适用于单一账号，稳定性高</p>
                    <div class="bg-gray-900 rounded p-3">
                        <code class="text-green-400 font-mono text-xs">export ZAI_TOKEN="your-fixed-token"</code>
                    </div>
                </div>

                <div class="border-l-4 border-blue-500 bg-blue-50 p-4 rounded-r-lg">
                    <h3 class="font-semibold text-blue-900 mb-2">3. KV Token Pool（KV_URL）</h3>
                    <p class="text-gray-700 text-sm mb-2">从 Deno KV 数据库随机选择 token，支持多账号负载均衡</p>
                    <div class="bg-gray-900 rounded p-3 mb-2">
                        <code class="text-green-400 font-mono text-xs">export KV_URL="https://api.deno.com/databases/xxx/connect"</code>
                    </div>
                    <div class="flex items-start space-x-2 text-sm">
                        <span class="text-green-600">✓</span>
                        <span class="text-gray-600">多账号自动轮换</span>
                    </div>
                    <div class="flex items-start space-x-2 text-sm">
                        <span class="text-green-600">✓</span>
                        <span class="text-gray-600">单个账号失效不影响服务</span>
                    </div>
                    <div class="flex items-start space-x-2 text-sm">
                        <span class="text-green-600">✓</span>
                        <span class="text-gray-600">支持与 zai_register.ts 联动</span>
                    </div>
                </div>

                <div class="border-l-4 border-gray-500 bg-gray-50 p-4 rounded-r-lg">
                    <h3 class="font-semibold text-gray-900 mb-2">4. 匿名 Token（默认）</h3>
                    <p class="text-gray-700 text-sm mb-2">每次请求自动获取临时 token</p>
                    <div class="bg-gray-900 rounded p-3">
                        <code class="text-green-400 font-mono text-xs"># 不设置任何环境变量即可</code>
                    </div>
                </div>
            </div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border p-8 mb-6">
            <h2 class="text-2xl font-bold text-gray-900 mb-4">🤖 KV Token Pool + zai_register 联动部署</h2>
            <p class="text-gray-700 mb-4">通过 <code class="bg-gray-100 px-2 py-1 rounded">zai_register.ts</code> 批量注册 ${PROVIDER_BRAND} 账号并存储到 Deno KV，然后让 <code class="bg-gray-100 px-2 py-1 rounded">main.ts</code> 从同一个 KV 读取 token 使用。</p>

            <div class="mb-6">
                <h3 class="font-semibold text-gray-900 mb-3">📋 部署步骤</h3>

                <div class="space-y-4">
                    <div class="bg-purple-50 border border-purple-200 rounded-lg p-4">
                        <div class="flex items-center mb-2">
                            <span class="bg-purple-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm mr-2">1</span>
                            <h4 class="font-semibold text-purple-900">部署账号注册器（zai_register.ts）</h4>
                        </div>
                        <p class="text-gray-700 text-sm mb-2">首先部署批量注册工具到 Deno Deploy：</p>
                        <div class="bg-gray-900 rounded p-3 text-xs">
                            <pre class="text-green-400 font-mono"># 克隆仓库
git clone https://github.com/dext7r/ZtoApi.git
cd ZtoApi/deno/zai

# 部署到 Deno Deploy
deno task deploy-register

# 或者本地运行
deno run --allow-net --allow-env --allow-read zai_register.ts</pre>
                        </div>
                        <p class="text-gray-600 text-sm mt-2">📌 访问 <code class="bg-white px-2 py-1 rounded">http://localhost:8001</code> 批量注册账号</p>
                    </div>

                    <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <div class="flex items-center mb-2">
                            <span class="bg-blue-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm mr-2">2</span>
                            <h4 class="font-semibold text-blue-900">获取 KV 数据库连接 URL</h4>
                        </div>
                        <p class="text-gray-700 text-sm mb-2">在 Deno Deploy Dashboard 中获取 KV 连接 URL：</p>
                        <ol class="list-decimal list-inside text-sm text-gray-700 space-y-1 ml-4">
                            <li>访问 <a href="https://dash.deno.com" target="_blank" class="text-blue-600 underline">https://dash.deno.com</a></li>
                            <li>进入你的项目 → KV 数据库</li>
                            <li>复制连接 URL，格式如下：</li>
                        </ol>
                        <div class="bg-gray-900 rounded p-3 text-xs mt-2">
                            <code class="text-green-400 font-mono">https://api.deno.com/databases/3e00b51f-xxx/connect</code>
                        </div>
                    </div>

                    <div class="bg-green-50 border border-green-200 rounded-lg p-4">
                        <div class="flex items-center mb-2">
                            <span class="bg-green-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm mr-2">3</span>
                            <h4 class="font-semibold text-green-900">配置 main.ts 使用 KV Token Pool</h4>
                        </div>
                        <p class="text-gray-700 text-sm mb-2">在 main.ts 的环境变量中配置 KV_URL：</p>
                        <div class="bg-gray-900 rounded p-3 text-xs">
                            <pre class="text-green-400 font-mono"># .env.local 文件
KV_URL=https://api.deno.com/databases/3e00b51f-xxx/connect

# 或者在 Deno Deploy 环境变量中添加
# 变量名: KV_URL
# 变量值: https://api.deno.com/databases/3e00b51f-xxx/connect</pre>
                        </div>
                    </div>

                    <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                        <div class="flex items-center mb-2">
                            <span class="bg-yellow-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm mr-2">4</span>
                            <h4 class="font-semibold text-yellow-900">启动并验证</h4>
                        </div>
                        <p class="text-gray-700 text-sm mb-2">启动服务，查看日志确认 KV Token Pool 已启用：</p>
                        <div class="bg-gray-900 rounded p-3 text-xs">
                            <pre class="text-green-400 font-mono">deno task start

# 查看日志输出
🔑 Token strategy: KV token pool (https://api.deno.com/...)
KV token pool initialized: https://api.deno.com/...
Selected token from KV pool: xxx@domain.com (10 accounts available)</pre>
                        </div>
                    </div>
                </div>
            </div>

            <div class="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                <h3 class="font-semibold text-indigo-900 mb-3">🎯 工作原理</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <div class="flex items-start">
                        <span class="text-indigo-600 mr-2">1.</span>
                        <span><code class="bg-white px-2 py-1 rounded">zai_register.ts</code> 批量注册账号并存储到 Deno KV 的 <code class="bg-white px-2 py-1 rounded">["zai_accounts", timestamp, email]</code> 键</span>
                    </div>
                    <div class="flex items-start">
                        <span class="text-indigo-600 mr-2">2.</span>
                        <span><code class="bg-white px-2 py-1 rounded">main.ts</code> 从同一个 KV 读取所有账号列表</span>
                    </div>
                    <div class="flex items-start">
                        <span class="text-indigo-600 mr-2">3.</span>
                        <span>每次 API 请求随机选择一个 token 使用，实现负载均衡</span>
                    </div>
                    <div class="flex items-start">
                        <span class="text-indigo-600 mr-2">4.</span>
                        <span>单个账号失效不影响整体服务，其他账号继续工作</span>
                    </div>
                </div>
            </div>

            <div class="bg-gray-50 border border-gray-200 rounded-lg p-4 mt-4">
                <h3 class="font-semibold text-gray-900 mb-2">📚 相关资源</h3>
                <div class="space-y-2 text-sm">
                    <div class="flex items-center">
                        <span class="text-purple-600 mr-2">📄</span>
                        <a href="https://github.com/dext7r/ZtoApi/tree/main/deno/zai/zai_register.ts" target="_blank" class="text-blue-600 hover:underline">zai_register.ts 源码</a>
                    </div>
                    <div class="flex items-center">
                        <span class="text-purple-600 mr-2">📖</span>
                        <a href="https://github.com/dext7r/ZtoApi/blob/main/deno/zai/zai_register.md" target="_blank" class="text-blue-600 hover:underline">zai_register 使用文档</a>
                    </div>
                    <div class="flex items-center">
                        <span class="text-purple-600 mr-2">🌐</span>
                        <a href="https://docs.deno.com/deploy/kv/manual" target="_blank" class="text-blue-600 hover:underline">Deno KV 官方文档</a>
                    </div>
                </div>
            </div>
        </div>

        <div class="text-center">
            <a href="/" class="inline-block bg-purple-600 hover:bg-purple-700 text-white font-semibold px-6 py-3 rounded-lg transition">
                返回首页
            </a>
        </div>
    </div>
</body>
</html>`;

// Main request handler
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    const headers = new Headers();
    setCORSHeaders(headers);
    return new Response(null, { status: 200, headers });
  }

  // Routes
  if (path === "/" && req.method === "GET") {
    stats.homePageViews++;
    return new Response(homeHTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/v1/models" && req.method === "GET") {
    return await handleModels(req);
  }

  if (path === "/v1/chat/completions" && req.method === "POST") {
    return await handleChatCompletions(req);
  }

  if (path === "/docs" && req.method === "GET") {
    return new Response(apiDocsHTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/deploy" && req.method === "GET") {
    return new Response(deployHTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/playground" && req.method === "GET") {
    return new Response(playgroundHTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (DASHBOARD_ENABLED) {
    if (path === "/dashboard" && req.method === "GET") {
      return new Response(dashboardHTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/dashboard/stats" && req.method === "GET") {
      // Get top 3 models
      const modelEntries = Array.from(stats.modelUsage.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      const topModels = modelEntries.map(([model, count]) => ({ model, count }));

      // Convert stats to JSON-serializable format
      const statsResponse = {
        ...stats,
        modelUsage: undefined, // Remove Map
        topModels, // Add top 3 models
      };

      return new Response(JSON.stringify(statsResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/dashboard/requests" && req.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "1");
      const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
      const start = (page - 1) * pageSize;
      const end = start + pageSize;

      const paginatedRequests = liveRequests.slice().reverse().slice(start, end);

      return new Response(
        JSON.stringify({
          requests: paginatedRequests,
          total: liveRequests.length,
          page,
          pageSize,
          totalPages: Math.ceil(liveRequests.length / pageSize),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (path === "/dashboard/hourly" && req.method === "GET") {
      const hours = parseInt(url.searchParams.get("hours") || "24");
      const hourlyStats = await getHourlyStats(hours);
      return new Response(JSON.stringify(hourlyStats), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/dashboard/daily" && req.method === "GET") {
      const days = parseInt(url.searchParams.get("days") || "30");
      const dailyStats = await getDailyStats(days);
      return new Response(JSON.stringify(dailyStats), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}

// Start server
console.log(`🚀 ZtoApi (Deno) starting on port ${PORT}`);
console.log(`📦 Model: ${MODEL_NAME}`);
console.log(`🌐 Upstream: ${UPSTREAM_URL}`);
console.log(`🐛 Debug mode: ${DEBUG_MODE}`);
console.log(`🌊 Default stream: ${DEFAULT_STREAM}`);
console.log(`📊 Dashboard enabled: ${DASHBOARD_ENABLED}`);
console.log(`🧠 Thinking enabled: ${ENABLE_THINKING}`);

// Token strategy logging (shows configured pools, fallback to anonymous if all fail)
const tokenSources = [];
if (STATIC_TOKEN_POOL_ENABLED) {
  tokenSources.push(`Static Pool (${ZAI_TOKEN_ARRAY.length} tokens)`);
}
if (KV_TOKEN_POOL_ENABLED) {
  tokenSources.push(`KV Pool`);
}
tokenSources.push(`Anonymous`);

console.log(`🔑 Token strategy: ${tokenSources.join(" → ")} (fallback cascade)`);

if (DASHBOARD_ENABLED) {
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
}
console.log(`📖 API Docs: http://localhost:${PORT}/docs`);

// Initialize database and KV token pool
await initDB();
await initKVTokenPool();

// Schedule daily stats aggregation and cleanup (runs every hour)
setInterval(async () => {
  await saveDailyStats();
  await cleanupOldData();
}, 60 * 60 * 1000);

Deno.serve({ port: PORT }, handler);
