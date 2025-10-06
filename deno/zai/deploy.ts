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

  if (url.pathname === "/health") {
    return new Response("OK", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  if (url.pathname === "/v1/models") {
    return new Response(JSON.stringify({
      object: "list",
      data: [{ id: "glm-4.5", object: "model" }]
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url.pathname === "/v1/chat/completions") {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response(JSON.stringify({
      id: "test",
      object: "chat.completion",
      created: Date.now(),
      model: "glm-4.5",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Test response" },
        finish_reason: "stop"
      }]
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("Not found", { status: 404 });
});