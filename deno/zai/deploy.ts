// 真实的 API 代理 - 基于 main.ts 适配 Deno Deploy
const DEFAULT_UPSTREAM_URL = "https://zread.ai/api/v1/talk";
const ZAI_UPSTREAM_URL = "https://chat.z.ai/api/chat/completions";
const DEBUG_MODE = Deno.env.get("DEBUG_MODE") === "true";

// Token池管理
let currentTokenIndex = 0;
const UPSTREAM_TOKENS = Deno.env.get("UPSTREAM_TOKENS") || Deno.env.get("UPSTREAM_TOKEN") || "";

// 模型路由 - 根据模型选择上游URL和模型ID
function resolveModelRouting(model: string): { upstreamUrl: string; upstreamModel: string; platform: string } {
  const modelMap = JSON.parse(Deno.env.get("MODEL_PLATFORM_MAP") || "{}");

  if (modelMap[model]) {
    const route = modelMap[model];
    if (route.platform === "zai") {
      return {
        upstreamUrl: ZAI_UPSTREAM_URL,
        upstreamModel: route.upstream || "0727-360B-API",
        platform: "zai"
      };
    } else {
      return {
        upstreamUrl: DEFAULT_UPSTREAM_URL,
        upstreamModel: route.upstream || model,
        platform: "zread"
      };
    }
  }

  // 默认路由：GLM-4.6 -> zai平台，其他 -> zread平台
  if (model.toLowerCase().includes("glm-4.6") || model.toLowerCase().includes("0727-360b")) {
    return {
      upstreamUrl: ZAI_UPSTREAM_URL,
      upstreamModel: "0727-360B-API",
      platform: "zai"
    };
  }

  return {
    upstreamUrl: DEFAULT_UPSTREAM_URL,
    upstreamModel: model,
    platform: "zread"
  };
}

function getNextUpstreamToken(): string {
  const tokens = UPSTREAM_TOKENS.split("|").map(t => t.trim()).filter(t => t.length > 0);
  if (tokens.length === 0) return "";

  const token = tokens[currentTokenIndex];
  currentTokenIndex = (currentTokenIndex + 1) % tokens.length;

  if (DEBUG_MODE) {
    console.log(`Using token ${currentTokenIndex}/${tokens.length}`);
  }

  return token;
}

// 支持多个API密钥
function isValidApiKey(apiKey: string): boolean {
  // 如果设置了DEFAULT_KEY，检查是否匹配
  const defaultKey = Deno.env.get("DEFAULT_KEY");
  if (defaultKey) {
    return apiKey === defaultKey;
  }

  // 如果设置了API_KEYS（多个密钥，用|分隔）
  const apiKeys = Deno.env.get("API_KEYS");
  if (apiKeys) {
    const keyList = apiKeys.split("|").map(k => k.trim()).filter(k => k.length > 0);
    return keyList.includes(apiKey);
  }

  // 如果都没有设置，允许任何密钥（开放访问）
  return true;
}

function generateBrowserHeaders(chatID: string, authToken: string, platform: string): Record<string, string> {
  const chromeVersion = Math.floor(Math.random() * 3) + 138;

  if (platform === "zai") {
    // Z.ai平台headers
    return {
      "Content-Type": "application/json",
      "Accept": "*/*",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
      "Authorization": `Bearer ${authToken}`,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "sec-ch-ua": `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="24", "Google Chrome";v="${chromeVersion}"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "X-FE-Version": "prod-fe-1.0.94",
      "Origin": "https://chat.z.ai",
      "Referer": `https://chat.z.ai/c/${chatID}`,
      "Priority": "u=1, i"
    };
  } else {
    // zread.ai平台headers
    return {
      "Content-Type": "application/json",
      "Accept": "*/*",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
      "Authorization": `Bearer ${authToken}`,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "sec-ch-ua": `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="24", "Google Chrome";v="${chromeVersion}"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "X-FE-Version": "prod-fe-1.0.94",
      "Origin": "https://zread.ai",
      "Referer": `https://zread.ai/chat/${chatID}`,
      "Priority": "u=1, i"
    };
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }

  // Authentication check
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ") || !isValidApiKey(authHeader.slice(7))) {
    return new Response(JSON.stringify({
      error: { message: "Invalid API key" }
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  if (url.pathname === "/health") {
    return new Response("OK", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  if (url.pathname === "/v1/models") {
    try {
      const modelMap = JSON.parse(Deno.env.get("MODEL_PLATFORM_MAP") || "{}");
      const modelList = Object.keys(modelMap).map(model => ({
        id: model,
        object: "model"
      }));

      return new Response(JSON.stringify({
        object: "list",
        data: modelList.length > 0 ? modelList : [{ id: "glm-4.5", object: "model" }]
      }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "glm-4.5", object: "model" }]
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  if (url.pathname === "/v1/chat/completions") {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!UPSTREAM_TOKENS) {
      return new Response(JSON.stringify({
        error: { message: "UPSTREAM_TOKENS not configured" }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    try {
      const body = await req.json();
      const model = body.model || "glm-4.5";
      const stream = body.stream !== false;

      // 解析模型路由
      const routing = resolveModelRouting(model);

      const chatId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const upstreamToken = getNextUpstreamToken();
      const headers = generateBrowserHeaders(chatId, upstreamToken, routing.platform);

      // 根据平台构建不同的请求体
      let upstreamBody: any;
      if (routing.platform === "zai") {
        // Z.ai平台格式
        upstreamBody = {
          model: routing.upstreamModel,
          messages: body.messages || [],
          stream: false,
          enable_thinking: false
        };
      } else {
        // zread.ai平台格式
        upstreamBody = {
          model: routing.upstreamModel,
          messages: body.messages || [],
          stream: false,
          variables: {
            USER_NAME: "API User",
            CURRENT_DATETIME: new Date().toISOString()
          }
        };
      }

      if (DEBUG_MODE) {
        console.log("Model routing:", model, "->", routing.platform, routing.upstreamModel);
        console.log("Calling upstream API:", routing.upstreamUrl);
      }

      const response = await fetch(routing.upstreamUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(upstreamBody)
      });

      if (!response.ok) {
        throw new Error(`Upstream API error: ${response.status}`);
      }

      const data = await response.json();

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: data.response || data.content || "No response"
          },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: body.messages?.length || 0,
          completion_tokens: data.response?.length || 0,
          total_tokens: (body.messages?.length || 0) + (data.response?.length || 0)
        }
      };

      return new Response(JSON.stringify(openaiResponse), {
        headers: { "Content-Type": "application/json" }
      });

    } catch (error) {
      if (DEBUG_MODE) {
        console.error("Chat completion error:", error);
      }

      return new Response(JSON.stringify({
        error: { message: error.message }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  return new Response("Not found", { status: 404 });
});