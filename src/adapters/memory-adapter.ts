// In-memory storage adapter for testing and fallback

import { BaseAdapter } from './base-adapter';
import { SetOptions, StorageError } from '../core/types';

interface MemoryRecord {
  value: any;
  metadata?: any;
  expiresAt?: number;
  created: number;
  updated: number;
}

export interface MemoryAdapterOptions {
  namespace?: string;
  maxSize?: number; // Maximum number of items
  maxMemory?: number; // Maximum memory in bytes
  persist?: boolean; // Persist to localStorage (if available)
}

export class MemoryAdapter extends BaseAdapter {
  readonly name = 'MemoryAdapter';
  readonly type = 'memory' as const;
  
  private store = new Map<string, MemoryRecord>();
  private maxSize: number;
  private maxMemory: number;
  private persist: boolean;
  private cleanupTimer?: NodeJS.Timeout;
  
  constructor(options: MemoryAdapterOptions = {}) {
    super(options.namespace);
    
    this.maxSize = options.maxSize || 10000;
    this.maxMemory = options.maxMemory || 50 * 1024 * 1024; // 50MB
    this.persist = options.persist || false;
    
    // Load from localStorage if persist is enabled
    if (this.persist && typeof localStorage !== 'undefined') {
      this.loadFromLocalStorage();
    }
    
    // Start cleanup timer
    this.startCleanupTimer();
  }
  
  /**
   * Get value by key
   */
  async get<T = any>(key: string): Promise<T | null> {
    this.validateKey(key);
    
    const record = this.store.get(key);
    
    if (!record) {
      return null;
    }
    
    // Check expiration
    if (record.expiresAt && Date.now() > record.expiresAt) {
      this.store.delete(key);
      this.persistIfEnabled();
      return null;
    }
    
    return record.value as T;
  }
  
  /**
   * Set value
   */
  async set<T = any>(key: string, value: T, options?: SetOptions): Promise<void> {
    this.validateKey(key);
    
    // Check size limits
    await this.checkLimits(key, value);
    
    const now = Date.now();
    const oldRecord = this.store.get(key);
    
    const record: MemoryRecord = {
      value,
      metadata: options?.metadata,
      expiresAt: options?.ttl ? now + options.ttl : undefined,
      created: oldRecord?.created || now,
      updated: now
    };
    
    this.store.set(key, record);
    this.persistIfEnabled();
    
    // Notify watchers
    this.notifyWatchers({
      key,
      type: 'set',
      oldValue: oldRecord?.value,
      newValue: value,
      timestamp: new Date()
    });
  }
  
  /**
   * Delete key
   */
  async delete(key: string): Promise<void> {
    this.validateKey(key);
    
    const record = this.store.get(key);
    
    if (record) {
      this.store.delete(key);
      this.persistIfEnabled();
      
      // Notify watchers
      this.notifyWatchers({
        key,
        type: 'delete',
        oldValue: record.value,
        timestamp: new Date()
      });
    }
  }
  
  /**
   * Clear all storage
   */
  async clear(): Promise<void> {
    const keys = Array.from(this.store.keys());
    
    this.store.clear();
    this.persistIfEnabled();
    
    // Notify watchers
    keys.forEach(key => {
      this.notifyWatchers({
        key,
        type: 'delete',
        timestamp: new Date()
      });
    });
    
    this.notifyWatchers({
      key: '*',
      type: 'clear',
      timestamp: new Date()
    });
  }
  
  /**
   * Get all keys
   */
  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
  
  /**
   * Get storage size
   */
  async size(): Promise<number> {
    let totalSize = 0;
    
    for (const [key, record] of this.store) {
      const itemSize = this.estimateSize(key, record);
      totalSize += itemSize;
    }
    
    return totalSize;
  }
  
  /**
   * Get multiple values (optimized)
   */
  async getMany<T = any>(keys: string[]): Promise<Array<T | null>> {
    return keys.map(key => {
      const record = this.store.get(key);
      
      if (!record) {
        return null;
      }
      
      // Check expiration
      if (record.expiresAt && Date.now() > record.expiresAt) {
        this.store.delete(key);
        return null;
      }
      
      return record.value as T;
    });
  }
  
