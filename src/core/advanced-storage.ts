// Advanced storage implementation with all enterprise features

import { EventEmitter } from 'eventemitter3';
import * as pako from 'pako';
import * as nacl from 'tweetnacl';
import * as naclUtil from 'tweetnacl-util';
import { z } from 'zod';
import LRUCache from 'lru-cache';
import PQueue from 'p-queue';
import Debug from 'debug';

import {
  StorageAdapter,
  StorageConfig,
  StorageItem,
  StorageMetadata,
  StorageStats,
  StorageError,
  QuotaExceededError,
  EncryptionError,
  ValidationError,
  SetOptions,
  QueryOptions,
  BulkOperation,
  ImportExportOptions,
  StorageEvents,
  StorageChange,
  StorageSchema
} from './types';

import { ChromeAdapter } from '../adapters/chrome-adapter';
import { IndexedDBAdapter } from '../adapters/indexeddb-adapter';
import { MemoryAdapter } from '../adapters/memory-adapter';
import { StorageCache } from '../cache/storage-cache';
import { EncryptionService } from '../security/encryption-service';
import { CompressionService } from '../compression/compression-service';
import { SyncManager } from '../sync/sync-manager';
import { QueryEngine } from '../query/query-engine';
import { MetricsCollector } from '../monitoring/metrics-collector';
import { SchemaValidator } from '../validation/schema-validator';

const debug = Debug('chrome-storage:advanced');

export class AdvancedStorage extends EventEmitter<StorageEvents> {
  private adapter: StorageAdapter;
  private cache?: StorageCache;
  private encryption?: EncryptionService;
  private compression?: CompressionService;
  private sync?: SyncManager;
  private query?: QueryEngine;
  private metrics?: MetricsCollector;
  private validator?: SchemaValidator;
  
  private config: StorageConfig;
  private queue: PQueue;
  private schemas = new Map<string, StorageSchema>();
  private versionCounter = new Map<string, number>();
  
  constructor(config: StorageConfig = {}) {
    super();
    
    this.config = this.normalizeConfig(config);
    this.queue = new PQueue({ concurrency: 10 });
    
    // Initialize adapter
    this.adapter = this.createAdapter();
    
    // Initialize optional services based on config
    this.initializeServices();
    
    debug('AdvancedStorage initialized with config:', this.config);
  }
  
  /**
   * Get value by key
   */
  async get<T = any>(key: string): Promise<T | null> {
    return this.queue.add(async () => {
      const startTime = Date.now();
      
      try {
        // Check cache first
        if (this.cache) {
          const cached = await this.cache.get<T>(key);
          if (cached !== undefined) {
            this.metrics?.recordHit('cache');
            return cached;
          }
          this.metrics?.recordMiss('cache');
        }
        
        // Get from adapter
        let item = await this.adapter.get<StorageItem<T>>(this.getInternalKey(key));
        
        if (!item) {
          return null;
        }
        
        // Handle legacy values (direct storage)
        if (!this.isStorageItem(item)) {
          return item as unknown as T;
        }
        
        // Decrypt if needed
        if (item.metadata.encrypted && this.encryption) {
          item.value = await this.encryption.decrypt(item.value);
        }
        
        // Decompress if needed
        if (item.metadata.compressed && this.compression) {
          item.value = await this.compression.decompress(item.value);
        }
        
        // Update cache
        if (this.cache) {
          await this.cache.set(key, item.value, item.metadata.ttl);
        }
        
        // Record metrics
        const duration = Date.now() - startTime;
        this.metrics?.recordOperation('get', duration, { key });
        
        return item.value;
      } catch (error) {
        this.emit('error', new StorageError(
          `Failed to get value for key "${key}"`,
          'GET_ERROR',
          error
        ));
        throw error;
      }
    });
  }
  
