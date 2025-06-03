// IndexedDB adapter using Dexie

import Dexie, { Table } from 'dexie';
import { BaseAdapter } from './base-adapter';
import {
  SetOptions,
  StorageChange,
  StorageError,
  TransactionOperation
} from '../core/types';

interface StorageRecord {
  id?: number;
  key: string;
  value: any;
  metadata?: any;
  expiresAt?: number;
  created: number;
  updated: number;
}

export interface IndexedDBAdapterOptions {
  dbName?: string;
  version?: number;
  namespace?: string;
  indexes?: string[];
}

export class IndexedDBAdapter extends BaseAdapter {
  readonly name = 'IndexedDBAdapter';
  readonly type = 'indexeddb' as const;
  
  private db: Dexie;
  private table: Table<StorageRecord, number>;
  private tableName: string;
  
  constructor(options: IndexedDBAdapterOptions = {}) {
    super(options.namespace);
    
    const dbName = options.dbName || 'ChromeStorageDB';
    this.tableName = `storage_${this.namespace}`;
    
    // Initialize Dexie
    this.db = new Dexie(dbName);
    
    // Define schema
    const schema: Record<string, string> = {};
    const indexes = ['++id', 'key', 'created', 'updated'];
    
    if (options.indexes) {
      indexes.push(...options.indexes);
    }
    
    schema[this.tableName] = indexes.join(',');
    
    this.db.version(options.version || 1).stores(schema);
    
    this.table = this.db.table(this.tableName);
    
    // Setup cleanup timer for expired items
    this.startCleanupTimer();
  }
  
  /**
   * Get value by key
   */
  async get<T = any>(key: string): Promise<T | null> {
    this.validateKey(key);
    
    try {
      const record = await this.table.where('key').equals(key).first();
      
      if (!record) {
        return null;
      }
      
      // Check expiration
      if (record.expiresAt && Date.now() > record.expiresAt) {
        await this.delete(key);
        return null;
      }
      
      return record.value as T;
    } catch (error) {
      throw new StorageError(
        `Failed to get value: ${error.message}`,
        'GET_ERROR',
        error
      );
    }
  }
  
  /**
   * Set value
   */
  async set<T = any>(key: string, value: T, options?: SetOptions): Promise<void> {
    this.validateKey(key);
    
    try {
      const now = Date.now();
      const oldRecord = await this.table.where('key').equals(key).first();
      
      const record: StorageRecord = {
        key,
        value,
        metadata: options?.metadata,
        expiresAt: options?.ttl ? now + options.ttl : undefined,
        created: oldRecord?.created || now,
        updated: now
      };
      
      if (oldRecord) {
        record.id = oldRecord.id;
        await this.table.update(oldRecord.id!, record);
      } else {
        await this.table.add(record);
      }
      
      // Notify watchers
      this.notifyWatchers({
        key,
        type: 'set',
        oldValue: oldRecord?.value,
        newValue: value,
        timestamp: new Date()
      });
    } catch (error) {
      throw new StorageError(
        `Failed to set value: ${error.message}`,
        'SET_ERROR',
        error
      );
    }
  }
  
  /**
   * Delete key
   */
  async delete(key: string): Promise<void> {
    this.validateKey(key);
    
    try {
      const record = await this.table.where('key').equals(key).first();
      
      if (record) {
        await this.table.delete(record.id!);
        
        // Notify watchers
        this.notifyWatchers({
          key,
          type: 'delete',
          oldValue: record.value,
          timestamp: new Date()
        });
      }
    } catch (error) {
      throw new StorageError(
        `Failed to delete value: ${error.message}`,
        'DELETE_ERROR',
        error
      );
    }
  }
  
  /**
   * Clear all storage
   */
  async clear(): Promise<void> {
    try {
      // Get all keys first for notifications
      const records = await this.table.toArray();
      
      await this.table.clear();
      
      // Notify watchers
      records.forEach(record => {
        this.notifyWatchers({
          key: record.key,
          type: 'delete',
          oldValue: record.value,
          timestamp: new Date()
        });
      });
      
      this.notifyWatchers({
        key: '*',
        type: 'clear',
        timestamp: new Date()
      });
    } catch (error) {
      throw new StorageError(
        `Failed to clear storage: ${error.message}`,
        'CLEAR_ERROR',
        error
      );
    }
  }
  
  /**
   * Get all keys
   */
  async keys(): Promise<string[]> {
    try {
      const records = await this.table.toArray();
      return records.map(r => r.key);
    } catch (error) {
      throw new StorageError(
        `Failed to get keys: ${error.message}`,
        'KEYS_ERROR',
        error
      );
    }
  }
  
  /**
   * Get storage size
   */
  async size(): Promise<number> {
    try {
      const records = await this.table.toArray();
      const size = records.reduce((total, record) => {
        const recordSize = new Blob([JSON.stringify(record)]).size;
        return total + recordSize;
      }, 0);
      
      return size;
    } catch (error) {
      throw new StorageError(
        `Failed to get size: ${error.message}`,
        'SIZE_ERROR',
        error
      );
    }
  }
  
