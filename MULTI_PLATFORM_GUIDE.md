# ZtoApi 多平台配置使用指南

## 概述

ZtoApi 现已支持多平台架构，可以在同一套服务中同时支持多个上游平台。系统会根据客户端请求的模型名称自动路由到对应的平台。

### 🎯 核心特性

- **动态平台路由**: 根据模型名称自动选择上游平台
- **统一 API 接口**: 客户端使用标准 OpenAI API 格式
- **多平台支持**: 同时支持 Z.ai 和 zread.ai 平台
- **智能回退**: 当某个平台不可用时自动回退
- **完整监控**: Dashboard 显示所有平台的请求统计

## 🏗️ 架构设计

### 请求级平台选择

系统从"进程级"平台选择升级为"请求级"平台选择：

```
客户端请求 → 模型解析 → 平台路由 → 上游API → 响应处理
    ↓           ↓         ↓         ↓         ↓
  OpenAI     模型名称    动态选择    平台特定   标准格式
  格式       glm-4.5     zread.ai   API调用   返回
```

### 支持的平台配置

| 模型名称 | 目标平台 | 上游模型ID | 平台域名 |
|---------|---------|-----------|---------|
| `GLM-4.6` | Z.ai | `0727-360B-API` | `chat.z.ai` |
| `glm-4.5` | zread.ai | `glm-4.5` | `zread.ai` |
| `claude-4-sonnet` | zread.ai | `claude-4-sonnet` | `zread.ai` |

## 🚀 快速开始

### 1. 环境配置

创建 `.env.local` 文件：

```bash
# 基础配置
PORT=9090
DEBUG_MODE=true
DEFAULT_KEY=sk-your-secret-key
DEFAULT_STREAM=true
DASHBOARD_ENABLED=true

# 多平台模型配置 (核心)
MODEL_NAME=glm-4.5
MODEL_PLATFORM_MAP={\"glm-4.5\":{\"platform\":\"zread\",\"upstream\":\"glm-4.5\"},\"claude-4-sonnet\":{\"platform\":\"zread\",\"upstream\":\"claude-4-sonnet\"},\"GLM-4.6\":{\"platform\":\"zai\",\"upstream\":\"0727-360B-API\"}}

# zread.ai 平台配置
PLATFORM_ID=zread
PROVIDER_NAME=zread.ai
PROVIDER_BRAND=zread.ai
PROVIDER_HOME_URL=https://zread.ai
ORIGIN_BASE=https://zread.ai
PLATFORM_API_BASE=https://zread.ai
UPSTREAM_URL=https://zread.ai/api/v1/talk
ZREAD_TOKEN=your-zread-token

# Z.ai 平台配置 (如果需要)
ZAI_TOKEN=your-zai-token
```

### 2. 启动服务

#### Deno 版本 (推荐)

```bash
cd deno/zai
deno task start
```

#### Go 版本

```bash
go run main.go
```

### 3. 验证配置

检查可用模型：

```bash
curl -H "Authorization: Bearer sk-your-secret-key" \
  http://localhost:9090/v1/models
```

预期返回：

```json
{
  "object": "list",
  "data": [
    {"id": "glm-4.5", "object": "model", "created": 1759726172, "owned_by": "zread"},
    {"id": "claude-4-sonnet", "object": "model", "created": 1759726172, "owned_by": "zread"},
    {"id": "GLM-4.6", "object": "model", "created": 1759726172, "owned_by": "zai"}
  ]
}
```

## 📋 详细配置说明

### 核心配置项

#### `MODEL_PLATFORM_MAP`

**最重要的配置项**，定义模型到平台的映射关系：

```json
{
  "glm-4.5": {
    "platform": "zread",        // 目标平台ID
    "upstream": "glm-4.5"       // 上游模型ID
  },
  "claude-4-sonnet": {
    "platform": "zread",
    "upstream": "claude-4-sonnet"
  },
  "GLM-4.6": {
    "platform": "zai",
    "upstream": "0727-360B-API"
  }
}
```

#### 平台特定配置

##### zread.ai 平台

