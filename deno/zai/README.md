# OpenAI 兼容 API 代理（Deno 版）

这是一套运行于 Deno 的 OpenAI 兼容代理，默认对接 Z.ai 的 GLM 系列模型，同时通过环境变量即可无缝切换到 zread.ai（GLM‑4.5 / Claude 4 Sonnet 等）。项目能够将 OpenAI 风格的 `chat/completions` 请求转发到上游服务，自动处理身份认证、SSE 流式输出、思维链内容清洗以及仪表盘监控。

> 如果你只需要快速上手：仔细阅读“4. 配置环境”和“5. 启动与验证”两个章节即可。

---

## 1. 功能概览

- 🔄 **OpenAI API 兼容**：`/v1/models`、`/v1/chat/completions` 等端口与官方格式一致。
- 🌊 **流式 & 非流式**：使用 Server-Sent Events 在终端或浏览器实时展示回复。
- 🔐 **多令牌策略**：支持显式 `UPSTREAM_TOKEN`、KV 池、多 Token 轮换以及匿名 Token。
- 🧠 **思维链处理**：可配置 `THINK_TAGS_MODE`，对上游返回的 `<details>` / `<summary>` 内容做清洗或保留。
- 📈 **内置仪表盘**：`/dashboard` 提供请求统计、趋势及最近调用列表。
- ⚙️ **模型映射**：通过 `UPSTREAM_MODEL_ID_MAP` 自定义“公开模型名”与“上游真实模型 ID”的对应关系。

---

## 2. 环境要求

| 组件                         | 说明                                                        | 验证方式                      |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------- |
| Deno ≥ 2.5                   | 代理运行环境，需启用 `--allow-net --allow-env --allow-read` | `deno --version`              |
| Git                          | 拉取/更新代码                                               | `git --version`               |
| curl / HTTPie（可选）        | 快速验证 API                                                | `curl --version`              |
| Z.ai / zread.ai 账号（可选） | 如需固定 Token，可从浏览器开发者工具复制                    | 登录后查看 `Authorization` 头 |

> Windows 用户建议使用 PowerShell 7+；macOS / Linux 推荐使用 zsh 或 bash。

安装 Deno：

```bash
# macOS / Linux
curl -fsSL https://deno.land/install.sh | sh

# Windows (PowerShell)
irm https://deno.land/install.ps1 | iex
```

---

## 3. 获取代码

```bash
# 克隆仓库
git clone https://github.com/pest88-spec/ZreadApi.git
cd ZreadApi
```

> 如需长期使用，建议 Fork 后再克隆到本地，便于维护自定义配置。以下命令默认在仓库根目录执行。

---

## 4. 配置环境（.env.local）

进入 Deno 子目录并复制环境变量模板：

```bash
cd deno/zai

# macOS / Linux
cp .env.example .env.local

# Windows (PowerShell)
Copy-Item .env.example .env.local
```

`.env.local` 与 `main.ts` 位于同一目录，启动命令会通过 `--env-file=.env.local` 自动加载。如果希望把配置放在仓库根目录，可以执行：

```bash
cp .env.example ../../.env.local                    # macOS / Linux
Copy-Item .env.example ..\..\.env.local             # Windows
```

此时运行命令需把参数改为 `--env-file=../.env.local`。

常用变量说明：

| 变量                        | 作用                                   | 示例                                                        |
| --------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `PLATFORM_ID`               | 平台标识，建议 `zai` / `zread`         | `zread`                                                     |
| `PROVIDER_HOME_URL`         | 浏览器访问域名                         | `https://zread.ai`                                          |
| `REGISTER_SSO_REDIRECT`     | 登录完成后的跳转地址                   | `https://zread.ai/`                                         |
| `PLATFORM_API_BASE`         | 实际发送请求的 API 域                  | `https://zread.ai`                                          |
| `DEFAULT_KEY`               | 代理自身的 API Key（客户端调用时使用） | `sk-local-dev`                                              |
| `UPSTREAM_TOKEN`            | 上游 Bearer Token（可选）              | `eyJhbGci...`                                               |
| `UPSTREAM_MODEL_ID_DEFAULT` | 未显式映射时的上游模型 ID              | `0727-360B-API`                                             |
| `UPSTREAM_MODEL_ID_MAP`     | JSON 字符串，公开模型与上游 ID 的映射  | `{"glm-4.5":"glm-4.5","claude-4-sonnet":"claude-4-sonnet"}` |

### 4.1 Z.ai 默认配置示例

```env
PLATFORM_ID=zai
PROVIDER_HOME_URL=https://chat.z.ai
REGISTER_SSO_REDIRECT=https://chat.z.ai/
PLATFORM_API_BASE=https://chat.z.ai
MODEL_NAME=GLM-4.6
UPSTREAM_MODEL_ID_DEFAULT=0727-360B-API
UPSTREAM_MODEL_ID_MAP='{"GLM-4.6":"0727-360B-API"}'
DEFAULT_KEY=sk-your-key
UPSTREAM_TOKEN=
```

### 4.2 zread.ai 配置示例

```env
PLATFORM_ID=zread
PROVIDER_HOME_URL=https://zread.ai
REGISTER_SSO_REDIRECT=https://zread.ai/
PLATFORM_API_BASE=https://zread.ai
MODEL_NAME=glm-4.5
UPSTREAM_MODEL_ID_DEFAULT=glm-4.5
UPSTREAM_MODEL_ID_MAP='{"glm-4.5":"glm-4.5","claude-4-sonnet":"claude-4-sonnet"}'
DEFAULT_KEY=sk-your-key
UPSTREAM_TOKEN=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...
```

