// 完整功能的 Deno Deploy 版本
interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  modelUsage: Record<string, number>;
  lastReset: number;
}

interface LiveRequest {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  status: number;
  responseTime: number;
  model?: string;
  tokens?: number;
  error?: string;
}

// 内存中的统计数据
let stats: RequestStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  averageResponseTime: 0,
  modelUsage: {},
  lastReset: Date.now()
};

let recentRequests: LiveRequest[] = [];
const MAX_RECENT_REQUESTS = 50;

// 配置从环境变量获取
const DEFAULT_KEY = Deno.env.get("DEFAULT_KEY") || "sk-your-key";
const DEBUG_MODE = Deno.env.get("DEBUG_MODE") === "true";
const MODEL_PLATFORM_MAP = Deno.env.get("MODEL_PLATFORM_MAP") || "{}";
const PLATFORM_ID = Deno.env.get("PLATFORM_ID") || "zread";
const UPSTREAM_TOKEN = Deno.env.get("UPSTREAM_TOKEN") || "";
const UPSTREAM_URL = Deno.env.get("UPSTREAM_URL") || "https://zread.ai/api/v1/talk";
const DEFAULT_STREAM = Deno.env.get("DEFAULT_STREAM") === "true";

function updateStats(request: Partial<LiveRequest>) {
  stats.totalRequests++;

  if (request.status && request.status >= 200 && request.status < 400) {
    stats.successfulRequests++;
  } else {
    stats.failedRequests++;
  }

  if (request.responseTime) {
    stats.averageResponseTime =
      (stats.averageResponseTime * (stats.totalRequests - 1) + request.responseTime) /
      stats.totalRequests;
  }

  if (request.model) {
    stats.modelUsage[request.model] = (stats.modelUsage[request.model] || 0) + 1;
  }
}

function addRecentRequest(request: LiveRequest) {
  recentRequests.unshift(request);
  if (recentRequests.length > MAX_RECENT_REQUESTS) {
    recentRequests = recentRequests.slice(0, MAX_RECENT_REQUESTS);
  }
}

function parseModelMap(): Record<string, {platform: string, upstream: string}> {
  try {
    return JSON.parse(MODEL_PLATFORM_MAP);
  } catch {
    return {};
  }
}

