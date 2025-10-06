// Shared configuration helpers for ZtoApi Deno services.
// Supports multi-platform routing (e.g. chat.z.ai, zread.ai) based on model name.

function ensureTrailingSlash(value: string): string {
  if (!value) return "/";
  return value.endsWith("/") ? value : value + "/";
}

function stripTrailingSlash(value: string): string {
  if (!value) return value;
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function ensureLeadingSlash(value: string): string {
  if (!value) return "/";
  return value.startsWith("/") ? value : "/" + value;
}

function parseJSONEnv<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (_error) {
    console.warn("[config] Failed to parse JSON env variable");
    return null;
  }
}

function parseDelimitedList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split("|")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export interface PlatformSettings {
  id: string;
  brand: string;
  homeUrl: string;
  originBase: string;
  apiBase: string;
  chatUrl: string;
  upstreamUrl: string;
  modelsUrl: string;
  authUrl: string;
  refererPrefix: string;
  ownedBy: string;
  tokenHeader: string;
  xFeVersion: string;
  defaultUpstreamModelId?: string;
}

interface RawPlatformConfig {
  id?: string;
  name?: string;
  brand?: string;
  homeUrl?: string;
  originBase?: string;
  apiBase?: string;
  refererPrefix?: string;
  chatUrl?: string;
  upstreamUrl?: string;
  chatPath?: string;
  modelsUrl?: string;
  modelsPath?: string;
  authUrl?: string;
  authPath?: string;
  ownedBy?: string;
  tokenHeader?: string;
  xFeVersion?: string;
  defaultUpstreamModelId?: string;
  defaultModel?: string;
}

interface ModelRouteInfo {
  platformId: string;
  clientModel: string;
  upstreamModelId: string;
}

interface ModelRouteDefinition {
  platform?: string;
  upstream?: string;
  alias?: string;
}

let DEFAULT_PLATFORM_ID_INTERNAL = (Deno.env.get("PLATFORM_ID") || "zai").toLowerCase();

const platformMap = new Map<string, PlatformSettings>();

const runtimeXFeVersion = Deno.env.get("X_FE_VERSION") || "prod-fe-1.0.94";

const RuntimeConfig = {
  defaultKey: Deno.env.get("DEFAULT_KEY") || "sk-your-key",
  modelName: Deno.env.get("MODEL_NAME") || "GLM-4.5",
  port: parseInt(Deno.env.get("PORT") || "9090", 10),
  debugMode: (Deno.env.get("DEBUG_MODE") || "true").toLowerCase() === "true",
  defaultStream: (Deno.env.get("DEFAULT_STREAM") || "true").toLowerCase() === "true",
  dashboardEnabled: (Deno.env.get("DASHBOARD_ENABLED") || "true").toLowerCase() === "true",
  enableThinking: (Deno.env.get("ENABLE_THINKING") || "false").toLowerCase() === "true",
  kvUrl: Deno.env.get("KV_URL") || "",
  upstreamToken: Deno.env.get("UPSTREAM_TOKEN") || Deno.env.get("ZAI_TOKEN") || "",
  xFeVersion: runtimeXFeVersion,
};

function normalisePlatformConfig(raw: RawPlatformConfig, fallbackId?: string): PlatformSettings {
  const id = (raw.id || fallbackId || DEFAULT_PLATFORM_ID_INTERNAL).toLowerCase();
  const homeUrl = raw.homeUrl || raw.originBase || raw.apiBase || "https://chat.z.ai";

  const originBase = stripTrailingSlash(raw.originBase || homeUrl);
  const apiBase = stripTrailingSlash(raw.apiBase || originBase);
  const refererPrefix = ensureLeadingSlash(raw.refererPrefix || "/c/");

  const chatUrl = raw.chatUrl ||
    `${apiBase}/api/chat/completions`;
  const modelsUrl = raw.modelsUrl ||
    `${apiBase}/v1/models`;
  const authUrl = raw.authUrl ||
    `${apiBase}/api/v1/auths/`;
  const resolvedAuthUrl = raw.authUrl ||
    `${apiBase}/api/v1/auths/`;
  const xFeVersion = raw.xFeVersion || RuntimeConfig.xFeVersion;

  const brand = raw.brand || raw.name || id.toUpperCase();
  const ownedBy = raw.ownedBy || brand.toLowerCase();
  const tokenHeader = raw.tokenHeader || "Authorization";
  const defaultUpstreamModelId = raw.defaultUpstreamModelId || raw.defaultModel;

  return {
    id,
    brand,
    homeUrl,
    originBase,
    apiBase,
    chatUrl,
    upstreamUrl: raw.upstreamUrl || chatUrl,
    modelsUrl,
    authUrl: resolvedAuthUrl,
    refererPrefix,
    ownedBy,
    tokenHeader,
    xFeVersion,
    defaultUpstreamModelId,
  };
}

