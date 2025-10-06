package adapters

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ZreadAI 适配器处理 zread.ai 特殊的两步 API 流程

type ZreadTalkRequest struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

type ZreadTalkResponse struct {
	ID    string `json:"id"`
	Model string `json:"model"`
}

type ZreadMessageRequest struct {
	Content string `json:"content"`
	Model   string `json:"model"`
	Stream  bool `json:"stream"`
}

// ZreadAdapter zread.ai API 适配器
type ZreadAdapter struct {
	client   *http.Client
	baseURL  string
	token    string
}

func NewZreadAdapter(baseURL, token string) *ZreadAdapter {
	return &ZreadAdapter{
		client:  &http.Client{},
		baseURL: strings.TrimSuffix(baseURL, "/"),
		token:   token,
	}
}

// CreateTalk 创建新的对话
func (z *ZreadAdapter) CreateTalk(model string, messages []map[string]string, stream bool) (*ZreadTalkResponse, error) {
	// 根据实际抓包数据，使用正确的请求格式
	// 从网络捕获看到Content-Length: 62，说明有固定格式的请求体
	// 可能需要repo_id或其他字段
	// 尝试不同的请求格式来达到62字节
	// 基于抓包数据分析，可能需要repo_id字段
	// 基于抓包数据分析，尝试使用固定模型名
	// 可能zread.ai需要特定的模型名称格式
	reqData := map[string]interface{}{
		"model": "gpt-4o-mini", // 尝试使用抓包中可能看到的模型名
	}

	jsonData, err := json.Marshal(reqData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal talk request: %w", err)
	}

	// 调试：打印发送的数据
	fmt.Printf("[DEBUG] 发送到 zread.ai 的创建对话数据: %s\n", string(jsonData))

	// 创建 HTTP 请求
	req, err := http.NewRequest("POST", z.baseURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create talk request: %w", err)
	}

	// 设置请求头
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+z.token)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
	req.Header.Set("Origin", "https://zread.ai")
	req.Header.Set("Referer", "https://zread.ai/openai/codex")

	// 发送请求
	resp, err := z.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send talk request: %w", err)
	}
	defer resp.Body.Close()

	// 读取响应
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read talk response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("talk request failed with status %d: %s", resp.StatusCode, string(body))
	}

	// 解析响应
	var talkResp ZreadTalkResponse
	if err := json.Unmarshal(body, &talkResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal talk response: %w", err)
	}

	return &talkResp, nil
}

// SendMessage 发送消息到已创建的对话
func (z *ZreadAdapter) SendMessage(talkID, content, model string, stream bool) (io.ReadCloser, error) {
	// 构建请求数据
	reqData := ZreadMessageRequest{
		Content: content,
		Model:   model,
		Stream:  stream,
	}

	jsonData, err := json.Marshal(reqData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal message request: %w", err)
	}

	// 创建 HTTP 请求
	url := fmt.Sprintf("%s/%s/message", z.baseURL, talkID)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create message request: %w", err)
	}

	// 设置请求头
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+z.token)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
	req.Header.Set("Origin", "https://zread.ai")
	req.Header.Set("Referer", "https://zread.ai/openai/codex")

	if stream {
		req.Header.Set("Accept", "text/event-stream")
	}

	// 发送请求
	resp, err := z.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send message request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("message request failed with status %d: %s", resp.StatusCode, string(body))
	}

	return resp.Body, nil
}

// ChatCompletion 完整的聊天完成流程
func (z *ZreadAdapter) ChatCompletion(model string, messages []map[string]string, stream bool) (io.ReadCloser, error) {
	// 第一步：创建对话
	talkResp, err := z.CreateTalk(model, messages, false) // 创建对话时不使用流式
	if err != nil {
		return nil, fmt.Errorf("failed to create talk: %w", err)
	}

	// 获取最后一条用户消息
	var lastMessage string
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i]["role"] == "user" {
			lastMessage = messages[i]["content"]
			break
		}
	}

	if lastMessage == "" {
		return nil, fmt.Errorf("no user message found")
	}

	// 第二步：发送消息
	return z.SendMessage(talkResp.ID, lastMessage, model, stream)
}