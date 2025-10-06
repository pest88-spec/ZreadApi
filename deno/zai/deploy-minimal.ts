// 极简版本 - 用于测试Deno Deploy
export default {
  async fetch() {
    return new Response("Hello from Deno Deploy!", {
      headers: { "content-type": "text/plain" },
    });
  },
};