  /**
   * Execute transaction
   */
  async transaction(operations: TransactionOperation[]): Promise<void> {
    try {
      await this.db.transaction('rw', this.table, async () => {
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
      });
    } catch (error) {
      throw new StorageError(
        `Transaction failed: ${error.message}`,
        'TRANSACTION_ERROR',
        error
      );
    }
  }
  
  /**
   * Get multiple values (optimized)
   */
  async getMany<T = any>(keys: string[]): Promise<Array<T | null>> {
    try {
      const records = await this.table.where('key').anyOf(keys).toArray();
      const recordMap = new Map(records.map(r => [r.key, r]));
      
      return keys.map(key => {
        const record = recordMap.get(key);
        
        if (!record) {
          return null;
        }
        
        // Check expiration
        if (record.expiresAt && Date.now() > record.expiresAt) {
          this.delete(key).catch(console.error);
          return null;
        }
        
        return record.value as T;
      });
    } catch (error) {
      throw new StorageError(
        `Failed to get multiple values: ${error.message}`,
        'GET_MANY_ERROR',
        error
      );
    }
  }
  
  /**
   * Set multiple values (optimized)
   */
  async setMany(items: Array<{ key: string; value: any; options?: SetOptions }>): Promise<void> {
    try {
      await this.db.transaction('rw', this.table, async () => {
        const now = Date.now();
        
        for (const { key, value, options } of items) {
          this.validateKey(key);
          
          const oldRecord = await this.table.where('key').equals(key).first();
          
          const record: StorageRecord = {
            key,
            value,
            metadata: options?.metadata,
            expiresAt: options?.ttl ? now + options.ttl : undefined,
            created: oldRecord?.created || now,
            updated: now
          };
          
          if (oldRecord) {
            record.id = oldRecord.id;
            await this.table.update(oldRecord.id!, record);
          } else {
            await this.table.add(record);
          }
          
          // Notify watchers
          this.notifyWatchers({
            key,
            type: 'set',
            oldValue: oldRecord?.value,
            newValue: value,
            timestamp: new Date()
          });
        }
      });
    } catch (error) {
      throw new StorageError(
        `Failed to set multiple values: ${error.message}`,
        'SET_MANY_ERROR',
        error
      );
    }
  }
  
  /**
   * Delete multiple keys (optimized)
   */
  async deleteMany(keys: string[]): Promise<void> {
    try {
      await this.db.transaction('rw', this.table, async () => {
        const records = await this.table.where('key').anyOf(keys).toArray();
        const ids = records.map(r => r.id!);
        
        await this.table.bulkDelete(ids);
        
        // Notify watchers
        records.forEach(record => {
          this.notifyWatchers({
            key: record.key,
            type: 'delete',
            oldValue: record.value,
            timestamp: new Date()
          });
        });
      });
    } catch (error) {
      throw new StorageError(
        `Failed to delete multiple values: ${error.message}`,
        'DELETE_MANY_ERROR',
        error
      );
    }
  }
  
  /**
   * Query records
   */
  async query(options: {
    filter?: (record: StorageRecord) => boolean;
    sort?: keyof StorageRecord;
    limit?: number;
    offset?: number;
  }): Promise<StorageRecord[]> {
    try {
      let collection = this.table.toCollection();
      
      if (options.filter) {
        collection = collection.filter(options.filter);
      }
      
      if (options.sort) {
        collection = collection.sortBy(options.sort as string);
      }
      
      if (options.offset) {
        collection = collection.offset(options.offset);
      }
      
      if (options.limit) {
        collection = collection.limit(options.limit);
      }
      
      return await collection.toArray();
    } catch (error) {
      throw new StorageError(
        `Query failed: ${error.message}`,
        'QUERY_ERROR',
        error
      );
    }
  }
  
  /**
   * Cleanup expired items
   */
  private async cleanup(): Promise<void> {
    try {
      const now = Date.now();
      const expired = await this.table
        .where('expiresAt')
        .below(now)
        .toArray();
      
      if (expired.length > 0) {
        const ids = expired.map(r => r.id!);
        await this.table.bulkDelete(ids);
        
        // Notify watchers
        expired.forEach(record => {
          this.notifyWatchers({
            key: record.key,
            type: 'delete',
            oldValue: record.value,
            timestamp: new Date()
          });
        });
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }
  
  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    // Run cleanup every minute
    setInterval(() => {
      this.cleanup().catch(console.error);
    }, 60000);
    
    // Run initial cleanup
    this.cleanup().catch(console.error);
  }
  
  /**
   * Close database
   */
  async close(): Promise<void> {
    await super.close();
    this.db.close();
  }
  
  /**
   * Get database info
   */
  async getInfo(): Promise<{
    recordCount: number;
    size: number;
    oldestRecord?: Date;
    newestRecord?: Date;
  }> {
    const records = await this.table.toArray();
    const size = await this.size();
    
    let oldestRecord: Date | undefined;
    let newestRecord: Date | undefined;
    
    if (records.length > 0) {
      const sorted = records.sort((a, b) => a.created - b.created);
      oldestRecord = new Date(sorted[0].created);
      newestRecord = new Date(sorted[sorted.length - 1].created);
    }
    
    return {
      recordCount: records.length,
      size,
      oldestRecord,
      newestRecord
    };
  }
}