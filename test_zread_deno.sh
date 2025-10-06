#!/bin/bash

# ZtoApi Deno 版本 zread.ai 测试脚本
API_BASE="http://localhost:9090/v1"
API_KEY="sk-test-key"

echo "🚀 测试 ZtoApi Deno 版本 zread.ai 支持情况"
echo "========================================"

# 测试服务状态
echo "1. 检查服务状态..."
if curl -s "$API_BASE/models" > /dev/null; then
    echo "✅ 服务运行正常"
else
    echo "❌ 服务未启动，请先启动服务"
    echo "启动命令: cd deno/zai && deno task start"
    exit 1
fi

echo ""
echo "2. 获取可用模型列表..."
curl -s -H "Authorization: Bearer $API_KEY" "$API_BASE/models" | jq .

echo ""
echo "3. 测试 glm-4.5 非流式请求..."
curl -s -X POST "$API_BASE/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d '{
        "model": "glm-4.5",
        "messages": [
            {"role": "user", "content": "你好，请简单介绍一下你自己"}
        ],
        "stream": false
    }' | jq . | head -20

echo ""
echo "4. 测试 glm-4.5 流式请求..."
curl -s -X POST "$API_BASE/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d '{
        "model": "glm-4.5",
        "messages": [
            {"role": "user", "content": "请写一首关于春天的短诗"}
        ],
        "stream": true
    }' | while IFS= read -r line; do
    if [[ $line == data:* ]]; then
        data="${line#data: }"
        if [[ "$data" == "[DONE]" ]]; then
            echo ""
            break
        else
            echo "$data" | jq -r '.choices[0].delta.content // empty' | tr -d '\n'
        fi
    fi
done

echo ""
echo "5. 测试 Dashboard..."
if curl -s "http://localhost:9090/dashboard/stats" > /dev/null; then
    echo "✅ Dashboard 运行正常: http://localhost:9090/dashboard"
else
    echo "❌ Dashboard 未启用"
fi

echo ""
echo "🎉 Deno 版本测试完成！"