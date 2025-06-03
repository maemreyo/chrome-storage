// Chrome storage API adapter

import { BaseAdapter } from './base-adapter';
import {
  SetOptions,
  StorageChange,
  StorageError,
  QuotaExceededError
} from '../core/types';

export interface ChromeAdapterOptions {
  area?: 'local' | 'sync' | 'managed' | 'session';
  namespace?: string;
}

export class ChromeAdapter extends BaseAdapter {
  readonly name = 'ChromeAdapter';
  readonly type = 'chrome' as const;
  
  private area: chrome.storage.StorageArea;
  private areaName: string;
  
  constructor(options: ChromeAdapterOptions = {}) {
    super(options.namespace);
    
    this.areaName = options.area || 'local';
    
    // Check if chrome storage is available
    if (typeof chrome === 'undefined' || !chrome.storage) {
      throw new StorageError(
        'Chrome storage API not available',
        'CHROME_STORAGE_UNAVAILABLE'
      );
    }
    
    // Get storage area
    switch (this.areaName) {
      case 'local':
        this.area = chrome.storage.local;
        break;
      case 'sync':
        this.area = chrome.storage.sync;
        break;
      case 'managed':
        this.area = chrome.storage.managed;
        break;
      case 'session':
        // Session storage might not be available in all Chrome versions
        if ('session' in chrome.storage) {
          this.area = (chrome.storage as any).session;
        } else {
          throw new StorageError(
            'Chrome session storage not available',
            'SESSION_STORAGE_UNAVAILABLE'
          );
        }
        break;
      default:
        throw new StorageError(
          `Invalid storage area: ${this.areaName}`,
          'INVALID_STORAGE_AREA'
        );
    }
    
    // Set up change listener
    this.setupChangeListener();
  }
  
  /**
   * Get value by key
   */
  async get<T = any>(key: string): Promise<T | null> {
    this.validateKey(key);
    const namespacedKey = this.getNamespacedKey(key);
    
    return new Promise((resolve, reject) => {
      this.area.get(namespacedKey, (result) => {
        if (chrome.runtime.lastError) {
          reject(new StorageError(
            chrome.runtime.lastError.message || 'Failed to get value',
            'GET_ERROR'
          ));
          return;
        }
        
        const value = result[namespacedKey];
        resolve(value !== undefined ? value : null);
      });
    });
  }
  
  /**
   * Set value
   */
  async set<T = any>(key: string, value: T, options?: SetOptions): Promise<void> {
    this.validateKey(key);
    const namespacedKey = this.getNamespacedKey(key);
    
    // Check quota before setting
    await this.checkQuota(key, value);
    
    // Handle TTL if specified
    let finalValue = value;
    if (options?.ttl) {
      finalValue = {
        __value: value,
        __expiresAt: Date.now() + options.ttl,
        __metadata: options.metadata
      } as any;
    }
    
    return new Promise((resolve, reject) => {
      this.area.set({ [namespacedKey]: finalValue }, () => {
        if (chrome.runtime.lastError) {
          reject(new StorageError(
            chrome.runtime.lastError.message || 'Failed to set value',
            'SET_ERROR'
          ));
          return;
        }
        
        // Notify watchers
        this.notifyWatchers({
          key,
          type: 'set',
          newValue: value,
          timestamp: new Date()
        });
        
        resolve();
      });
    });
  }
  
  /**
   * Delete key
   */
  async delete(key: string): Promise<void> {
    this.validateKey(key);
    const namespacedKey = this.getNamespacedKey(key);
    
    const oldValue = await this.get(key);
    
    return new Promise((resolve, reject) => {
      this.area.remove(namespacedKey, () => {
        if (chrome.runtime.lastError) {
          reject(new StorageError(
            chrome.runtime.lastError.message || 'Failed to delete value',
            'DELETE_ERROR'
          ));
          return;
        }
        
        // Notify watchers
        this.notifyWatchers({
          key,
          type: 'delete',
          oldValue,
          timestamp: new Date()
        });
        
        resolve();
      });
    });
  }
  
  /**
   * Clear all storage
   */
  async clear(): Promise<void> {
    // Get all keys first for notifications
    const keys = await this.keys();
    
    return new Promise((resolve, reject) => {
      // If namespace is used, only clear namespaced keys
      if (this.namespace !== 'default') {
        this.keys().then(keysToDelete => {
          const namespacedKeys = keysToDelete.map(k => this.getNamespacedKey(k));
          this.area.remove(namespacedKeys, () => {
            if (chrome.runtime.lastError) {
              reject(new StorageError(
                chrome.runtime.lastError.message || 'Failed to clear storage',
                'CLEAR_ERROR'
              ));
              return;
            }
            
            // Notify watchers for each key
            keys.forEach(key => {
              this.notifyWatchers({
                key,
                type: 'delete',
                timestamp: new Date()
              });
            });
            
            resolve();
          });
        });
      } else {
        this.area.clear(() => {
          if (chrome.runtime.lastError) {
            reject(new StorageError(
              chrome.runtime.lastError.message || 'Failed to clear storage',
              'CLEAR_ERROR'
            ));
            return;
          }
          
          // Notify watchers
          this.notifyWatchers({
            key: '*',
            type: 'clear',
            timestamp: new Date()
          });
          
          resolve();
        });
      }
    });
  }
  