  /**
   * Check size and memory limits
   */
  private async checkLimits(key: string, value: any): Promise<void> {
    // Check item count limit
    if (!this.store.has(key) && this.store.size >= this.maxSize) {
      // Evict oldest item
      const oldestKey = this.findOldestKey();
      if (oldestKey) {
        await this.delete(oldestKey);
      }
    }
    
    // Check memory limit
    const newItemSize = this.estimateSize(key, { value });
    const currentSize = await this.size();
    
    if (currentSize + newItemSize > this.maxMemory) {
      // Evict items until we have enough space
      const keysToEvict = this.selectEvictionCandidates(newItemSize);
      for (const evictKey of keysToEvict) {
        await this.delete(evictKey);
      }
    }
  }
  
  /**
   * Find oldest key
   */
  private findOldestKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    
    for (const [key, record] of this.store) {
      if (record.updated < oldestTime) {
        oldestTime = record.updated;
        oldestKey = key;
      }
    }
    
    return oldestKey;
  }
  
  /**
   * Select keys to evict
   */
  private selectEvictionCandidates(requiredSpace: number): string[] {
    const candidates: Array<{ key: string; size: number; updated: number }> = [];
    
    for (const [key, record] of this.store) {
      candidates.push({
        key,
        size: this.estimateSize(key, record),
        updated: record.updated
      });
    }
    
    // Sort by least recently used
    candidates.sort((a, b) => a.updated - b.updated);
    
    const keysToEvict: string[] = [];
    let freedSpace = 0;
    
    for (const candidate of candidates) {
      if (freedSpace >= requiredSpace) break;
      keysToEvict.push(candidate.key);
      freedSpace += candidate.size;
    }
    
    return keysToEvict;
  }
  
  /**
   * Estimate size of item
   */
  private estimateSize(key: string, record: any): number {
    try {
      const data = JSON.stringify({ key, ...record });
      return new Blob([data]).size;
    } catch {
      // Fallback estimation
      return JSON.stringify({ key, ...record }).length * 2;
    }
  }
  
  /**
   * Cleanup expired items
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, record] of this.store) {
      if (record.expiresAt && now > record.expiresAt) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => {
      this.delete(key).catch(console.error);
    });
  }
  
  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    // Run cleanup every minute
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60000);
    
    // Run initial cleanup
    this.cleanup();
  }
  
  /**
   * Load from localStorage
   */
  private loadFromLocalStorage(): void {
    try {
      const storageKey = `memory_adapter_${this.namespace}`;
      const data = localStorage.getItem(storageKey);
      
      if (data) {
        const parsed = JSON.parse(data);
        
        for (const [key, record] of Object.entries(parsed)) {
          this.store.set(key, record as MemoryRecord);
        }
      }
    } catch (error) {
      console.warn('Failed to load from localStorage:', error);
    }
  }
  
  /**
   * Persist to localStorage if enabled
   */
  private persistIfEnabled(): void {
    if (!this.persist || typeof localStorage === 'undefined') return;
    
    try {
      const storageKey = `memory_adapter_${this.namespace}`;
      const data: Record<string, MemoryRecord> = {};
      
      for (const [key, record] of this.store) {
        data[key] = record;
      }
      
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch (error) {
      console.warn('Failed to persist to localStorage:', error);
    }
  }
  
  /**
   * Close adapter
   */
  async close(): Promise<void> {
    await super.close();
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.store.clear();
  }
  
  /**
   * Get adapter info
   */
  async getInfo(): Promise<{
    itemCount: number;
    size: number;
    maxSize: number;
    maxMemory: number;
    persist: boolean;
  }> {
    return {
      itemCount: this.store.size,
      size: await this.size(),
      maxSize: this.maxSize,
      maxMemory: this.maxMemory,
      persist: this.persist
    };
  }
}

// Export a singleton for convenient use
export const memoryAdapter = new MemoryAdapter();