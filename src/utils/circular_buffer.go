package utils

import (
	"sync"
	"time"
)

// CircularBuffer 循环缓冲区，用于存储实时请求数据
type CircularBuffer struct {
	buffer []interface{}
	head   int
	size   int
	cap    int
	mu     sync.RWMutex
}

// NewCircularBuffer 创建新的循环缓冲区
func NewCircularBuffer(capacity int) *CircularBuffer {
	return &CircularBuffer{
		buffer: make([]interface{}, capacity),
		cap:    capacity,
	}
}

// Add 添加元素到缓冲区
func (cb *CircularBuffer) Add(item interface{}) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.buffer[cb.head] = item
	cb.head = (cb.head + 1) % cb.cap

	if cb.size < cb.cap {
		cb.size++
	}
}

// GetAll 获取缓冲区中的所有元素（按插入顺序）
func (cb *CircularBuffer) GetAll() []interface{} {
	cb.mu.RLock()
	defer cb.mu.RUnlock()

	if cb.size == 0 {
		return nil
	}

	result := make([]interface{}, cb.size)
	for i := 0; i < cb.size; i++ {
		// 计算实际索引
		idx := (cb.head - cb.size + i + cb.cap) % cb.cap
		result[i] = cb.buffer[idx]
	}

	return result
}

// GetLatest 获取最新的 n 个元素
func (cb *CircularBuffer) GetLatest(n int) []interface{} {
	cb.mu.RLock()
	defer cb.mu.RUnlock()

	if cb.size == 0 {
		return nil
	}

	if n >= cb.size {
		n = cb.size
	}

	result := make([]interface{}, n)
	for i := 0; i < n; i++ {
		// 计算实际索引（从最新的开始）
		idx := (cb.head - n + i + cb.cap) % cb.cap
		result[i] = cb.buffer[idx]
	}

	return result
}

// Size 获取当前元素数量
func (cb *CircularBuffer) Size() int {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.size
}

// Capacity 获取缓冲区容量
func (cb *CircularBuffer) Capacity() int {
	return cb.cap
}

// Clear 清空缓冲区
func (cb *CircularBuffer) Clear() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.head = 0
	cb.size = 0
	// 可选：清空底层切片
	for i := range cb.buffer {
		cb.buffer[i] = nil
	}
}

// Stats 缓冲区统计信息
type BufferStats struct {
	Size     int       `json:"size"`
	Capacity int       `json:"capacity"`
	Usage    float64   `json:"usage"`    // 使用率
	LastAdd  time.Time `json:"last_add"` // 最后添加时间
}

// GetStats 获取缓冲区统计信息
func (cb *CircularBuffer) GetStats() BufferStats {
	cb.mu.RLock()
	defer cb.mu.RUnlock()

	return BufferStats{
		Size:     cb.size,
		Capacity: cb.cap,
		Usage:    float64(cb.size) / float64(cb.cap),
	}
}