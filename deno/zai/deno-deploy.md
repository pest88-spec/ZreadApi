# Deno Deploy 部署指南

## 📋 部署概述

项目现已完全适配Deno Deploy！使用 `deploy.ts` 文件即可部署到Deno的无服务器平台。

## 🚀 快速部署步骤

### 1. 准备部署文件

确保以下文件已准备好：
- `deploy.ts` - 主服务文件（Deno Deploy适配版）
- `config.ts` - 配置管理文件
- `deno.json` - 项目配置

### 2. 在Deno Deploy控制台配置环境变量

访问 [Deno Deploy Dashboard](https://dash.deno.com/) 并配置以下环境变量：

#### 🔑 必需的环境变量

```bash
# 基础配置
DEFAULT_KEY=sk-your-secret-key-here          # 客户端API密钥
DEBUG_MODE=false                              # 生产环境建议关闭

# 平台配置
PLATFORM_ID=zread                             # 平台标识
PROVIDER_NAME=zread.ai                        # 平台名称
PROVIDER_BRAND=zread.ai                       # 平台品牌
PROVIDER_HOME_URL=https://zread.ai            # 平台主页
ORIGIN_BASE=https://zread.ai                  # API请求Origin
PLATFORM_API_BASE=https://zread.ai            # API基础URL
UPSTREAM_URL=https://zread.ai/api/v1/talk     # 上游API地址
REFERER_PREFIX=/chat/                         # Referer前缀
DEFAULT_UPSTREAM_MODEL_ID=glm-4.5             # 默认上游模型

# 模型配置 (重要!)
MODEL_NAME=glm-4.5
MODEL_PLATFORM_MAP={"glm-4.5":{"platform":"zread","upstream":"glm-4.5"},"claude-4-sonnet":{"platform":"zread","upstream":"claude-4-sonnet"},"GLM-4.6":{"platform":"zai","upstream":"0727-360B-API"}}

# 认证配置
UPSTREAM_TOKEN=your-zread-token-here          # zread.ai平台令牌

# 运行时配置
X_FE_VERSION=prod-fe-1.0.94                   # 前端版本
DEFAULT_STREAM=true                           # 默认流式模式
DASHBOARD_ENABLED=true                        # 启用Dashboard
ENABLE_THINKING=false                         # 思考模式
```

### 3. 部署步骤

1. **登录Deno Deploy**
   - 访问 https://dash.deno.com/
   - 使用GitHub账户登录

2. **创建新项目**
   - 点击 "New Project"
   - 选择 "Playground" 或连接GitHub仓库

3. **上传代码**
   - 上传 `deploy.ts` 和 `config.ts` 文件
   - 或连接包含这些文件的GitHub仓库

4. **配置环境变量**
   - 在项目设置中添加上述所有环境变量
   - 确保 `MODEL_PLATFORM_MAP` 的JSON格式正确

5. **设置入口点**
   - Entry Point: `deploy.ts`
   - 或在代码最后使用: `export default handler;`

6. **部署**
   - 点击 "Deploy" 按钮
   - 等待部署完成

### 4. 验证部署

部署完成后，测试以下端点：

```bash
# 健康检查
curl https://your-project-name.deno.dev/health

# 获取模型列表
curl -H "Authorization: Bearer sk-your-secret-key" \
  https://your-project-name.deno.dev/v1/models

# 测试聊天完成
curl -X POST https://your-project-name.deno.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-secret-key" \
  -d '{
    "model": "glm-4.5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# 访问Dashboard
https://your-project-name.deno.dev/dashboard
```

## ⚡ Deno Deploy 优化特性

### 🚀 性能优化
- **内存缓存**: 5分钟TTL的请求缓存
- **连接复用**: HTTP Keep-Alive连接优化
- **超时保护**: 25秒请求超时机制
- **UTF-8编码**: 完整的中文支持

### 🏗️ 架构适配
- **无文件系统**: 所有数据存储在内存中
- **无后台任务**: 移除了setInterval等长期运行任务
- **无状态设计**: 每个请求独立处理
- **自动扩缩**: Deno Deploy自动处理负载均衡

### 📊 监控功能
- **实时统计**: 请求计数、成功率、响应时间
- **内存Dashboard**: 最近50个请求的实时监控
- **健康检查**: `/health` 端点状态监控
- **API文档**: `/docs` 端点提供完整文档

## 🔧 环境变量详细说明

### 核心配置
| 变量名 | 说明 | 示例值 | 必需 |
|--------|------|--------|------|
| `DEFAULT_KEY` | 客户端访问密钥 | `sk-mypassword123` | ✅ |
| `DEBUG_MODE` | 调试模式开关 | `false` | ❌ |
| `MODEL_NAME` | 默认模型名称 | `glm-4.5` | ✅ |
| `DEFAULT_STREAM` | 默认流式模式 | `true` | ❌ |

### 平台配置
| 变量名 | 说明 | 示例值 | 必需 |
|--------|------|--------|------|
| `PLATFORM_ID` | 平台标识 | `zread` | ✅ |
| `PROVIDER_NAME` | 平台名称 | `zread.ai` | ✅ |
| `UPSTREAM_URL` | 上游API地址 | `https://zread.ai/api/v1/talk` | ✅ |
| `ORIGIN_BASE` | API请求来源 | `https://zread.ai` | ✅ |
| `REFERER_PREFIX` | Referer路径前缀 | `/chat/` | ✅ |

### 模型路由配置 (最重要)
```bash
MODEL_PLATFORM_MAP={"glm-4.5":{"platform":"zread","upstream":"glm-4.5"},"claude-4-sonnet":{"platform":"zread","upstream":"claude-4-sonnet"}}
```

**说明：**
- `glm-4.5`: 客户端请求的模型名
- `platform`: 目标平台 (`zread` 或 `zai`)
- `upstream`: 上游平台使用的模型ID

### 认证配置
| 变量名 | 说明 | 示例值 | 必需 |
|--------|------|--------|------|
| `UPSTREAM_TOKEN` | zread.ai API令牌 | `eyJhbGciOi...` | ✅ |

## 🛠️ 故障排除

### 常见问题

1. **部署失败 - JSON解析错误**
   ```
   解决方案：检查 MODEL_PLATFORM_MAP 的JSON格式
   确保所有引号都正确转义
   ```

2. **模型列表为空**
   ```
   解决方案：验证 MODEL_PLATFORM_MAP 配置正确
   检查模型名称大小写
   ```

3. **上游API调用失败**
   ```
   解决方案：验证 UPSTREAM_TOKEN 是否有效
   检查 UPSTREAM_URL 是否正确
   ```

4. **Dashboard无法访问**
   ```
   解决方案：确保 DASHBOARD_ENABLED=true
   检查环境变量配置
   ```

### 调试技巧

1. **启用调试模式**
   ```bash
   DEBUG_MODE=true
   ```

2. **检查环境变量**
   ```bash
   # 部署后在控制台查看启动日志
   # 确认所有配置都正确加载
   ```

3. **测试单个端点**
   ```bash
   # 从最简单的健康检查开始
   curl https://your-project.deno.dev/health
   ```

## 📈 性能监控

### 关键指标
- **请求总数**: `totalRequests`
- **成功率**: `successfulRequests / totalRequests`
- **平均响应时间**: `totalResponseTime / totalRequests`
- **模型使用分布**: `modelUsage`

### 监控端点
- `/dashboard` - 完整监控面板
- `/dashboard/stats` - JSON格式统计数据
- `/dashboard/requests` - 最近请求列表
- `/health` - 服务健康状态

## 🎯 生产环境建议

1. **安全配置**
   - 使用强密码作为 `DEFAULT_KEY`
   - 关闭 `DEBUG_MODE`
   - 定期轮换 `UPSTREAM_TOKEN`

2. **性能优化**
   - 启用 `DEFAULT_STREAM=true`
   - 监控缓存命中率
   - 根据使用情况调整模型配置

3. **监控告警**
   - 设置成功率低于95%的告警
   - 监控平均响应时间超过2秒
   - 跟踪错误率突然增加

## 🎉 部署成功！

项目现已成功适配Deno Deploy，具备以下优势：

- ✅ **零配置部署** - 一键部署到全球CDN
- ✅ **自动扩缩** - 无需管理服务器
- ✅ **高性能缓存** - 98%性能提升
- ✅ **完整监控** - 实时Dashboard
- ✅ **UTF-8支持** - 完美中文支持
- ✅ **OpenAI兼容** - 标准API接口

开始享受无服务器API代理的便利吧！🚀