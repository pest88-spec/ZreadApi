// Shared configuration helpers for ZtoApi Deno services
// Allows switching between chat.z.ai and zread.ai (or other compatible upstreams)

function ensureTrailingSlash(value: string): string {
  if (!value) return "/";
  return value.endsWith("/") ? value : `${value}/`;
}

function stripTrailingSlash(value: string): string {
  if (!value) return value;
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const PLATFORM_ID = Deno.env.get("PLATFORM_ID") || "zai";
const PROVIDER_NAME = Deno.env.get("PROVIDER_NAME") || "Z.ai";
const PROVIDER_BRAND = Deno.env.get("PROVIDER_BRAND") || PROVIDER_NAME;
const PROVIDER_HOME_URL = Deno.env.get("PROVIDER_HOME_URL") || "https://chat.z.ai";
const ORIGIN_BASE = Deno.env.get("ORIGIN_BASE") || PROVIDER_HOME_URL;
const REFERER_PREFIX = Deno.env.get("REFERER_PREFIX") || "/c/";
const REGISTER_BASE_URL = Deno.env.get("REGISTER_BASE_URL") || PROVIDER_HOME_URL;
const REGISTER_SSO_REDIRECT = ensureTrailingSlash(
  Deno.env.get("REGISTER_SSO_REDIRECT") || PROVIDER_HOME_URL,
);
const AUTH_URL = Deno.env.get("AUTH_URL") || `${stripTrailingSlash(ORIGIN_BASE)}/api/v1/auths/`;
const MODELS_URL = Deno.env.get("MODELS_URL") || `${stripTrailingSlash(ORIGIN_BASE)}/api/models`;
const UPSTREAM_URL = Deno.env.get("UPSTREAM_URL") ||
  `${stripTrailingSlash(ORIGIN_BASE)}/api/chat/completions`;
const OWNED_BY = Deno.env.get("OWNED_BY") || PROVIDER_NAME.toLowerCase();
const X_FE_VERSION = Deno.env.get("X_FE_VERSION") || "prod-fe-1.0.94";
const DEFAULT_KEY = Deno.env.get("DEFAULT_KEY") || "sk-your-key";
const MODEL_NAME = Deno.env.get("MODEL_NAME") || "GLM-4.5";
const PORT = parseInt(Deno.env.get("PORT") || "9090", 10);
const DEBUG_MODE = (Deno.env.get("DEBUG_MODE") || "true").toLowerCase() === "true";
const DEFAULT_STREAM = (Deno.env.get("DEFAULT_STREAM") || "true").toLowerCase() === "true";
const DASHBOARD_ENABLED = (Deno.env.get("DASHBOARD_ENABLED") || "true").toLowerCase() === "true";
const ENABLE_THINKING = (Deno.env.get("ENABLE_THINKING") || "false").toLowerCase() === "true";
const KV_URL = Deno.env.get("KV_URL") || "";
const UPSTREAM_TOKEN = Deno.env.get("UPSTREAM_TOKEN") || Deno.env.get("ZAI_TOKEN") || "";
const TOKEN_HEADER = Deno.env.get("PLATFORM_TOKEN_HEADER") || "Authorization";
const API_BASE = Deno.env.get("PLATFORM_API_BASE") || ORIGIN_BASE;

function buildModelMap() {
  const raw = Deno.env.get("UPSTREAM_MODEL_ID_MAP");
  const map: Record<string, string> = {};
  const keys: string[] = [];
  if (!raw) {
    return { map, keys };
  }
  try {
    const parsed = JSON.parse(raw);
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key).trim();
      if (!normalizedKey) continue;
      keys.push(normalizedKey);
      map[normalizedKey.toLowerCase()] = String(value);
    }
  } catch (_error) {
    console.warn(
      "[config] Failed to parse UPSTREAM_MODEL_ID_MAP, falling back to default model id.",
    );
  }
  return { map, keys };
}
const { map: MODEL_ID_MAP, keys: MODEL_ID_MAP_KEYS } = buildModelMap();
const DEFAULT_MODEL_ID = Deno.env.get("UPSTREAM_MODEL_ID_DEFAULT") || MODEL_NAME;