function registerPlatform(raw: RawPlatformConfig, fallbackId?: string) {
  const platform = normalisePlatformConfig(raw, fallbackId);
  platformMap.set(platform.id, platform);
}

function loadPlatformConfigs() {
  const envValue = Deno.env.get("PLATFORM_CONFIGS");
  const parsed = parseJSONEnv<Record<string, RawPlatformConfig> | RawPlatformConfig[]>(envValue);

  if (parsed) {
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry) continue;
        registerPlatform(entry, entry.id);
      }
    } else {
      for (const [id, entry] of Object.entries(parsed)) {
        registerPlatform({ ...entry, id });
      }
    }
  }

  if (platformMap.size === 0) {
    // Auto-detect platform based on environment variables
    const platformId = DEFAULT_PLATFORM_ID_INTERNAL;
    const isZread = platformId === "zread" ||
                   (Deno.env.get("PROVIDER_HOME_URL") || "").includes("zread.ai") ||
                   (Deno.env.get("ORIGIN_BASE") || "").includes("zread.ai");

    const defaultConfig = isZread ? {
      id: "zread",
      name: "zread.ai",
      brand: "zread.ai",
      homeUrl: "https://zread.ai",
      originBase: "https://zread.ai",
      apiBase: "https://zread.ai",
      refererPrefix: "/chat/",
      ownedBy: "zread.ai",
      defaultUpstreamModelId: "glm-4.5",
    } : {
      id: "zai",
      name: "Z.ai",
      brand: "Z.ai",
      homeUrl: "https://chat.z.ai",
      originBase: "https://chat.z.ai",
      apiBase: "https://chat.z.ai",
      refererPrefix: "/c/",
      ownedBy: "z.ai",
      defaultUpstreamModelId: "0727-360B-API",
    };

    registerPlatform({
      ...defaultConfig,
      id: platformId,
      name: Deno.env.get("PROVIDER_NAME") || defaultConfig.name,
      brand: Deno.env.get("PROVIDER_BRAND") || defaultConfig.brand,
      homeUrl: Deno.env.get("PROVIDER_HOME_URL") || defaultConfig.homeUrl,
      originBase: Deno.env.get("ORIGIN_BASE") || defaultConfig.originBase,
      apiBase: Deno.env.get("PLATFORM_API_BASE") || defaultConfig.apiBase,
      refererPrefix: Deno.env.get("REFERER_PREFIX") || defaultConfig.refererPrefix,
      modelsUrl: Deno.env.get("MODELS_URL"),
      authUrl: Deno.env.get("AUTH_URL"),
      chatUrl: Deno.env.get("UPSTREAM_URL"),
      upstreamUrl: Deno.env.get("UPSTREAM_URL"),
      ownedBy: Deno.env.get("OWNED_BY") || defaultConfig.ownedBy,
      tokenHeader: Deno.env.get("PLATFORM_TOKEN_HEADER") || "Authorization",
      xFeVersion: Deno.env.get("X_FE_VERSION") || RuntimeConfig.xFeVersion,
      defaultUpstreamModelId: Deno.env.get("UPSTREAM_MODEL_ID_DEFAULT") || defaultConfig.defaultUpstreamModelId,
    });
  }

  if (!platformMap.has(DEFAULT_PLATFORM_ID_INTERNAL)) {
    const first = platformMap.values().next();
    if (first.done) {
      throw new Error("No platform configuration is available");
    }
    DEFAULT_PLATFORM_ID_INTERNAL = first.value.id;
  }
}

loadPlatformConfigs();

export const DEFAULT_PLATFORM_ID = DEFAULT_PLATFORM_ID_INTERNAL;

export function getPlatform(id: string): PlatformSettings {
  const platform = platformMap.get(id.toLowerCase());
  if (!platform) {
    throw new Error();
  }
  return platform;
}

export function getDefaultPlatform(): PlatformSettings {
  return getPlatform(DEFAULT_PLATFORM_ID);
}

function clonePlatform(platform: PlatformSettings): PlatformSettings {
  return { ...platform };
}

// Static token registry per platform
const platformStaticTokens = new Map<string, string[]>();

function registerPlatformToken(id: string, tokens: string[]) {
  const lower = id.toLowerCase();
  const existing = platformStaticTokens.get(lower) || [];
  const merged = new Set([...existing, ...tokens.filter(Boolean)]);
  platformStaticTokens.set(lower, Array.from(merged));
}