```bash
# 平台识别
PLATFORM_ID=zread
PROVIDER_NAME=zread.ai
PROVIDER_BRAND=zread.ai

# 域名配置
PROVIDER_HOME_URL=https://zread.ai
ORIGIN_BASE=https://zread.ai
PLATFORM_API_BASE=https://zread.ai

# API 配置
UPSTREAM_URL=https://zread.ai/api/v1/talk
REFERER_PREFIX=/chat/
DEFAULT_UPSTREAM_MODEL_ID=glm-4.5

# 认证
UPSTREAM_TOKEN=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...
```

##### Z.ai 平台 (可选)

```bash
# 如果需要同时支持 Z.ai 平台
ZAI_TOKEN=your-zai-token
```

### 完整配置示例

```bash
# ==================== 基础配置 ====================
PORT=9090
DEBUG_MODE=true
DEFAULT_KEY=sk-your-secret-key
DEFAULT_STREAM=true
DASHBOARD_ENABLED=true
ENABLE_THINKING=false

# ==================== 多平台模型映射 ====================
MODEL_NAME=glm-4.5
MODEL_PLATFORM_MAP={\"glm-4.5\":{\"platform\":\"zread\",\"upstream\":\"glm-4.5\"},\"claude-4-sonnet\":{\"platform\":\"zread\",\"upstream\":\"claude-4-sonnet\"},\"GLM-4.6\":{\"platform\":\"zai\",\"upstream\":\"0727-360B-API\"}}

# ==================== zread.ai 平台配置 ====================
PLATFORM_ID=zread
PROVIDER_NAME=zread.ai
PROVIDER_BRAND=zread.ai
PROVIDER_HOME_URL=https://zread.ai
ORIGIN_BASE=https://zread.ai
PLATFORM_API_BASE=https://zread.ai
UPSTREAM_URL=https://zread.ai/api/v1/talk
REFERER_PREFIX=/chat/
DEFAULT_UPSTREAM_MODEL_ID=glm-4.5

# ==================== 认证配置 ====================
UPSTREAM_TOKEN=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...
DEFAULT_KEY=sk-your-secret-key

# ==================== 运行时配置 ====================
X_FE_VERSION=prod-fe-1.0.94
```

## 🔧 使用示例

### 1. 测试不同模型

#### 测试 glm-4.5 (zread.ai)

```bash
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-secret-key" \
  -d '{
    "model": "glm-4.5",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

#### 测试 claude-4-sonnet (zread.ai)

```bash
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-secret-key" \
  -d '{
    "model": "claude-4-sonnet",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

#### 测试 GLM-4.6 (Z.ai)

```bash
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-secret-key" \
  -d '{
    "model": "GLM-4.6",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

### 2. 流式响应示例

```bash
curl -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-secret-key" \
  -d '{
    "model": "glm-4.5",
    "messages": [{"role": "user", "content": "写一首诗"}],
    "stream": true
  }'
```

## 📊 监控和管理

### Dashboard 访问

访问 `http://localhost:9090/dashboard` 查看：

- **实时统计**: 各平台的请求数、成功率、响应时间
- **模型使用**: 每个模型的调用次数
- **请求日志**: 最近的请求记录
- **系统状态**: 服务运行状态

### 统计信息 API

```bash
# 获取统计数据
curl http://localhost:9090/dashboard/stats

# 获取最近请求
curl http://localhost:9090/dashboard/requests
```

## 🛠️ 高级配置

### 1. 添加新平台

要添加新平台，需要：

1. **更新模型映射**:
```bash
MODEL_PLATFORM_MAP={\"existing-models...\",\"new-model\":{\"platform\":\"new-platform\",\"upstream\":\"upstream-model-id\"}}
```

2. **配置平台参数** (如果需要特殊配置):
```bash
NEW_PLATFORM_TOKEN=your-token
NEW_PLATFORM_URL=https://api.new-platform.com
```

3. **添加平台特定逻辑** (如需要特殊的API处理)

### 2. 自定义平台选择逻辑

可以通过修改 `config.ts` 中的 `resolveModelRouting` 函数来实现自定义的路由逻辑：

```typescript
export function resolveModelRouting(requestedModel?: string): ModelResolution {
  // 自定义路由逻辑
  // 例如：基于负载均衡、用户优先级等
}
```

### 3. 令牌策略

系统支持多种令牌策略：

