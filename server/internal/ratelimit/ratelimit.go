// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package ratelimit provides a keyed token-bucket limiter.
//
// In-memory and single-process, like the hub. Several server instances
// would each keep their own counters, which weakens the limit but does not
// break it. A shared store (Redis) is the upgrade path if that ever matters.
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter hands out tokens that refill at a steady rate, per key.
//
// Token buckets are the right shape for login protection: a burst of
// legitimate retries goes through immediately, and sustained hammering
// settles to the refill rate rather than being blocked outright.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	rate  float64 // tokens per second
	burst float64 // bucket capacity
	idle  time.Duration

	// maxKeys bounds memory. Without it, an attacker rotating source
	// addresses turns the limiter itself into the denial of service.
	maxKeys int
}

// New returns a limiter allowing burst requests immediately, refilling at
// perSecond. Buckets idle for longer than idle are evicted.
func New(perSecond, burst float64, idle time.Duration) *Limiter {
	l := &Limiter{
		buckets: make(map[string]*bucket),
		rate:    perSecond,
		burst:   burst,
		idle:    idle,
		maxKeys: 50_000,
	}
	go l.janitor()
	return l
}

// Allow consumes one token for key, reporting whether it was available.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.maxKeys {
			l.evictLocked(now)
		}
		l.buckets[key] = &bucket{tokens: l.burst - 1, last: now}
		return true
	}

	// Refill for elapsed time, capped at burst.
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// RetryAfter reports how long until key has a token again.
func (l *Limiter) RetryAfter(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok || b.tokens >= 1 {
		return 0
	}
	seconds := (1 - b.tokens) / l.rate
	return time.Duration(seconds * float64(time.Second))
}

// Reset clears a key's bucket. Called on successful login so a user who
// fumbled their password twice is not still penalised afterwards.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.buckets, key)
}

func (l *Limiter) janitor() {
	ticker := time.NewTicker(l.idle)
	defer ticker.Stop()

	for range ticker.C {
		l.mu.Lock()
		l.evictLocked(time.Now())
		l.mu.Unlock()
	}
}

// evictLocked drops buckets that are idle and full. A bucket at capacity
// holds no useful state, so forgetting it changes nothing.
func (l *Limiter) evictLocked(now time.Time) {
	for key, b := range l.buckets {
		if now.Sub(b.last) > l.idle {
			delete(l.buckets, key)
		}
	}
}