async function handleChatCompletion(request: Request): Promise<Response> {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const body = await request.json();
    const model = body.model || "glm-4.5";
    const stream = body.stream !== false && DEFAULT_STREAM;

    const modelMap = parseModelMap();
    const modelConfig = modelMap[model];

    if (!modelConfig) {
      throw new Error(`Unsupported model: ${model}`);
    }

    // 构建上游请求
    const upstreamRequest = {
      model: modelConfig.upstream,
      messages: body.messages || [],
      stream: false, // 先用非流式
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      variables: {
        USER_NAME: "API User",
        CURRENT_DATETIME: new Date().toISOString()
      }
    };

    // 调用上游API
    const response = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${UPSTREAM_TOKEN}`,
        "Origin": "https://zread.ai",
        "Referer": `https://zread.ai/chat/`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: JSON.stringify(upstreamRequest)
    });

    if (!response.ok) {
      throw new Error(`Upstream API error: ${response.status}`);
    }

    const data = await response.json();

    // 转换为OpenAI格式
    const openaiResponse = {
      id: `chatcmpl_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: data.response || "No response"
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: body.messages?.length || 0,
        completion_tokens: data.response?.length || 0,
        total_tokens: (body.messages?.length || 0) + (data.response?.length || 0)
      }
    };

    // 更新统计
    const responseTime = Date.now() - startTime;
    updateStats({
      status: 200,
      responseTime,
      model,
      tokens: openaiResponse.usage.total_tokens
    });

    addRecentRequest({
      id: requestId,
      timestamp: Date.now(),
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      responseTime,
      model,
      tokens: openaiResponse.usage.total_tokens
    });

    return new Response(JSON.stringify(openaiResponse), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    updateStats({
      status: 500,
      responseTime,
      error: error.message
    });

    addRecentRequest({
      id: requestId,
      timestamp: Date.now(),
      method: "POST",
      path: "/v1/chat/completions",
      status: 500,
      responseTime,
      error: error.message
    });

    if (DEBUG_MODE) {
      console.error("Chat completion error:", error);
    }

    return new Response(JSON.stringify({
      error: {
        message: error.message,
        type: "api_error",
        code: "internal_error"
      }
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Authentication check
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== DEFAULT_KEY) {
      return new Response(JSON.stringify({
        error: { message: "Invalid API key" }
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    // Routes
    if (url.pathname === "/health") {
      return new Response("OK", {
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url.pathname === "/v1/models") {
      const modelMap = parseModelMap();
      const models = Object.keys(modelMap).map(model => ({
        id: model,
        object: "model"
      }));

      return new Response(JSON.stringify({
        object: "list",
        data: models
      }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    if (url.pathname === "/v1/chat/completions") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: corsHeaders
        });
      }

      return await handleChatCompletion(request);
    }

    // Dashboard endpoints
    if (url.pathname === "/dashboard/stats") {
      return new Response(JSON.stringify(stats), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    if (url.pathname === "/dashboard/requests") {
      return new Response(JSON.stringify(recentRequests), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    if (url.pathname === "/dashboard") {
      const html = `
<!DOCTYPE html>
<html>
<head>
    <title>ZtoApi Dashboard</title>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .stat-card { background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; }
        .stat-value { font-size: 2em; font-weight: bold; color: #333; }
        .stat-label { color: #666; margin-top: 5px; }
        .requests { margin-top: 30px; }
        .request-item { background: #f9f9f9; padding: 10px; margin: 5px 0; border-left: 4px solid #ddd; }
        .request-success { border-left-color: #4CAF50; }
        .request-error { border-left-color: #f44336; }
    </style>
</head>
<body>
    <h1>ZtoApi Dashboard</h1>
    <div class="stats">
        <div class="stat-card">
            <div class="stat-value" id="totalRequests">${stats.totalRequests}</div>
            <div class="stat-label">Total Requests</div>
        </div>
        <div class="stat-card">
            <div class="stat-value" id="successRate">${stats.totalRequests > 0 ? Math.round(stats.successfulRequests / stats.totalRequests * 100) : 0}%</div>
            <div class="stat-label">Success Rate</div>
        </div>
        <div class="stat-card">
            <div class="stat-value" id="avgResponseTime">${Math.round(stats.averageResponseTime)}ms</div>
            <div class="stat-label">Avg Response Time</div>
        </div>
    </div>

    <div class="requests">
        <h2>Recent Requests</h2>
        <div id="requestsList"></div>
    </div>

    <script>
        async function updateDashboard() {
            try {
                const [statsResponse, requestsResponse] = await Promise.all([
                    fetch('/dashboard/stats'),
                    fetch('/dashboard/requests')
                ]);

                const stats = await statsResponse.json();
                const requests = await requestsResponse.json();

                document.getElementById('totalRequests').textContent = stats.totalRequests;
                document.getElementById('successRate').textContent =
                    stats.totalRequests > 0 ? Math.round(stats.successfulRequests / stats.totalRequests * 100) : 0 + '%';
                document.getElementById('avgResponseTime').textContent = Math.round(stats.averageResponseTime) + 'ms';

                const requestsList = document.getElementById('requestsList');
                requestsList.innerHTML = requests.map(req =>
                    \`<div class="request-item \${req.status >= 200 && req.status < 400 ? 'request-success' : 'request-error'}">
                        <strong>\${req.method} \${req.path}</strong> - \${req.status} (\${req.responseTime}ms)
                        \${req.model ? \` - Model: \${req.model}\` : ''}
                        \${req.error ? \`<br><span style="color: red;">Error: \${req.error}</span>\` : ''}
                    </div>\`
                ).join('');
            } catch (error) {
                console.error('Dashboard update error:', error);
            }
        }

        updateDashboard();
        setInterval(updateDashboard, 5000); // 每5秒刷新
    </script>
</body>
</html>`;

      return new Response(html, {
        headers: {
          "Content-Type": "text/html",
          ...corsHeaders
        }
      });
    }

    return new Response("Not found", {
      status: 404,
      headers: corsHeaders
    });
  }
};