- **静态令牌池**: 预配置的令牌列表
- **动态获取**: 自动获取匿名令牌
- **回退机制**: 主令牌失败时自动回退

```bash
# 配置多个令牌
ZREAD_TOKENS=token1|token2|token3

# 或使用JSON格式
PLATFORM_TOKEN_MAP={\"zread\":[\"token1\",\"token2\"],\"zai\":[\"token3\"]}
```

## 🔍 故障排除

### 常见问题

#### 1. 模型列表为空

**检查配置**:
```bash
# 验证JSON格式
echo $MODEL_PLATFORM_MAP | python -m json.tool
```

**检查日志**:
```bash
# 查看启动日志中的配置解析错误
deno run --allow-net --allow-env --allow-read main.ts 2>&1 | grep -i error
```

#### 2. 特定模型无法访问

**检查令牌**:
```bash
# 测试上游API
curl -H "Authorization: Bearer $UPSTREAM_TOKEN" \
  https://zread.ai/api/v1/talk
```

**检查网络**:
```bash
# 测试连接
curl -I https://zread.ai
```

#### 3. 性能问题

**启用调试模式**:
```bash
DEBUG_MODE=true
```

**查看响应时间**:
```bash
# Dashboard 中查看平均响应时间
curl http://localhost:9090/dashboard/stats
```

### 调试技巧

1. **启用详细日志**:
```bash
DEBUG_MODE=true deno run --allow-net --allow-env --allow-read main.ts
```

2. **测试模型路由**:
```bash
# 测试模型解析
curl -H "Authorization: Bearer sk-test" \
  http://localhost:9090/v1/models
```

3. **检查配置加载**:
```bash
# 启动时查看配置解析结果
```

## 📚 API 参考

### 标准 OpenAI 兼容接口

#### GET /v1/models

返回可用模型列表：

```json
{
  "object": "list",
  "data": [
    {
      "id": "glm-4.5",
      "object": "model",
      "created": 1759726172,
      "owned_by": "zread"
    }
  ]
}
```

#### POST /v1/chat/completions

创建聊天完成请求：

```json
{
  "model": "glm-4.5",
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

### 管理接口

#### GET /dashboard/stats

获取服务统计：

```json
{
  "totalRequests": 1250,
  "successRequests": 1198,
  "failedRequests": 52,
  "averageResponseTime": 1250,
  "modelUsage": {
    "glm-4.5": 450,
    "claude-4-sonnet": 380,
    "GLM-4.6": 420
  }
}
```

#### GET /dashboard/requests

获取最近请求列表：

```json
{
  "requests": [
    {
      "timestamp": "2025-01-15T10:30:00Z",
      "method": "POST",
      "path": "/v1/chat/completions",
      "status": 200,
      "duration": 1250,
      "model": "glm-4.5",
      "platform": "zread"
    }
  ]
}
```

## 🎯 最佳实践

### 1. 配置管理

- **使用环境变量**: 不要在代码中硬编码配置
- **分离敏感信息**: 将令牌等敏感信息放在单独的环境文件中
- **版本控制**: 将 `.env.example` 纳入版本控制，但不包括 `.env.local`

### 2. 监控

- **定期检查Dashboard**: 监控各平台的性能和可用性
- **设置告警**: 当失败率超过阈值时及时通知
- **日志分析**: 定期分析请求日志，优化性能

### 3. 安全

- **令牌轮换**: 定期更新上游平台的令牌
- **访问控制**: 合理设置 `DEFAULT_KEY` 和访问限制
- **网络安全**: 在生产环境中使用HTTPS

### 4. 性能优化

- **连接池**: 启用HTTP连接复用
- **缓存策略**: 对重复请求实施缓存
- **负载均衡**: 在多个实例间分配请求

## 🆘 技术支持

如果遇到问题，请：

1. **查看日志**: 检查控制台输出的错误信息
2. **验证配置**: 确保所有环境变量正确设置
3. **测试网络**: 确认可以访问上游平台
4. **查阅文档**: 参考 GitHub 仓库的更多信息
5. **提交Issue**: 在 GitHub 上提交详细的问题报告

---

**注意**: 本指南基于 ZtoApi v2.0 多平台架构。确保您使用的是支持多平台的版本。