// Cross-context synchronization manager

import { EventEmitter } from 'eventemitter3';
import { StorageChange, SyncStatus, StorageError } from '../core/types';
import Debug from 'debug';

const debug = Debug('chrome-storage:sync');

export interface SyncConfig {
  enabled: boolean;
  interval?: number;
  conflictResolution?: 'local' | 'remote' | 'merge' | 'manual';
  providers?: Array<'chrome.sync' | 'firebase' | 'custom'>;
  customProvider?: SyncProvider;
}

export interface SyncProvider {
  name: string;
  sync(changes: SyncChange[]): Promise<SyncResult>;
  pull(): Promise<SyncChange[]>;
  resolve(conflict: SyncConflict): Promise<any>;
}

export interface SyncChange {
  key: string;
  type: 'set' | 'delete' | 'clear';
  value?: any;
  timestamp: Date;
  source: string;
  version?: number;
}

export interface SyncResult {
  success: boolean;
  synced: number;
  conflicts: SyncConflict[];
  errors: Error[];
}

export interface SyncConflict {
  key: string;
  localValue: any;
  remoteValue: any;
  localTimestamp: Date;
  remoteTimestamp: Date;
  resolution?: 'local' | 'remote' | 'merged';
  mergedValue?: any;
}

export class SyncManager extends EventEmitter {
  private storage: any; // Reference to AdvancedStorage
  private config: Required<SyncConfig>;
  private syncTimer?: NodeJS.Timer;
  private pendingChanges: Map<string, SyncChange> = new Map();
  private syncing = false;
  private lastSyncTime?: Date;
  private providers: Map<string, SyncProvider> = new Map();
  
  constructor(storage: any, config: SyncConfig) {
    super();
    
    this.storage = storage;
    this.config = {
      enabled: config.enabled || false,
      interval: config.interval || 300000, // 5 minutes
      conflictResolution: config.conflictResolution || 'local',
      providers: config.providers || ['chrome.sync'],
      customProvider: config.customProvider
    };
    
    this.initializeProviders();
  }
  
  /**
   * Start sync process
   */
  start(): void {
    if (!this.config.enabled) return;
    
    debug('Starting sync manager');
    
    // Initial sync
    this.sync().catch(error => {
      debug('Initial sync failed:', error);
      this.emit('sync-error', error);
    });
    
    // Start periodic sync
    this.syncTimer = setInterval(() => {
      this.sync().catch(error => {
        debug('Periodic sync failed:', error);
        this.emit('sync-error', error);
      });
    }, this.config.interval);
    
    // Listen for storage changes
    this.setupChangeListener();
  }
  
  /**
   * Stop sync process
   */
  stop(): void {
    debug('Stopping sync manager');
    
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    
    // Final sync
    this.sync().catch(console.error);
  }
  
  /**
   * Queue change for sync
   */
  queueChange(key: string, type: 'set' | 'delete' | 'clear', value?: any): void {
    const change: SyncChange = {
      key,
      type,
      value,
      timestamp: new Date(),
      source: this.getSourceId()
    };
    
    this.pendingChanges.set(key, change);
    
    // Trigger sync if enough changes
    if (this.pendingChanges.size >= 10) {
      this.sync().catch(error => {
        debug('Batch sync failed:', error);
        this.emit('sync-error', error);
      });
    }
  }
  
  /**
   * Perform sync
   */
  async sync(): Promise<void> {
    if (this.syncing || !this.config.enabled) return;
    
    this.syncing = true;
    this.emit('sync-start');
    
    try {
      const results: SyncResult[] = [];
      
      // Sync with each provider
      for (const [name, provider] of this.providers) {
        try {
          const result = await this.syncWithProvider(provider);
          results.push(result);
        } catch (error) {
          debug(`Sync with ${name} failed:`, error);
          results.push({
            success: false,
            synced: 0,
            conflicts: [],
            errors: [error as Error]
          });
        }
      }
      
      // Combine results
      const combinedResult = this.combineResults(results);
      
      // Handle conflicts
      if (combinedResult.conflicts.length > 0) {
        await this.resolveConflicts(combinedResult.conflicts);
      }
      
      this.lastSyncTime = new Date();
      this.emit('sync-complete', combinedResult);
      
    } finally {
      this.syncing = false;
    }
  }
  
  /**
   * Get sync status
   */
  getStatus(): SyncStatus {
    const nextSync = this.lastSyncTime && this.config.interval
      ? new Date(this.lastSyncTime.getTime() + this.config.interval)
      : null;
    
    return {
      lastSync: this.lastSyncTime || null,
      nextSync,
      inProgress: this.syncing,
      conflicts: 0, // TODO: Track unresolved conflicts
      pendingChanges: this.pendingChanges.size,
      errors: []
    };
  }
  
  /**
   * Get last sync time
   */
  getLastSyncTime(): Date | undefined {
    return this.lastSyncTime;
  }
  
  /**
   * Force sync now
   */
  async syncNow(): Promise<void> {
    return this.sync();
  }
  
  // Private methods
  
  private initializeProviders(): void {
    for (const providerName of this.config.providers) {
      switch (providerName) {
        case 'chrome.sync':
          this.providers.set('chrome.sync', new ChromeSyncProvider());
          break;
        case 'firebase':
          // TODO: Implement Firebase provider
          debug('Firebase provider not implemented yet');
          break;
        case 'custom':
          if (this.config.customProvider) {
            this.providers.set('custom', this.config.customProvider);
          }
          break;
      }
    }
  }
  