function loadStaticTokens() {
  const tokenMapRaw = parseJSONEnv<Record<string, string | string[]>>(Deno.env.get("PLATFORM_TOKEN_MAP"));
  if (tokenMapRaw) {
    for (const [id, value] of Object.entries(tokenMapRaw)) {
      if (Array.isArray(value)) {
        registerPlatformToken(id, value.map((token) => token.trim()));
      } else if (typeof value === "string") {
        registerPlatformToken(id, parseDelimitedList(value));
      }
    }
  }

  for (const [id] of platformMap) {
    const upper = id.toUpperCase();
    const single = Deno.env.get(`${upper}_TOKEN`);
    if (single) registerPlatformToken(id, [single.trim()]);
    const multi = Deno.env.get(`${upper}_TOKENS`);
    if (multi) registerPlatformToken(id, parseDelimitedList(multi));
  }

  const legacyTokens = parseDelimitedList(Deno.env.get("ZAI_TOKEN"));
  if (legacyTokens.length > 0) {
    registerPlatformToken(DEFAULT_PLATFORM_ID, legacyTokens);
  }
  const upstreamToken = RuntimeConfig.upstreamToken;
  if (upstreamToken) {
    registerPlatformToken(DEFAULT_PLATFORM_ID, [upstreamToken]);
  }
}

loadStaticTokens();

export function getStaticTokens(platformId: string): string[] {
  return platformStaticTokens.get(platformId.toLowerCase()) ?? [];
}

// Model routing configuration
const modelRouteMap = new Map<string, ModelRouteInfo>();

function registerModelRoute(clientModel: string, platformId: string, upstreamModelId?: string) {
  const trimmedModel = clientModel.trim();
  if (!trimmedModel) return;
  const normalizedKey = trimmedModel.toLowerCase();
  const normalizedPlatform = platformId.toLowerCase();
  const upstream = (upstreamModelId || trimmedModel).trim();
  modelRouteMap.set(normalizedKey, {
    platformId: normalizedPlatform,
    clientModel: trimmedModel,
    upstreamModelId: upstream,
  });
}

function loadModelRoutes() {
  const explicitMap = parseJSONEnv<Record<string, string | ModelRouteDefinition>>(Deno.env.get("MODEL_PLATFORM_MAP"));
  if (explicitMap) {
    for (const [modelName, value] of Object.entries(explicitMap)) {
      if (typeof value === "string") {
        registerModelRoute(modelName, value, undefined);
      } else if (value) {
        const platformId = value.platform || DEFAULT_PLATFORM_ID;
        const alias = value.alias || modelName;
        registerModelRoute(alias, platformId, value.upstream || modelName);
      }
    }
  }

  if (modelRouteMap.size === 0) {
    const legacyMap = parseJSONEnv<Record<string, string>>(Deno.env.get("UPSTREAM_MODEL_ID_MAP"));
    if (legacyMap) {
      for (const [modelName, upstream] of Object.entries(legacyMap)) {
        registerModelRoute(modelName, DEFAULT_PLATFORM_ID, upstream);
      }
    }
  }

  if (!modelRouteMap.has(RuntimeConfig.modelName.toLowerCase())) {
    registerModelRoute(RuntimeConfig.modelName, DEFAULT_PLATFORM_ID, undefined);
  }
}

loadModelRoutes();

const platformDefaultModels = new Map<string, string>();
for (const route of modelRouteMap.values()) {
  if (!platformDefaultModels.has(route.platformId)) {
    platformDefaultModels.set(route.platformId, route.upstreamModelId);
  }
}

for (const [id, platform] of platformMap.entries()) {
  const candidate = platform.defaultUpstreamModelId || platformDefaultModels.get(id);
  if (candidate) {
    platform.defaultUpstreamModelId = candidate;
  }
}

export interface ModelResolution {
  platform: PlatformSettings;
  platformId: string;
  clientModel: string;
  upstreamModelId: string;
}

export function resolveModelRouting(requestedModel?: string): ModelResolution {
  const input = requestedModel?.trim();
  const key = input?.toLowerCase() || RuntimeConfig.modelName.toLowerCase();
  const route = modelRouteMap.get(key);
  const platformId = route?.platformId || DEFAULT_PLATFORM_ID;
  const platform = clonePlatform(getPlatform(platformId));
  const clientModel = route?.clientModel || input || RuntimeConfig.modelName;
  const upstreamModelId = route?.upstreamModelId || platform.defaultUpstreamModelId || clientModel;
  return {
    platform,
    platformId,
    clientModel,
    upstreamModelId,
  };
}

export interface ExposedModelInfo {
  id: string;
  platformId: string;
  upstreamModelId: string;
}

export function listExposedModels(): ExposedModelInfo[] {
  const seen = new Map<string, ExposedModelInfo>();
  for (const route of modelRouteMap.values()) {
    if (!seen.has(route.clientModel)) {
      seen.set(route.clientModel, {
        id: route.clientModel,
        platformId: route.platformId,
        upstreamModelId: route.upstreamModelId,
      });
    }
  }
  return Array.from(seen.values());
}

// Legacy function for backward compatibility
export function resolveUpstreamModel(requestedModel?: string): {
  requestedModel: string;
  upstreamModelId: string;
} {
  const resolution = resolveModelRouting(requestedModel);
  return {
    requestedModel: resolution.clientModel,
    upstreamModelId: resolution.upstreamModelId,
  };
}

export { RuntimeConfig };
export const PlatformConfig = getDefaultPlatform();