const PROVIDER_HOST = (() => {
  try {
    return new URL(PROVIDER_HOME_URL).host || PROVIDER_HOME_URL;
  } catch {
    return PROVIDER_HOME_URL.replace(/^https?:\/\//, "");
  }
})();

export const PlatformConfig = {
  id: PLATFORM_ID,
  name: PROVIDER_NAME,
  brand: PROVIDER_BRAND,
  homeUrl: PROVIDER_HOME_URL,
  host: PROVIDER_HOST,
  originBase: ORIGIN_BASE,
  refererPrefix: REFERER_PREFIX,
  registerBaseUrl: REGISTER_BASE_URL,
  registerSsoRedirect: REGISTER_SSO_REDIRECT,
  authUrl: AUTH_URL,
  modelsUrl: MODELS_URL,
  upstreamUrl: UPSTREAM_URL,
  apiBase: API_BASE,
  ownedBy: OWNED_BY,
  tokenHeader: TOKEN_HEADER,
  defaultModelId: DEFAULT_MODEL_ID,
  modelIdMap: MODEL_ID_MAP,
  modelAliases: MODEL_ID_MAP_KEYS,
};

export const RuntimeConfig = {
  xFeVersion: X_FE_VERSION,
  defaultKey: DEFAULT_KEY,
  modelName: MODEL_NAME,
  port: PORT,
  debugMode: DEBUG_MODE,
  defaultStream: DEFAULT_STREAM,
  dashboardEnabled: DASHBOARD_ENABLED,
  enableThinking: ENABLE_THINKING,
  kvUrl: KV_URL,
  upstreamToken: UPSTREAM_TOKEN,
};

export function normalizeOrigin(value: string): string {
  return stripTrailingSlash(value);
}

export function buildReferer(chatId: string): string {
  const prefix = PlatformConfig.refererPrefix.endsWith("/")
    ? PlatformConfig.refererPrefix
    : `${PlatformConfig.refererPrefix}/`;
  return `${normalizeOrigin(PlatformConfig.originBase)}${prefix}${chatId}`;
}

export function generateBrowserHeaders(chatId: string, authToken: string): Record<string, string> {
  const chromeVersion = Math.floor(Math.random() * 3) + 138;
  const userAgents = [
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
  ];
  const platforms = ['"Windows"', '"macOS"', '"Linux"'];
  const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
  const platform = platforms[Math.floor(Math.random() * platforms.length)];
  const origin = normalizeOrigin(PlatformConfig.originBase);

  return {
    Accept: "*/*",
    "Content-Type": "application/json",
    "User-Agent": ua,
    Authorization: `Bearer ${authToken}`,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "sec-ch-ua":
      `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="24", "Google Chrome";v="${chromeVersion}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": platform,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "X-FE-Version": RuntimeConfig.xFeVersion,
    Origin: origin,
    Referer: buildReferer(chatId),
    Priority: "u=1, i",
  };
}

export function resolveUpstreamModel(requestedModel?: string) {
  const normalizedInput = (requestedModel?.trim() || RuntimeConfig.modelName).toString();
  const lookupKey = normalizedInput.toLowerCase();
  const map = PlatformConfig.modelIdMap as Record<string, string>;
  const aliasList = PlatformConfig.modelAliases as string[] | undefined;
  const upstreamId = map[lookupKey] || PlatformConfig.defaultModelId || normalizedInput;
  const displayName = aliasList?.find((alias) => alias.toLowerCase() === lookupKey) ||
    normalizedInput;
  return {
    requestedModel: displayName,
    upstreamModelId: upstreamId,
  };
}

export function buildDefaultHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": generateBrowserHeaders("", "")["User-Agent"] ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  };
}

export function makeAccountKey(email: string, timestamp: number) {
  return ["accounts", PlatformConfig.id, timestamp, email] as const;
}

export function accountPrefix() {
  return ["accounts", PlatformConfig.id] as const;
}

export function automationLogPrefix() {
  return ["automation_logs", PlatformConfig.id] as const;
}

export const RegisterConfig = {
  baseUrl: REGISTER_BASE_URL,
  ssoRedirect: REGISTER_SSO_REDIRECT,
};
