// Basic OpenAI-compatible API proxy for zread.ai
// Minimal version for Deno Deploy compatibility

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }

  // Health check
  if (path === "/health") {
    return new Response(JSON.stringify({
      status: "healthy",
      timestamp: new Date().toISOString()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Models
  if (path === "/v1/models") {
    return new Response(JSON.stringify({
      object: "list",
      data: [{
        id: "glm-4.5",
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
    const authHeader = request.headers.get("Authorization");
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
    const defaultKey = Deno.env.get("DEFAULT_KEY") || "sk-your-key";
    if (token !== defaultKey) {
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

    try {
      const body = await request.json();
      const stream = body.stream || false;

      // Mock response for now
      const response = {
        id: "chatcmpl-" + Math.random().toString(36).substr(2, 9),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "glm-4.5",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! This is a test response from the deployed API."
          },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25
        }
      };

      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });

    } catch (error) {
      return new Response(JSON.stringify({
        error: {
          message: "Internal server error",
          type: "api_error"
        }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}

console.log("🚀 ZtoApi (Minimal) starting...");

export default handleRequest;