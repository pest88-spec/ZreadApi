package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// SimpleClient 最简化的HTTP客户端
type SimpleClient struct {
	httpClient *http.Client
	authToken  string
}

// NewSimpleClient 创建简单客户端
func NewSimpleClient(authToken string) *SimpleClient {
	return &SimpleClient{
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
		authToken: authToken,
	}
}

// SendSimpleRequest 发送最简化的请求（无URL参数、无签名）
func (sc *SimpleClient) SendSimpleRequest(messages []Message, stream bool) (*http.Response, error) {
	// 构建最简单的请求体
	chatID := fmt.Sprintf("%d", time.Now().UnixNano())

	upstreamReq := UpstreamRequest{
		Stream:   stream,
		ChatID:   chatID,
		Model:    getUpstreamModelID(MODEL_NAME),
		Messages: messages,
		Params:   map[string]interface{}{},
		Features: map[string]interface{}{
			"enable_thinking": false,
		},
	}

	reqBody, err := json.Marshal(upstreamReq)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %v", err)
	}

	debugLog("发送简化请求到: %s", UPSTREAM_URL)
	debugLog("请求体: %s", string(reqBody))

	// 创建HTTP请求 - 不带任何URL参数
	req, err := http.NewRequest("POST", UPSTREAM_URL, bytes.NewBuffer(reqBody))
	if err != nil {
		return nil, fmt.Errorf("创建请求失败: %v", err)
	}

	// 只设置最基本的headers
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("User-Agent", BROWSER_UA)
	req.Header.Set("Origin", ORIGIN_BASE)
	req.Header.Set("Referer", ORIGIN_BASE+"/")

	// 如果有token，添加Authorization
	if sc.authToken != "" {
		req.Header.Set("Authorization", "Bearer "+sc.authToken)
		debugLog("使用token: %s...", sc.authToken[:min(20, len(sc.authToken))])
	} else {
		debugLog("警告：没有token")
	}

	resp, err := sc.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求失败: %v", err)
	}

	debugLog("响应状态: %d %s", resp.StatusCode, resp.Status)

	// 如果响应不是200，读取错误信息
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		debugLog("错误响应体: %s", string(body))
		return nil, fmt.Errorf("服务器返回错误: %d - %s", resp.StatusCode, string(body))
	}

	return resp, nil
}
