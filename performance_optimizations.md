# ZtoApi 性能优化建议和实施方案

## 🎯 优化目标

1. **代码结构优化** - 拆分大文件，提高可维护性
2. **并发性能提升** - 优化请求处理和资源管理
3. **内存管理改进** - 减少内存泄漏，提高资源利用率
4. **监控和诊断** - 添加性能监控和健康检查

## 🔧 已实施的优化

### 1. 配置系统优化 (已完成)
- ✅ 修复 config.ts 语法错误
- ✅ 实现自动平台检测 (Z.ai/zread.ai)
- ✅ 添加环境变量优先级管理
- ✅ 实现多平台路由配置

### 2. 安全性增强 (已完成)
- ✅ 更新 token 选择逻辑 (UPSTREAM_TOKEN 优先)
- ✅ 平台特定配置隔离
- ✅ 改进调试日志安全性

## 🚀 建议的性能优化

### 1. 代码结构优化

#### 问题
- `main.go` 文件过大 (1931行)
- 功能耦合度高，难以维护

#### 解决方案
```go
// 建议的目录结构
src/
├── config/
│   ├── config.go
│   └── platform.go
├── handlers/
│   ├── chat.go
│   ├── models.go
│   └── dashboard.go
├── middleware/
│   ├── cors.go
│   ├── auth.go
│   └── ratelimit.go
├── services/
│   ├── upstream.go
│   ├── token.go
│   └── stats.go
└── utils/
    ├── logger.go
    └── response.go
```

### 2. 连接池管理

#### 当前问题
- 每次请求创建新的 HTTP 客户端
- 没有连接复用

#### 解决方案
```go
var httpClient = &http.Client{
    Timeout: 60 * time.Second,
    Transport: &http.Transport{
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 10,
        IdleConnTimeout:     90 * time.Second,
        DisableCompression:  false,
    },
}
```

### 3. 请求限流

#### 当前问题
- 没有请求频率限制
- 可能被滥用导致资源耗尽

#### 解决方案
```go
type RateLimiter struct {
    requests chan struct{}
    ticker   *time.Ticker
}

func NewRateLimiter(rps int) *RateLimiter {
    rl := &RateLimiter{
        requests: make(chan struct{}, rps),
        ticker:   time.NewTicker(time.Second / time.Duration(rps)),
    }

    go func() {
        for range rl.ticker.C {
            select {
            case rl.requests <- struct{}{}:
            default:
            }
        }
    }()

    return rl
}
```

### 4. 内存优化

#### 当前问题
- 实时请求数组可能无限增长
- 字符串处理效率不高

#### 解决方案
```go
// 使用循环缓冲区
type CircularBuffer struct {
    buffer []LiveRequest
    head   int
    size   int
    cap    int
    mu     sync.RWMutex
}

func (cb *CircularBuffer) Add(req LiveRequest) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.buffer[cb.head] = req
    cb.head = (cb.head + 1) % cb.cap

    if cb.size < cb.cap {
        cb.size++
    }
}
```

### 5. 监控和健康检查

#### 建议添加的端点
```go
// 健康检查
func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{
        "status":    "healthy",
        "timestamp": time.Now().Format(time.RFC3339),
        "version":   "1.0.0",
    })
}

// 性能指标
func handleMetrics(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")

    var memStats runtime.MemStats
    runtime.ReadMemStats(&memStats)

    metrics := map[string]interface{}{
        "memory_alloc_mb":      memStats.Alloc / 1024 / 1024,
        "memory_total_alloc_mb": memStats.TotalAlloc / 1024 / 1024,
        "goroutines":           runtime.NumGoroutine(),
        "uptime_seconds":       time.Since(startTime).Seconds(),
        "total_requests":       stats.TotalRequests,
        "avg_response_time_ms": stats.AverageResponseTime.Milliseconds(),
    }

    json.NewEncoder(w).Encode(metrics)
}
```

## 📊 性能监控指标

### 关键指标
1. **响应时间** - 平均/最大/P95/P99
2. **吞吐量** - 每秒处理请求数
3. **错误率** - 4xx/5xx 错误比例
4. **资源使用** - CPU/内存/网络
5. **并发连接** - 活跃连接数

### 建议的工具
- **Prometheus** - 指标收集
- **Grafana** - 可视化仪表板
- **pprof** - Go 性能分析
- **内置 dashboard** - 基础监控

## 🔍 性能测试建议

### 压力测试工具
```bash
# 使用 hey 进行简单压力测试
hey -n 1000 -c 10 -H "Authorization: Bearer sk-test" \
    -d '{"model":"glm-4.5","messages":[{"role":"user","content":"test"}]}' \
    http://localhost:9090/v1/chat/completions

# 使用 wrk 进行更复杂的测试
wrk -t12 -c400 -d30s --script=script.lua http://localhost:9090
```

### 基准测试
```go
func BenchmarkHandleChatCompletions(b *testing.B) {
    for i := 0; i < b.N; i++ {
        // 模拟请求处理
    }
}
```

## 📋 实施优先级

### 高优先级 (立即实施)
1. 添加连接池管理
2. 实现基本请求限流
3. 优化内存使用 (循环缓冲区)

### 中优先级 (短期内完成)
1. 代码结构重构
2. 添加健康检查端点
3. 改进日志系统

### 低优先级 (长期计划)
1. 完整的监控系统
2. 自动扩缩容
3. 缓存机制

## 🧪 测试验证

实施优化后，建议进行以下测试：

1. **功能测试** - 确保所有功能正常
2. **性能测试** - 验证性能提升
3. **压力测试** - 测试极限情况
4. **稳定性测试** - 长时间运行测试
5. **兼容性测试** - 确保 Z.ai 和 zread.ai 都正常工作

---

这些优化将显著提高 ZtoApi 的性能、稳定性和可维护性。建议按优先级逐步实施，并在每个阶段进行充分测试。