  /**
   * Set value
   */
  async set<T = any>(key: string, value: T, options?: SetOptions): Promise<void> {
    return this.queue.add(async () => {
      const startTime = Date.now();
      
      try {
        // Validate against schema if registered
        if (this.validator) {
          const schemaKey = this.getSchemaKey(key);
          if (this.schemas.has(schemaKey)) {
            await this.validator.validate(value, this.schemas.get(schemaKey)!);
          }
        }
        
        // Check quota
        await this.checkQuota(key, value);
        
        // Get current version
        const currentItem = await this.adapter.get<StorageItem<T>>(this.getInternalKey(key));
        const version = currentItem ? currentItem.metadata.version + 1 : 1;
        this.versionCounter.set(key, version);
        
        // Prepare value
        let processedValue = value;
        let compressed = false;
        let encrypted = false;
        
        // Compress if needed
        if (this.shouldCompress(value, options)) {
          processedValue = await this.compression!.compress(processedValue);
          compressed = true;
        }
        
        // Encrypt if needed
        if (this.shouldEncrypt(options)) {
          processedValue = await this.encryption!.encrypt(processedValue);
          encrypted = true;
        }
        
        // Create storage item
        const now = new Date();
        const item: StorageItem<any> = {
          id: `${key}_${version}_${now.getTime()}`,
          key,
          value: processedValue,
          metadata: {
            created: currentItem?.metadata.created || now,
            updated: now,
            version,
            size: this.estimateSize(processedValue),
            compressed,
            encrypted,
            tags: options?.tags,
            ttl: options?.ttl,
            expiresAt: options?.ttl ? new Date(now.getTime() + options.ttl) : undefined,
            ...options?.metadata
          }
        };
        
        // Store in adapter
        await this.adapter.set(this.getInternalKey(key), item, options);
        
        // Handle versioning
        if (this.config.versioning?.enabled && currentItem) {
          await this.storeVersion(key, currentItem);
        }
        
        // Update cache
        if (this.cache) {
          await this.cache.set(key, value, options?.ttl);
        }
        
        // Emit change event
        this.emit('change', {
          key,
          type: 'set',
          oldValue: currentItem?.value,
          newValue: value,
          timestamp: now
        });
        
        // Queue sync if enabled
        if (this.sync) {
          this.sync.queueChange(key, 'set', value);
        }
        
        // Record metrics
        const duration = Date.now() - startTime;
        this.metrics?.recordOperation('set', duration, { key, size: item.metadata.size });
      } catch (error) {
        this.emit('error', new StorageError(
          `Failed to set value for key "${key}"`,
          'SET_ERROR',
          error
        ));
        throw error;
      }
    });
  }
  
  /**
   * Update value
   */
  async update<T = any>(key: string, updateFn: (current: T | null) => T): Promise<void> {
    return this.queue.add(async () => {
      const current = await this.get<T>(key);
      const updated = updateFn(current);
      await this.set(key, updated);
    });
  }
  
  /**
   * Delete key
   */
  async delete(key: string): Promise<void> {
    return this.queue.add(async () => {
      const startTime = Date.now();
      
      try {
        // Get current value for events
        const currentItem = await this.adapter.get<StorageItem>(this.getInternalKey(key));
        
        // Delete from adapter
        await this.adapter.delete(this.getInternalKey(key));
        
        // Delete from cache
        if (this.cache) {
          await this.cache.delete(key);
        }
        
        // Delete versions
        if (this.config.versioning?.enabled) {
          await this.deleteVersions(key);
        }
        
        // Emit change event
        this.emit('change', {
          key,
          type: 'delete',
          oldValue: currentItem?.value,
          timestamp: new Date()
        });
        
        // Queue sync if enabled
        if (this.sync) {
          this.sync.queueChange(key, 'delete');
        }
        
        // Record metrics
        const duration = Date.now() - startTime;
        this.metrics?.recordOperation('delete', duration, { key });
      } catch (error) {
        this.emit('error', new StorageError(
          `Failed to delete key "${key}"`,
          'DELETE_ERROR',
          error
        ));
        throw error;
      }
    });
  }
  
  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    if (this.cache) {
      const cached = await this.cache.has(key);
      if (cached) return true;
    }
    