  private async syncWithProvider(provider: SyncProvider): Promise<SyncResult> {
    // Get pending changes
    const changes = Array.from(this.pendingChanges.values());
    
    // Push changes
    const pushResult = await provider.sync(changes);
    
    // Pull remote changes
    const remoteChanges = await provider.pull();
    
    // Apply remote changes
    const conflicts = await this.applyRemoteChanges(remoteChanges);
    
    // Clear successfully synced changes
    if (pushResult.success) {
      this.pendingChanges.clear();
    }
    
    return {
      success: pushResult.success,
      synced: pushResult.synced + remoteChanges.length,
      conflicts: [...pushResult.conflicts, ...conflicts],
      errors: pushResult.errors
    };
  }
  
  private async applyRemoteChanges(changes: SyncChange[]): Promise<SyncConflict[]> {
    const conflicts: SyncConflict[] = [];
    
    for (const change of changes) {
      try {
        // Check for conflicts
        const localValue = await this.storage.get(change.key);
        const hasConflict = localValue !== null && change.type === 'set';
        
        if (hasConflict) {
          conflicts.push({
            key: change.key,
            localValue,
            remoteValue: change.value,
            localTimestamp: new Date(), // TODO: Track local timestamps
            remoteTimestamp: change.timestamp
          });
        } else {
          // Apply change
          switch (change.type) {
            case 'set':
              await this.storage.set(change.key, change.value, { skipSync: true });
              break;
            case 'delete':
              await this.storage.delete(change.key, { skipSync: true });
              break;
            case 'clear':
              await this.storage.clear({ skipSync: true });
              break;
          }
        }
      } catch (error) {
        debug('Failed to apply remote change:', error);
      }
    }
    
    return conflicts;
  }
  
  private async resolveConflicts(conflicts: SyncConflict[]): Promise<void> {
    for (const conflict of conflicts) {
      try {
        switch (this.config.conflictResolution) {
          case 'local':
            // Keep local value
            conflict.resolution = 'local';
            break;
            
          case 'remote':
            // Use remote value
            await this.storage.set(conflict.key, conflict.remoteValue, { skipSync: true });
            conflict.resolution = 'remote';
            break;
            
          case 'merge':
            // Attempt to merge
            const merged = await this.mergeValues(conflict.localValue, conflict.remoteValue);
            await this.storage.set(conflict.key, merged, { skipSync: true });
            conflict.resolution = 'merged';
            conflict.mergedValue = merged;
            break;
            
          case 'manual':
            // Emit event for manual resolution
            this.emit('conflict', conflict);
            break;
        }
      } catch (error) {
        debug('Failed to resolve conflict:', error);
      }
    }
  }
  
  private async mergeValues(local: any, remote: any): Promise<any> {
    // Simple merge strategy - can be customized
    if (typeof local === 'object' && typeof remote === 'object') {
      // Merge objects
      return { ...remote, ...local };
    } else if (Array.isArray(local) && Array.isArray(remote)) {
      // Combine arrays and remove duplicates
      return [...new Set([...local, ...remote])];
    } else {
      // Can't merge - use local
      return local;
    }
  }
  
  private combineResults(results: SyncResult[]): SyncResult {
    return {
      success: results.every(r => r.success),
      synced: results.reduce((sum, r) => sum + r.synced, 0),
      conflicts: results.flatMap(r => r.conflicts),
      errors: results.flatMap(r => r.errors)
    };
  }
  
  private setupChangeListener(): void {
    // Listen for storage changes that should be synced
    this.storage.on('change', (change: StorageChange) => {
      // Skip if change came from sync
      if ((change as any).skipSync) return;
      
      this.queueChange(change.key, change.type as any, change.newValue);
    });
  }
  
  private getSourceId(): string {
    // Generate unique source ID for this instance
    return `${chrome?.runtime?.id || 'unknown'}_${Date.now()}`;
  }
}

/**
 * Chrome sync storage provider
 */
class ChromeSyncProvider implements SyncProvider {
  readonly name = 'chrome.sync';
  
  async sync(changes: SyncChange[]): Promise<SyncResult> {
    if (!chrome?.storage?.sync) {
      return {
        success: false,
        synced: 0,
        conflicts: [],
        errors: [new Error('Chrome sync storage not available')]
      };
    }
    
    let synced = 0;
    const errors: Error[] = [];
    
    for (const change of changes) {
      try {
        const syncKey = `sync_${change.key}`;
        
        switch (change.type) {
          case 'set':
            await this.setItem(syncKey, {
              value: change.value,
              timestamp: change.timestamp.toISOString(),
              source: change.source
            });
            break;
          case 'delete':
            await this.removeItem(syncKey);
            break;
        }
        
        synced++;
      } catch (error) {
        errors.push(error as Error);
      }
    }
    
    return {
      success: errors.length === 0,
      synced,
      conflicts: [],
      errors
    };
  }
  
  async pull(): Promise<SyncChange[]> {
    if (!chrome?.storage?.sync) {
      return [];
    }
    
    const items = await this.getAllItems();
    const changes: SyncChange[] = [];
    
    for (const [key, data] of Object.entries(items)) {
      if (key.startsWith('sync_')) {
        const actualKey = key.slice(5);
        changes.push({
          key: actualKey,
          type: 'set',
          value: data.value,
          timestamp: new Date(data.timestamp),
          source: data.source
        });
      }
    }
    
    return changes;
  }
  
  async resolve(conflict: SyncConflict): Promise<any> {
    // Chrome sync doesn't have built-in conflict resolution
    return conflict.localValue;
  }
  
  private setItem(key: string, value: any): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
  
  private removeItem(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.remove(key, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
  
  private getAllItems(): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get(null, (items) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(items);
        }
      });
    });
  }
}