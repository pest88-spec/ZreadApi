// 最基础的 Deno Deploy 测试文件
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    // 设置响应头
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // 处理 OPTIONS 请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // 路由处理
    if (url.pathname === '/health') {
      return new Response('OK', {
        status: 200,
        headers: { ...headers, 'Content-Type': 'text/plain' }
      });
    }

    if (url.pathname === '/v1/models') {
      const models = {
        object: 'list',
        data: [
          { id: 'glm-4.5', object: 'model' },
          { id: 'claude-4-sonnet', object: 'model' }
        ]
      };

      return new Response(JSON.stringify(models), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/v1/chat/completions') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { ...headers, 'Content-Type': 'text/plain' }
        });
      }

      try {
        const body = await request.json();
        const response = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'glm-4.5',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! This is a test response from Deno Deploy.'
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            total_tokens: 20
          }
        };

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { ...headers, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({
          error: { message: 'Invalid JSON in request body' }
        }), {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // 默认响应
    return new Response('Not Found', {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/plain' }
    });
  }
};