  /**
   * Get all keys
   */
  async keys(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.area.get(null, (items) => {
        if (chrome.runtime.lastError) {
          reject(new StorageError(
            chrome.runtime.lastError.message || 'Failed to get keys',
            'KEYS_ERROR'
          ));
          return;
        }
        
        const allKeys = Object.keys(items);
        const prefix = `${this.namespace}:`;
        const namespacedKeys = allKeys
          .filter(key => key.startsWith(prefix))
          .map(key => this.removeNamespace(key));
        
        resolve(namespacedKeys);
      });
    });
  }
  
  /**
   * Get storage size
   */
  async size(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.area.getBytesInUse(null, (bytes) => {
        if (chrome.runtime.lastError) {
          reject(new StorageError(
            chrome.runtime.lastError.message || 'Failed to get size',
            'SIZE_ERROR'
          ));
          return;
        }
        
        resolve(bytes);
      });
    });
  }
  
  /**
   * Get multiple values (optimized)
   */
  async getMany<T = any>(keys: string[]): Promise<Array<T | null>> {
    const namespacedKeys = keys.map(key => {
      this.validateKey(key);
      return this.getNamespacedKey(key);
    });
    
    return new Promise((resolve, reject) => {
      this.area.get(namespacedKeys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new StorageError(
            chrome.runtime.lastError.message || 'Failed to get values',
            'GET_MANY_ERROR'
          ));
          return;
        }
        
        const values = keys.map(key => {
          const namespacedKey = this.getNamespacedKey(key);
          const value = result[namespacedKey];
          
          // Check for TTL
          if (value && typeof value === 'object' && '__expiresAt' in value) {
            if (Date.now() > value.__expiresAt) {
              // Expired - delete it
              this.delete(key).catch(console.error);
              return null;
            }
            return value.__value as T;
          }
          
          return value !== undefined ? value as T : null;
        });
        
        resolve(values);
      });
    });
  }
  
  /**
   * Set multiple values (optimized)
   */
  async setMany(items: Array<{ key: string; value: any; options?: SetOptions }>): Promise<void> {
    const data: Record<string, any> = {};
    
    for (const { key, value, options } of items) {
      this.validateKey(key);
      await this.checkQuota(key, value);
      
      const namespacedKey = this.getNamespacedKey(key);
      let finalValue = value;
      
      if (options?.ttl) {
        finalValue = {
          __value: value,
          __expiresAt: Date.now() + options.ttl,
          __metadata: options.metadata
        };
      }
      
      data[namespacedKey] = finalValue;
    }
    
    return new Promise((resolve, reject) => {
      this.area.set(data, () => {
        if (chrome.runtime.lastError) {
          reject(new StorageError(
            chrome.runtime.lastError.message || 'Failed to set values',
            'SET_MANY_ERROR'
          ));
          return;
        }
        
        // Notify watchers for each key
        items.forEach(({ key, value }) => {
          this.notifyWatchers({
            key,
            type: 'set',
            newValue: value,
            timestamp: new Date()
          });
        });
        
        resolve();
      });
    });
  }
  
  /**
   * Setup change listener
   */
  private setupChangeListener(): void {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== this.areaName) return;
      
      for (const [namespacedKey, change] of Object.entries(changes)) {
        if (!namespacedKey.startsWith(`${this.namespace}:`)) continue;
        
        const key = this.removeNamespace(namespacedKey);
        
        this.notifyWatchers({
          key,
          type: change.newValue === undefined ? 'delete' : 'set',
          oldValue: change.oldValue,
          newValue: change.newValue,
          timestamp: new Date()
        });
      }
    });
  }
  
  /**
   * Check storage quota
   */
  private async checkQuota(key: string, value: any): Promise<void> {
    if (this.areaName === 'sync') {
      // Chrome sync storage has strict quotas
      const valueSize = JSON.stringify(value).length;
      const keySize = key.length;
      
      // Per-item quota
      if (valueSize > 8192) { // 8KB per item
        throw new QuotaExceededError(
          'Value exceeds sync storage item limit (8KB)',
          valueSize,
          8192
        );
      }
      
      // Key length limit
      if (keySize > 128) {
        throw new StorageError(
          'Key exceeds sync storage limit (128 chars)',
          'KEY_TOO_LONG'
        );
      }
      
      // Check total quota
      const currentSize = await this.size();
      const totalQuota = 102400; // 100KB total
      
      if (currentSize + valueSize > totalQuota) {
        throw new QuotaExceededError(
          'Sync storage quota exceeded',
          currentSize + valueSize,
          totalQuota
        );
      }
    }
  }
  
  /**
   * Get storage info
   */
  async getInfo(): Promise<{
    quota: number;
    usage: number;
    area: string;
  }> {
    const usage = await this.size();
    
    let quota = Infinity;
    if (this.areaName === 'sync') {
      quota = 102400; // 100KB
    } else if (this.areaName === 'local') {
      // Local storage quota varies but is typically 5-10MB
      quota = 5242880; // 5MB conservative estimate
    }
    
    return { quota, usage, area: this.areaName };
  }
}