    return this.adapter.has(this.getInternalKey(key));
  }
  
  /**
   * Clear all storage
   */
  async clear(): Promise<void> {
    return this.queue.add(async () => {
      try {
        await this.adapter.clear();
        
        if (this.cache) {
          await this.cache.clear();
        }
        
        this.versionCounter.clear();
        
        this.emit('change', {
          key: '*',
          type: 'clear',
          timestamp: new Date()
        });
        
        if (this.sync) {
          this.sync.queueChange('*', 'clear');
        }
        
        this.metrics?.recordOperation('clear', 0);
      } catch (error) {
        this.emit('error', new StorageError(
          'Failed to clear storage',
          'CLEAR_ERROR',
          error
        ));
        throw error;
      }
    });
  }
  
  /**
   * Get all keys
   */
  async keys(): Promise<string[]> {
    const internalKeys = await this.adapter.keys();
    return internalKeys
      .filter(key => !key.startsWith('__'))
      .map(key => this.removeInternalPrefix(key));
  }
  
  /**
   * Get storage size
   */
  async size(): Promise<number> {
    return this.adapter.size();
  }
  
  /**
   * Get storage statistics
   */
  async getStats(): Promise<StorageStats> {
    const [size, keys] = await Promise.all([
      this.size(),
      this.keys()
    ]);
    
    const quota = await this.getQuota();
    const cacheStats = this.cache?.getStats();
    
    return {
      totalSize: size,
      itemCount: keys.length,
      quotaUsed: size,
      quotaAvailable: quota,
      cacheSize: cacheStats?.size || 0,
      cacheHitRate: cacheStats?.hitRate || 0,
      compressionRatio: this.compression?.getCompressionRatio() || 1,
      lastSync: this.sync?.getLastSyncTime() || undefined,
      lastBackup: undefined, // TODO: Implement backup tracking
      adapterStats: await this.getAdapterStats()
    };
  }
  
  /**
   * Execute bulk operations
   */
  async bulk(operations: BulkOperation[]): Promise<void> {
    return this.queue.add(async () => {
      const startTime = Date.now();
      
      try {
        // Group operations by type for optimization
        const sets: BulkOperation[] = [];
        const deletes: string[] = [];
        const updates: BulkOperation[] = [];
        
        for (const op of operations) {
          switch (op.type) {
            case 'set':
              sets.push(op);
              break;
            case 'delete':
              deletes.push(op.key);
              break;
            case 'update':
              updates.push(op);
              break;
          }
        }
        
        // Execute operations
        const promises: Promise<any>[] = [];
        
        if (sets.length > 0) {
          promises.push(
            Promise.all(sets.map(op => this.set(op.key, op.value, op.options)))
          );
        }
        
        if (deletes.length > 0) {
          promises.push(
            Promise.all(deletes.map(key => this.delete(key)))
          );
        }
        
        if (updates.length > 0) {
          promises.push(
            Promise.all(updates.map(op => 
              op.updateFn ? this.update(op.key, op.updateFn) : Promise.resolve()
            ))
          );
        }
        
        await Promise.all(promises);
        
        // Record metrics
        const duration = Date.now() - startTime;
        this.metrics?.recordOperation('bulk', duration, { count: operations.length });
      } catch (error) {
        this.emit('error', new StorageError(
          'Bulk operation failed',
          'BULK_ERROR',
          error
        ));
        throw error;
      }
    });
  }
  
  /**
   * Query storage
   */
  async query<T = any>(options: QueryOptions): Promise<T[]> {
    if (!this.query) {
      throw new StorageError(
        'Query engine not initialized',
        'QUERY_NOT_AVAILABLE'
      );
    }
    
    return this.query.query<T>(options);
  }
  
  /**
   * Export data
   */
  async export(options: ImportExportOptions): Promise<Blob> {
    const keys = await this.keys();
    const data: any[] = [];
    
    for (const key of keys) {
      // Apply filters
      if (options.include) {
        const includePattern = Array.isArray(options.include) 
          ? new RegExp(options.include.join('|'))
          : options.include;
        if (!includePattern.test(key)) continue;
      }
      
      if (options.exclude) {
        const excludePattern = Array.isArray(options.exclude)
          ? new RegExp(options.exclude.join('|'))
          : options.exclude;
        if (excludePattern.test(key)) continue;
      }
      
      const value = await this.get(key);
      if (value !== null) {
        data.push({ key, value });
      }
    }
    
    // Format data
    let formatted: string;
    
    switch (options.format) {
      case 'json':
        formatted = JSON.stringify(data, null, options.pretty ? 2 : 0);
        break;
      case 'csv':
        formatted = await this.formatAsCSV(data, options);
        break;
      default:
        throw new StorageError(
          `Unsupported export format: ${options.format}`,
          'UNSUPPORTED_FORMAT'
        );
    }
    
    // Compress if requested
    let finalData: ArrayBuffer | string = formatted;
    if (options.compressed && this.compression) {
      finalData = await this.compression.compressRaw(formatted);
    }
    
    return new Blob([finalData], { 
      type: this.getMimeType(options.format, options.compressed) 
    });
  }
  
  /**
   * Import data
   */
  async import(blob: Blob, options: ImportExportOptions): Promise<void> {
    let content = await blob.text();
    
    // Decompress if needed
    if (options.compressed && this.compression) {
      const buffer = await blob.arrayBuffer();
      content = await this.compression.decompressRaw(new Uint8Array(buffer));
    }
    
    // Parse data
    let data: any[];
    
    switch (options.format) {
      case 'json':
        data = JSON.parse(content);
        break;
      case 'csv':
        data = await this.parseCSV(content, options);
        break;
      default:
        throw new StorageError(
          `Unsupported import format: ${options.format}`,
          'UNSUPPORTED_FORMAT'
        );
    }
    
    // Import items
    const operations: BulkOperation[] = data.map(item => ({
      type: 'set',
      key: item.key,
      value: item.value
    }));
    
    await this.bulk(operations);
  }
  
  /**
   * Register schema for validation
   */
  registerSchema<T = any>(key: string, schema: StorageSchema<T>): void {
    this.schemas.set(key, schema);
    
    if (!this.validator) {
      this.validator = new SchemaValidator();
    }
  }
  
  /**
   * Watch for changes
   */
  watch(key: string, callback: (change: StorageChange) => void): () => void {
    const listener = (change: StorageChange) => {
      if (key === '*' || change.key === key || change.key === '*') {
        callback(change);
      }
    };
    
    this.on('change', listener);
    
    // Also watch adapter if it supports it
    const unsubscribeAdapter = this.adapter.watch?.(key, callback);
    
    return () => {
      this.off('change', listener);
      unsubscribeAdapter?.();
    };
  }
  
  /**
   * Close storage
   */
  async close(): Promise<void> {
    await this.queue.onIdle();
    
    this.cache?.destroy();
    this.sync?.stop();
    this.metrics?.stop();
    
    await this.adapter.close?.();
    
    this.removeAllListeners();
  }
  
  // Private methods
  
  private normalizeConfig(config: StorageConfig): StorageConfig {
    return {
      adapter: config.adapter || 'auto',
      namespace: config.namespace || 'default',
      encryption: {
        enabled: false,
        algorithm: 'AES-GCM',
        ...config.encryption
      },
      compression: {
        enabled: false,
        algorithm: 'gzip',
        threshold: 1024,
        level: 6,
        ...config.compression
      },
      cache: {
        enabled: true,
        strategy: 'lru',
        maxSize: 1000,
        maxMemory: 10 * 1024 * 1024, // 10MB
        ttl: 3600000, // 1 hour
        ...config.cache
      },
      sync: {
        enabled: false,
        interval: 300000, // 5 minutes
        conflictResolution: 'local',
        providers: ['chrome.sync'],
        ...config.sync
      },
      versioning: {
        enabled: false,
        maxVersions: 10,
        autoCleanup: true,
        ...config.versioning
      },
      quota: {
        maxSize: 100, // 100MB
        warnAt: 80,
        enforceLimit: true,
        ...config.quota
      },
      monitoring: {
        enabled: false,
        performance: true,
        errors: true,
        usage: true,
        ...config.monitoring
      },
      debug: config.debug || false
    };
  }
  
  private createAdapter(): StorageAdapter {
    const adapterType = this.config.adapter;
    
    if (adapterType === 'auto') {
      // Auto-detect best adapter
      if (typeof chrome !== 'undefined' && chrome.storage) {
        return new ChromeAdapter({ 
          area: 'local',
          namespace: this.config.namespace 
        });
      } else if (typeof indexedDB !== 'undefined') {
        return new IndexedDBAdapter({
          namespace: this.config.namespace
        });
      } else {
        return new MemoryAdapter({
          namespace: this.config.namespace
        });
      }
    }
    
    switch (adapterType) {
      case 'chrome':
        return new ChromeAdapter({
          area: 'local',
          namespace: this.config.namespace
        });
      case 'indexeddb':
        return new IndexedDBAdapter({
          namespace: this.config.namespace
        });
      case 'memory':
        return new MemoryAdapter({
          namespace: this.config.namespace
        });
      default:
        throw new StorageError(
          `Unknown adapter type: ${adapterType}`,
          'UNKNOWN_ADAPTER'
        );
    }
  }
  
  private initializeServices(): void {
    // Initialize cache
    if (this.config.cache?.enabled) {
      this.cache = new StorageCache({
        strategy: this.config.cache.strategy,
        maxSize: this.config.cache.maxSize,
        maxMemory: this.config.cache.maxMemory,
        ttl: this.config.cache.ttl
      });
    }
    
    // Initialize encryption
    if (this.config.encryption?.enabled) {
      this.encryption = new EncryptionService({
        algorithm: this.config.encryption.algorithm!,
        key: this.config.encryption.key
      });
    }
    
    // Initialize compression
    if (this.config.compression?.enabled) {
      this.compression = new CompressionService({
        algorithm: this.config.compression.algorithm!,
        level: this.config.compression.level!
      });
    }
    
    // Initialize sync
    if (this.config.sync?.enabled) {
      this.sync = new SyncManager(this, this.config.sync);
      this.sync.start();
    }
    
    // Initialize query engine
    this.query = new QueryEngine(this.adapter);
    
    // Initialize metrics
    if (this.config.monitoring?.enabled) {
      this.metrics = new MetricsCollector(this.config.monitoring);
      this.metrics.start();
    }
    
    // Initialize validator
    this.validator = new SchemaValidator();
  }
  
  private getInternalKey(key: string): string {
    return `${this.config.namespace}:${key}`;
  }
  
  private removeInternalPrefix(key: string): string {
    const prefix = `${this.config.namespace}:`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }
  
  private getSchemaKey(key: string): string {
    // Extract schema key from storage key (e.g., "users:123" -> "users")
    const parts = key.split(':');
    return parts[0];
  }
  
  private isStorageItem(value: any): value is StorageItem {
    return value && 
           typeof value === 'object' &&
           'id' in value &&
           'key' in value &&
           'value' in value &&
           'metadata' in value;
  }
  
  private shouldCompress(value: any, options?: SetOptions): boolean {
    if (!this.compression) return false;
    if (options?.compress === false) return false;
    if (options?.compress === true) return true;
    
    const size = this.estimateSize(value);
    return size >= (this.config.compression?.threshold || 1024);
  }
  
  private shouldEncrypt(options?: SetOptions): boolean {
    if (!this.encryption) return false;
    if (options?.encrypt === false) return false;
    return this.config.encryption?.enabled || options?.encrypt === true;
  }
  
  private estimateSize(value: any): number {
    try {
      return new Blob([JSON.stringify(value)]).size;
    } catch {
      return JSON.stringify(value).length * 2;
    }
  }
  
  private async checkQuota(key: string, value: any): Promise<void> {
    if (!this.config.quota?.enforceLimit) return;
    
    const itemSize = this.estimateSize(value);
    const currentSize = await this.size();
    const quota = this.config.quota.maxSize! * 1024 * 1024; // Convert MB to bytes
    
    if (currentSize + itemSize > quota) {
      throw new QuotaExceededError(
        'Storage quota exceeded',
        currentSize + itemSize,
        quota
      );
    }
    
    // Emit warning if approaching limit
    const usagePercent = ((currentSize + itemSize) / quota) * 100;
    if (usagePercent >= (this.config.quota.warnAt || 80)) {
      this.emit('quota-warning', await this.getStats());
    }
  }
  
  private async getQuota(): Promise<number> {
    if (this.adapter.type === 'chrome') {
      const info = await (this.adapter as ChromeAdapter).getInfo();
      return info.quota;
    }
    
    return (this.config.quota?.maxSize || 100) * 1024 * 1024; // Default 100MB
  }
  
  private async getAdapterStats(): Promise<Record<string, any>> {
    if ('getInfo' in this.adapter) {
      return (this.adapter as any).getInfo();
    }
    return {};
  }
  
  private async storeVersion(key: string, item: StorageItem): Promise<void> {
    const versionKey = `__version:${key}:${item.metadata.version}`;
    await this.adapter.set(versionKey, item);
    
    // Cleanup old versions if needed
    if (this.config.versioning?.autoCleanup) {
      await this.cleanupVersions(key);
    }
  }
  
  private async cleanupVersions(key: string): Promise<void> {
    const maxVersions = this.config.versioning?.maxVersions || 10;
    const versionKeys = await this.adapter.keys();
    const keyVersions = versionKeys
      .filter(k => k.startsWith(`__version:${key}:`))
      .sort()
      .reverse();
    
    if (keyVersions.length > maxVersions) {
      const toDelete = keyVersions.slice(maxVersions);
      await Promise.all(toDelete.map(k => this.adapter.delete(k)));
    }
  }
  
  private async deleteVersions(key: string): Promise<void> {
    const versionKeys = await this.adapter.keys();
    const keyVersions = versionKeys.filter(k => k.startsWith(`__version:${key}:`));
    await Promise.all(keyVersions.map(k => this.adapter.delete(k)));
  }
  
  private async formatAsCSV(data: any[], options: ImportExportOptions): Promise<string> {
    // Simple CSV formatting - in real implementation use papaparse
    const headers = options.headers !== false;
    const rows: string[] = [];
    
    if (headers && data.length > 0) {
      rows.push('key,value');
    }
    
    for (const item of data) {
      const value = JSON.stringify(item.value).replace(/"/g, '""');
      rows.push(`"${item.key}","${value}"`);
    }
    
    return rows.join('\n');
  }
  
  private async parseCSV(content: string, options: ImportExportOptions): Promise<any[]> {
    // Simple CSV parsing - in real implementation use papaparse
    const lines = content.split('\n');
    const hasHeaders = options.headers !== false;
    const startIndex = hasHeaders ? 1 : 0;
    const data: any[] = [];
    
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // Very basic CSV parsing
      const match = line.match(/"([^"]+)","([^"]+)"/);
      if (match) {
        const [, key, value] = match;
        data.push({
          key,
          value: JSON.parse(value.replace(/""/g, '"'))
        });
      }
    }
    
    return data;
  }
  
  private getMimeType(format: string, compressed?: boolean): string {
    const baseTypes: Record<string, string> = {
      json: 'application/json',
      csv: 'text/csv',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xml: 'application/xml'
    };
    
    const mimeType = baseTypes[format] || 'application/octet-stream';
    return compressed ? 'application/gzip' : mimeType;
  }
}