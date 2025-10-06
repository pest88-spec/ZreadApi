// 真实的 API 代理 - 基于 main.ts 适配 Deno Deploy
const UPSTREAM_TOKEN = Deno.env.get("UPSTREAM_TOKEN") || "";
const UPSTREAM_URL = Deno.env.get("UPSTREAM_URL") || "https://zread.ai/api/v1/talk";
const DEBUG_MODE = Deno.env.get("DEBUG_MODE") === "true";

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

function generateBrowserHeaders(chatID: string, authToken: string): Record<string, string> {
  const chromeVersion = Math.floor(Math.random() * 3) + 138;
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

    if (!UPSTREAM_TOKEN) {
      return new Response(JSON.stringify({
        error: { message: "UPSTREAM_TOKEN not configured" }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    try {
      const body = await req.json();
      const model = body.model || "glm-4.5";
      const stream = body.stream !== false;

      // 解析模型映射
      let upstreamModel = model;
      try {
        const modelMap = JSON.parse(Deno.env.get("MODEL_PLATFORM_MAP") || "{}");
        if (modelMap[model]) {
          upstreamModel = modelMap[model].upstream || model;
        }
      } catch {}

      const chatId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const headers = generateBrowserHeaders(chatId, UPSTREAM_TOKEN);

      const upstreamBody = {
        model: upstreamModel,
        messages: body.messages || [],
        stream: false,
        variables: {
          USER_NAME: "API User",
          CURRENT_DATETIME: new Date().toISOString()
        }
      };

      if (DEBUG_MODE) {
        console.log("Calling upstream API:", UPSTREAM_URL);
      }

      const response = await fetch(UPSTREAM_URL, {
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