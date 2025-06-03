// Base adapter class with common functionality

import { EventEmitter } from 'eventemitter3';
import {
  StorageAdapter,
  SetOptions,
  TransactionOperation,
  WatchCallback,
  StorageChange,
  StorageError
} from '../core/types';

export abstract class BaseAdapter extends EventEmitter implements StorageAdapter {
  abstract readonly name: string;
  abstract readonly type: 'chrome' | 'indexeddb' | 'memory' | 'hybrid';
  
  protected watchers = new Map<string, Set<WatchCallback>>();
  protected namespace: string;
  
  constructor(namespace: string = 'default') {
    super();
    this.namespace = namespace;
  }
  
  abstract get<T = any>(key: string): Promise<T | null>;
  abstract set<T = any>(key: string, value: T, options?: SetOptions): Promise<void>;
  abstract delete(key: string): Promise<void>;
  abstract clear(): Promise<void>;
  abstract keys(): Promise<string[]>;
  abstract size(): Promise<number>;
  
  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }
  
  /**
   * Get multiple values
   */
  async getMany<T = any>(keys: string[]): Promise<Array<T | null>> {
    return Promise.all(keys.map(key => this.get<T>(key)));
  }
  
  /**
   * Set multiple values
   */
  async setMany(items: Array<{ key: string; value: any; options?: SetOptions }>): Promise<void> {
    await Promise.all(
      items.map(({ key, value, options }) => this.set(key, value, options))
    );
  }
  
  /**
   * Delete multiple keys
   */
  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.delete(key)));
  }
  
  /**
   * Execute transaction (default implementation)
   */
  async transaction(operations: TransactionOperation[]): Promise<void> {
    // Simple implementation - adapters can override for true transactions
    for (const op of operations) {
      switch (op.type) {
        case 'get':
          await this.get(op.key);
          break;
        case 'set':
          await this.set(op.key, op.value, op.options);
          break;
        case 'delete':
          await this.delete(op.key);
          break;
        case 'update':
          if (op.updateFn) {
            const current = await this.get(op.key);
            const updated = op.updateFn(current);
            await this.set(op.key, updated, op.options);
          }
          break;
      }
    }
  }
  
  /**
   * Watch for changes
   */
  watch(key: string, callback: WatchCallback): () => void {
    if (!this.watchers.has(key)) {
      this.watchers.set(key, new Set());
    }
    
    this.watchers.get(key)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.watchers.get(key);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.watchers.delete(key);
        }
      }
    };
  }
  
  /**
   * Notify watchers of changes
   */
  protected notifyWatchers(change: StorageChange): void {
    // Notify specific key watchers
    const keyWatchers = this.watchers.get(change.key);
    if (keyWatchers) {
      keyWatchers.forEach(callback => {
        try {
          callback(change);
        } catch (error) {
          console.error('Error in watch callback:', error);
        }
      });
    }
    
    // Notify wildcard watchers
    const wildcardWatchers = this.watchers.get('*');
    if (wildcardWatchers) {
      wildcardWatchers.forEach(callback => {
        try {
          callback(change);
        } catch (error) {
          console.error('Error in wildcard watch callback:', error);
        }
      });
    }
    
    // Emit change event
    this.emit('change', change);
  }
  
  /**
   * Generate namespaced key
   */
  protected getNamespacedKey(key: string): string {
    return `${this.namespace}:${key}`;
  }
  
  /**
   * Remove namespace from key
   */
  protected removeNamespace(key: string): string {
    const prefix = `${this.namespace}:`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }
  
  /**
   * Validate key format
   */
  protected validateKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new StorageError('Invalid key: must be a non-empty string', 'INVALID_KEY');
    }
    
    if (key.length > 250) {
      throw new StorageError('Key too long: maximum 250 characters', 'KEY_TOO_LONG');
    }
    
    if (!/^[a-zA-Z0-9._\-:]+$/.test(key)) {
      throw new StorageError(
        'Invalid key format: only alphanumeric, dots, underscores, hyphens, and colons allowed',
        'INVALID_KEY_FORMAT'
      );
    }
  }
  
  /**
   * Close adapter (cleanup)
   */
  async close(): Promise<void> {
    this.watchers.clear();
    this.removeAllListeners();
  }
}