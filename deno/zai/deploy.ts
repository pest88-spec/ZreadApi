// Deno Deploy version of ZtoApi - Simplified version
// Basic OpenAI-compatible API proxy for zread.ai

// Configuration
const DEFAULT_KEY = Deno.env.get("DEFAULT_KEY") || "sk-your-key";
const MODEL_NAME = Deno.env.get("MODEL_NAME") || "glm-4.5";
const DEBUG_MODE = Deno.env.get("DEBUG_MODE") === "true";
const UPSTREAM_TOKEN = Deno.env.get("UPSTREAM_TOKEN") || "";
const X_FE_VERSION = Deno.env.get("X_FE_VERSION") || "prod-fe-1.0.94";
const UPSTREAM_URL = Deno.env.get("UPSTREAM_URL") || "https://zread.ai/api/v1/talk";
const ORIGIN_BASE = Deno.env.get("ORIGIN_BASE") || "https://zread.ai";

// Simple stats
let totalRequests = 0;
let successfulRequests = 0;

// Debug logging
function debugLog(...args: any[]) {
  if (DEBUG_MODE) {
    console.log("[DEBUG]", ...args);
  }
}

// Handle zread.ai non-streaming response
async function handleZreadNonStreamResponse(response: Response): Promise<any> {
  const responseText = await response.text();
  debugLog("Zread response:", responseText.substring(0, 200));

  // Parse SSE format from zread.ai
  const lines = responseText.split('\n');
  let content = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('event:answer')) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && nextLine.startsWith('data:')) {
        try {
          const jsonData = nextLine.substring(5);
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
              const nextLine = lines[i + 1]?.trim();
              if (nextLine && nextLine.startsWith('data:')) {
                try {
                  const jsonData = nextLine.substring(5);
                  const parsed = JSON.parse(jsonData);

                  if (parsed.text) {
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

// Handle chat completion
async function handleChatCompletion(req: Request): Promise<Response> {
  totalRequests++;

  try {
    const body = await req.json();
    const model = body.model || MODEL_NAME;
    const stream = body.stream || false;

    debugLog("Chat completion request:", { model, stream });

    const messageRequest = {
      model: model,
      messages: body.messages,
      stream: false,
      temperature: body.temperature || 0.7,
      max_tokens: body.max_tokens || 2000,
      variables: {
        "USER_NAME": "API User",
        "CURRENT_DATETIME": new Date().toISOString()
      }
    };

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${UPSTREAM_TOKEN}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Origin": ORIGIN_BASE,
      "Referer": ORIGIN_BASE + "/chat/",
      "X-FE-Version": X_FE_VERSION
    };

    const messageUrl = `${UPSTREAM_URL}/31064d72-a25c-11f0-901e-1a109de107af/message`;

    const response = await fetch(messageUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(messageRequest)
    });

    if (!response.ok) {
      const errorText = await response.text();
      debugLog("Upstream error:", errorText);
      throw new Error(`Upstream error: ${response.status}`);
    }

    successfulRequests++;

    if (stream) {
      return await handleZreadStreamResponse(response);
    } else {
      const result = await handleZreadNonStreamResponse(response);
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

    const errorResponse = {
      error: {
        message: error instanceof Error ? error.message : "Unknown error",
        type: "upstream_error",
        code: "processing_failed"
      }
    };

    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// Main handler
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  debugLog("Request:", req.method, path);

  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      },
    });
  }

  // Health check
  if (path === "/health") {
    return new Response(JSON.stringify({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "2.0.0-deno-deploy-simple"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Models
  if (path === "/v1/models") {
    return new Response(JSON.stringify({
      object: "list",
      data: [{
        id: MODEL_NAME,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "zread"
      }]
    }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // Chat completions
  if (path === "/v1/chat/completions") {
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

    return await handleChatCompletion(req);
  }

  return new Response("Not Found", { status: 404 });
}

console.log("🚀 ZtoApi (Deno Deploy Simple) starting...");
console.log(`📦 Model: ${MODEL_NAME}`);
console.log(`🌐 Upstream: ${UPSTREAM_URL}`);
console.log(`🔑 Token configured: ${UPSTREAM_TOKEN ? "Yes" : "No"}`);

export default handler;