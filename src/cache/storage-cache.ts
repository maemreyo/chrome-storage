// Multi-level caching system with various strategies

import LRUCache from 'lru-cache';
import QuickLRU from 'quick-lru';
import { EventEmitter } from 'eventemitter3';

export interface CacheConfig {
  strategy?: 'lru' | 'lfu' | 'fifo' | 'ttl';
  maxSize?: number;
  maxMemory?: number;
  ttl?: number;
  updateAgeOnGet?: boolean;
  updateAgeOnHas?: boolean;
  allowStale?: boolean;
}

export interface CacheEntry<T = any> {
  key: string;
  value: T;
  size: number;
  frequency: number;
  createdAt: number;
  accessedAt: number;
  expiresAt?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  memoryUsage: number;
  evictions: number;
  writes: number;
  reads: number;
}

export class StorageCache extends EventEmitter {
  private lruCache?: LRUCache<string, any>;
  private quickCache?: QuickLRU<string, CacheEntry>;
  private fifoCache?: Map<string, CacheEntry>;
  private frequencyMap = new Map<string, number>();
  
  private config: Required<CacheConfig>;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    hitRate: 0,
    size: 0,
    memoryUsage: 0,
    evictions: 0,
    writes: 0,
    reads: 0
  };
  
  constructor(config: CacheConfig = {}) {
    super();
    
    this.config = {
      strategy: config.strategy || 'lru',
      maxSize: config.maxSize || 1000,
      maxMemory: config.maxMemory || 10 * 1024 * 1024, // 10MB
      ttl: config.ttl || 3600000, // 1 hour
      updateAgeOnGet: config.updateAgeOnGet !== false,
      updateAgeOnHas: config.updateAgeOnHas !== false,
      allowStale: config.allowStale || false
    };
    
    this.initializeCache();
  }
  
  /**
   * Get value from cache
   */
  async get<T = any>(key: string): Promise<T | undefined> {
    this.stats.reads++;
    
    if (this.config.strategy === 'lru' && this.lruCache) {
      const value = this.lruCache.get(key);
      
      if (value !== undefined) {
        this.stats.hits++;
        this.updateHitRate();
        this.frequencyMap.set(key, (this.frequencyMap.get(key) || 0) + 1);
        return value;
      }
    } else if (this.config.strategy === 'lfu' && this.quickCache) {
      const entry = this.quickCache.get(key);
      
      if (entry && !this.isExpired(entry)) {
        entry.frequency++;
        entry.accessedAt = Date.now();
        this.frequencyMap.set(key, entry.frequency);
        this.stats.hits++;
        this.updateHitRate();
        return entry.value;
      }
    } else if (this.config.strategy === 'fifo' && this.fifoCache) {
      const entry = this.fifoCache.get(key);
      
      if (entry && !this.isExpired(entry)) {
        entry.accessedAt = Date.now();
        this.stats.hits++;
        this.updateHitRate();
        return entry.value;
      }
    }
    
    this.stats.misses++;
    this.updateHitRate();
    return undefined;
  }
  
  /**
   * Set value in cache
   */
  async set<T = any>(key: string, value: T, ttl?: number): Promise<void> {
    this.stats.writes++;
    const size = this.estimateSize(value);
    const now = Date.now();
    const expiresAt = ttl ? now + ttl : this.config.ttl ? now + this.config.ttl : undefined;
    
    if (this.config.strategy === 'lru' && this.lruCache) {
      // Check memory limit
      if (this.stats.memoryUsage + size > this.config.maxMemory) {
        this.evictByMemory(size);
      }
      
      this.lruCache.set(key, value, {
        ttl: ttl || this.config.ttl,
        size
      });
      
      this.stats.size = this.lruCache.size;
      this.stats.memoryUsage += size;
    } else {
      const entry: CacheEntry<T> = {
        key,
        value,
        size,
        frequency: 1,
        createdAt: now,
        accessedAt: now,
        expiresAt
      };
      
      // Check limits
      this.enforceLimit(size);
      
      if (this.config.strategy === 'lfu' && this.quickCache) {
        this.quickCache.set(key, entry);
        this.stats.size = this.quickCache.size;
      } else if (this.config.strategy === 'fifo' && this.fifoCache) {
        this.fifoCache.set(key, entry);
        this.stats.size = this.fifoCache.size;
      }
      
      this.stats.memoryUsage += size;
    }
    
    this.frequencyMap.set(key, 1);
    this.emit('set', { key, value });
  }
  
  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    if (this.config.strategy === 'lru' && this.lruCache) {
      return this.lruCache.has(key);
    } else if (this.config.strategy === 'lfu' && this.quickCache) {
      const entry = this.quickCache.get(key);
      return entry !== undefined && !this.isExpired(entry);
    } else if (this.config.strategy === 'fifo' && this.fifoCache) {
      const entry = this.fifoCache.get(key);
      return entry !== undefined && !this.isExpired(entry);
    }
    
    return false;
  }
  
  /**
   * Delete key from cache
   */
  async delete(key: string): Promise<boolean> {
    let deleted = false;
    
    if (this.config.strategy === 'lru' && this.lruCache) {
      deleted = this.lruCache.delete(key);
      this.stats.size = this.lruCache.size;
    } else if (this.config.strategy === 'lfu' && this.quickCache) {
      const entry = this.quickCache.get(key);
      if (entry) {
        this.stats.memoryUsage -= entry.size;
        deleted = this.quickCache.delete(key);
        this.stats.size = this.quickCache.size;
      }
    } else if (this.config.strategy === 'fifo' && this.fifoCache) {
      const entry = this.fifoCache.get(key);
      if (entry) {
        this.stats.memoryUsage -= entry.size;
        deleted = this.fifoCache.delete(key);
        this.stats.size = this.fifoCache.size;
      }
    }
    
    this.frequencyMap.delete(key);
    
    if (deleted) {
      this.emit('delete', { key });
    }
    
    return deleted;
  }
  
  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    if (this.config.strategy === 'lru' && this.lruCache) {
      this.lruCache.clear();
    } else if (this.config.strategy === 'lfu' && this.quickCache) {
      this.quickCache.clear();
    } else if (this.config.strategy === 'fifo' && this.fifoCache) {
      this.fifoCache.clear();
    }
    
    this.frequencyMap.clear();
    this.stats.size = 0;
    this.stats.memoryUsage = 0;
    
    this.emit('clear');
  }
  
  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }
  
  /**
   * Get all keys
   */
  async keys(): Promise<string[]> {
    if (this.config.strategy === 'lru' && this.lruCache) {
      return Array.from(this.lruCache.keys());
    } else if (this.config.strategy === 'lfu' && this.quickCache) {
      return Array.from(this.quickCache.keys());
    } else if (this.config.strategy === 'fifo' && this.fifoCache) {
      return Array.from(this.fifoCache.keys());
    }
    
    return [];
  }
  
  /**
   * Prune expired entries
   */
  async prune(): Promise<number> {
    let pruned = 0;
    
    if (this.config.strategy === 'lru' && this.lruCache) {
      // LRU cache handles TTL automatically
      const oldSize = this.lruCache.size;
      this.lruCache.purgeStale();
      pruned = oldSize - this.lruCache.size;
    } else {
      const now = Date.now();
      const keysToDelete: string[] = [];
      
      if (this.config.strategy === 'lfu' && this.quickCache) {
        for (const [key, entry] of this.quickCache.entries()) {
          if (this.isExpired(entry)) {
            keysToDelete.push(key);
          }
        }
      } else if (this.config.strategy === 'fifo' && this.fifoCache) {
        for (const [key, entry] of this.fifoCache) {
          if (this.isExpired(entry)) {
            keysToDelete.push(key);
          }
        }
      }
      
      for (const key of keysToDelete) {
        await this.delete(key);
        pruned++;
      }
    }
    
    return pruned;
  }
  
  /**
   * Warm cache with values
   */
  async warm(entries: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttl);
    }
  }
  
  /**
   * Destroy cache
   */
  destroy(): void {
    this.clear();
    this.removeAllListeners();
  }
  
  // Private methods
  
  private initializeCache(): void {
    switch (this.config.strategy) {
      case 'lru':
        this.lruCache = new LRUCache({
          max: this.config.maxSize,
          ttl: this.config.ttl,
          maxSize: this.config.maxMemory,
          sizeCalculation: (value) => this.estimateSize(value),
          updateAgeOnGet: this.config.updateAgeOnGet,
          updateAgeOnHas: this.config.updateAgeOnHas,
          allowStale: this.config.allowStale,
          dispose: (value, key) => {
            this.stats.evictions++;
            this.emit('evict', { key, value });
          }
        });
        break;
        
      case 'lfu':
        this.quickCache = new QuickLRU({
          maxSize: this.config.maxSize,
          onEviction: (key, value) => {
            this.stats.evictions++;
            this.stats.memoryUsage -= value.size;
            this.emit('evict', { key, value: value.value });
          }
        });
        break;
        
      case 'fifo':
      case 'ttl':
        this.fifoCache = new Map();
        break;
    }
    
    // Start periodic cleanup for TTL-based strategies
    if (this.config.ttl && this.config.strategy !== 'lru') {
      setInterval(() => {
        this.prune().catch(console.error);
      }, Math.min(this.config.ttl / 10, 60000)); // Check every 10% of TTL or 1 minute
    }
  }
  
  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt ? Date.now() > entry.expiresAt : false;
  }
  
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
  
  private estimateSize(value: any): number {
    try {
      return new Blob([JSON.stringify(value)]).size;
    } catch {
      return JSON.stringify(value).length * 2;
    }
  }
  
  private enforceLimit(requiredSize: number): void {
    // Check size limit
    if (this.config.strategy === 'lfu' && this.quickCache && this.quickCache.size >= this.config.maxSize) {
      this.evictLFU();
    } else if (this.config.strategy === 'fifo' && this.fifoCache && this.fifoCache.size >= this.config.maxSize) {
      this.evictFIFO();
    }
    
    // Check memory limit
    if (this.stats.memoryUsage + requiredSize > this.config.maxMemory) {
      this.evictByMemory(requiredSize);
    }
  }
  
  private evictLFU(): void {
    if (!this.quickCache) return;
    
    // Find least frequently used
    let minFreq = Infinity;
    let evictKey: string | undefined;
    
    for (const [key, entry] of this.quickCache.entries()) {
      if (entry.frequency < minFreq) {
        minFreq = entry.frequency;
        evictKey = key;
      }
    }
    
    if (evictKey) {
      this.delete(evictKey);
    }
  }
  
  private evictFIFO(): void {
    if (!this.fifoCache) return;
    
    // Evict first (oldest) entry
    const firstKey = this.fifoCache.keys().next().value;
    if (firstKey) {
      this.delete(firstKey);
    }
  }
  
  private evictByMemory(requiredSize: number): void {
    const entries: Array<{ key: string; size: number; score: number }> = [];
    
    if (this.config.strategy === 'lfu' && this.quickCache) {
      for (const [key, entry] of this.quickCache.entries()) {
        entries.push({
          key,
          size: entry.size,
          score: entry.frequency / entry.size // Frequency per byte
        });
      }
    } else if (this.config.strategy === 'fifo' && this.fifoCache) {
      for (const [key, entry] of this.fifoCache) {
        entries.push({
          key,
          size: entry.size,
          score: entry.createdAt // Older = lower score
        });
      }
    }
    
    // Sort by score (ascending = worse candidates)
    entries.sort((a, b) => a.score - b.score);
    
    let freedSpace = 0;
    for (const entry of entries) {
      if (freedSpace >= requiredSize) break;
      this.delete(entry.key);
      freedSpace += entry.size;
    }
  }
}