`.env.local` 用于保存个人/环境敏感配置，请勿提交到版本库。

---

## 5. 启动与验证

以下命令默认在 `deno/zai` 目录执行。

### 5.1 使用 Deno 任务

```bash
# macOS / Linux
deno task start --env-file=.env.local

# Windows (PowerShell)
deno task start --env-file=.env.local
```

开发模式（文件变动自动重启）：

```bash
deno task dev --env-file=.env.local
```

> 若 `.env.local` 位于仓库根目录，请将参数改为 `--env-file=../.env.local`。

### 5.2 手动运行（可选）

```bash
deno run --allow-net --allow-env --allow-read --env-file=.env.local main.ts
```

### 5.3 验证接口

1. 列出模型：
   ```bash
   curl http://localhost:9090/v1/models
   ```
2. 非流式聊天：
   ```bash
   curl -X POST http://localhost:9090/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer sk-your-key" \
     -d '{
       "model": "glm-4.5",
       "messages": [{"role": "user", "content": "你好，介绍一下项目"}],
       "stream": false
     }'
   ```
3. 流式聊天：
   ```bash
   curl -N -X POST http://localhost:9090/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer sk-your-key" \
     -d '{
       "model": "claude-4-sonnet",
       "messages": [{"role": "user", "content": "用中文写一首七言绝句"}],
       "stream": true
     }'
   ```
4. 浏览器打开：
   - `http://localhost:9090/docs` 查看 API 文档
   - `http://localhost:9090/dashboard` 查看运行监控

---

## 6. 模型映射与多模型支持

代理公开的模型名称默认取自 `MODEL_NAME`。当请求指明 `model` 字段时，程序会根据 `UPSTREAM_MODEL_ID_MAP` 将其转换为上游真实模型 ID：

- 键（Key）为客户端可见的模型名称，可保留大小写与空格；
- 值（Value）为上游 `talk` 或 `chat/completions` 需要的真实 ID；
- 若未命中映射，则回落到 `UPSTREAM_MODEL_ID_DEFAULT`；
- `/v1/models` 失败时会返回 `MODEL_NAME` 与映射表中的所有键，便于客户端发现可用模型。

示例：

```env
UPSTREAM_MODEL_ID_MAP='{
  "glm-4.5": "glm-4.5",
  "claude-4-sonnet": "claude-4-sonnet",
  "glm-4.6": "0727-360B-API"
}'
```

---

## 7. `.env.local` 常见问题

1. **文件未生效**：启动时务必附带 `--env-file=.env.local`；若仍失败，请确认文件位于正确目录且无 BOM。
2. **值包含特殊字符**：如 JSON 字符串、带空格的 Token，请使用单引号包裹或转义内部引号。
3. **Windows PowerShell**：使用单引号时无需转义双引号，例如 `'{"key":"value"}'`。

---

## 8. 常见故障排查

| 症状                    | 可能原因                                           | 处理建议                                                                       |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| 401 `Invalid API key`   | 客户端未携带 `Authorization: Bearer <DEFAULT_KEY>` | 确认 `.env.local` 中的 `DEFAULT_KEY` 并在请求头中使用                          |
| 503 `token_unavailable` | 未配置 `UPSTREAM_TOKEN` 且匿名 Token 获取失败      | 登录上游获取最新 Token 或检查网络代理                                          |
| 426 / Cloudflare 挑战   | 浏览器指纹或 Cookie 失效                           | 更新 `UPSTREAM_TOKEN`，同时刷新 `cf_clearance` 等 Cookie                       |
| `/v1/models` 返回为空   | 映射表错误或上游接口变动                           | 检查 `UPSTREAM_MODEL_ID_MAP` 是否为合法 JSON，并抓包确认新的模型 ID            |
| Dashboard 无数据        | 未触发请求或 KV 权限不足                           | 访问 `/v1/chat/completions` 后刷新 dashboard；若在 Deno Deploy，需启用 KV 权限 |

更多日志可在启动终端查看；`DEBUG_MODE=false` 可减少输出。

---

## 9. 进阶主题

- **KV Token 池**：若部署了批量注册器，可将 tokens 存入 Deno KV，代理会自动从 KV 中轮换使用。
- **思维链模式**：通过 `THINK_TAGS_MODE=think` 可把 `<details>` 转换为 `<think>` 标签；`raw` 则完全保留。
- **Docker 部署**：`Dockerfile.deno` 适用于 Deno 镜像，构建后同样通过环境变量完成配置。
- **与 Go 版本对比**：根目录的 `main.go` 提供了 CLI 版本实现，功能类似但构建方式不同，可按需选用。

---

## 10. API 使用范例

### 10.1 Python (openai 官方 SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-key",
    base_url="http://localhost:9090/v1"
)

resp = client.chat.completions.create(
    model="glm-4.5",
    messages=[{"role": "user", "content": "简单介绍一下你自己"}]
)
print(resp.choices[0].message.content)
```

### 10.2 Shell (curl)

```bash
curl -N -X POST http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "claude-4-sonnet",
    "messages": [{"role": "user", "content": "写一段 100 字的产品介绍"}],
    "stream": true
  }'
```

---

## 11. 贡献与许可

- 欢迎通过 Issue / PR 提交改进建议或补丁，建议附带测试步骤。
- 项目采用 [MIT License](../../LICENSE)。

如需协助，可在仓库提 Issue，或附上 `deno` / `curl` 的完整输出，便于定位问题。
