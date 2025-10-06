package utils

import (
	"net"
	"net/http"
	"time"
)

// HTTPClient 封装的 HTTP 客户端，支持连接池
type HTTPClient struct {
	client *http.Client
}

// NewHTTPClient 创建新的 HTTP 客户端实例
func NewHTTPClient(timeout time.Duration) *HTTPClient {
	return &HTTPClient{
		client: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				// 连接池配置
				MaxIdleConns:        100,              // 最大空闲连接数
				MaxIdleConnsPerHost: 10,               // 每个主机最大空闲连接数
				MaxConnsPerHost:     50,               // 每个主机最大连接数
				IdleConnTimeout:     90 * time.Second, // 空闲连接超时时间

				// DNS 缓存
				DialContext: (&net.Dialer{
					Timeout:   30 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,

				// TLS 配置
				TLSHandshakeTimeout:   10 * time.Second,
				ResponseHeaderTimeout: 30 * time.Second,
				ExpectContinueTimeout: 1 * time.Second,

				// 禁用压缩（如果需要）
				DisableCompression: false,
			},
		},
	}
}

// GetClient 返回底层的 http.Client
func (c *HTTPClient) GetClient() *http.Client {
	return c.client
}

// SetTimeout 设置超时时间
func (c *HTTPClient) SetTimeout(timeout time.Duration) {
	c.client.Timeout = timeout
}

// CloseIdleConnections 关闭空闲连接
func (c *HTTPClient) CloseIdleConnections() {
	if transport, ok := c.client.Transport.(*http.Transport); ok {
		transport.CloseIdleConnections()
	}
}

// 全局 HTTP 客户端实例
var (
	// DefaultClient 默认客户端，用于一般请求
	DefaultClient = NewHTTPClient(60 * time.Second)

	// AuthClient 认证专用客户端，较短超时
	AuthClient = NewHTTPClient(10 * time.Second)
)