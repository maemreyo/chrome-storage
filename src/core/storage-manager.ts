// Storage manager singleton for managing multiple storage instances

import { AdvancedStorage } from './advanced-storage';
import { StorageConfig, StorageError } from './types';

export interface StorageInstance {
  name: string;
  storage: AdvancedStorage;
  config: StorageConfig;
  created: Date;
}

export class StorageManager {
  private static instance: StorageManager;
  private storages = new Map<string, StorageInstance>();
  private defaultStorage?: AdvancedStorage;
  
  private constructor() {}
  
  /**
   * Get singleton instance
   */
  static getInstance(): StorageManager {
    if (!StorageManager.instance) {
      StorageManager.instance = new StorageManager();
    }
    return StorageManager.instance;
  }
  
  /**
   * Create or get storage instance
   */
  create(name: string, config?: StorageConfig): AdvancedStorage {
    // Check if already exists
    if (this.storages.has(name)) {
      const existing = this.storages.get(name)!;
      
      // If config matches, return existing
      if (JSON.stringify(existing.config) === JSON.stringify(config)) {
        return existing.storage;
      }
      
      // Otherwise, throw error
      throw new StorageError(
        `Storage instance "${name}" already exists with different configuration`,
        'STORAGE_EXISTS'
      );
    }
    
    // Create new instance
    const storage = new AdvancedStorage(config);
    const instance: StorageInstance = {
      name,
      storage,
      config: config || {},
      created: new Date()
    };
    
    this.storages.set(name, instance);
    
    // Set as default if first instance
    if (!this.defaultStorage) {
      this.defaultStorage = storage;
    }
    
    return storage;
  }
  
  /**
   * Get storage instance by name
   */
  get(name?: string): AdvancedStorage {
    if (!name) {
      return this.getDefault();
    }
    
    const instance = this.storages.get(name);
    if (!instance) {
      throw new StorageError(
        `Storage instance "${name}" not found`,
        'STORAGE_NOT_FOUND'
      );
    }
    
    return instance.storage;
  }
  
  /**
   * Get default storage instance
   */
  getDefault(): AdvancedStorage {
    if (!this.defaultStorage) {
      this.defaultStorage = this.create('default');
    }
    return this.defaultStorage;
  }
  
  /**
   * Check if storage instance exists
   */
  has(name: string): boolean {
    return this.storages.has(name);
  }
  
  /**
   * List all storage instances
   */
  list(): StorageInstance[] {
    return Array.from(this.storages.values());
  }
  
  /**
   * Remove storage instance
   */
  async remove(name: string): Promise<void> {
    const instance = this.storages.get(name);
    if (!instance) {
      throw new StorageError(
        `Storage instance "${name}" not found`,
        'STORAGE_NOT_FOUND'
      );
    }
    
    // Close storage
    await instance.storage.close();
    
    // Remove from map
    this.storages.delete(name);
    
    // Update default if needed
    if (this.defaultStorage === instance.storage) {
      this.defaultStorage = this.storages.size > 0 
        ? this.storages.values().next().value.storage
        : undefined;
    }
  }
  
  /**
   * Remove all storage instances
   */
  async clear(): Promise<void> {
    // Close all storages
    for (const instance of this.storages.values()) {
      await instance.storage.close();
    }
    
    // Clear map
    this.storages.clear();
    this.defaultStorage = undefined;
  }
  
  /**
   * Get storage statistics for all instances
   */
  async getAllStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};
    
    for (const [name, instance] of this.storages) {
      try {
        stats[name] = await instance.storage.getStats();
      } catch (error) {
        stats[name] = { error: error.message };
      }
    }
    
    return stats;
  }
  
  /**
   * Set default storage instance
   */
  setDefault(name: string): void {
    const instance = this.storages.get(name);
    if (!instance) {
      throw new StorageError(
        `Storage instance "${name}" not found`,
        'STORAGE_NOT_FOUND'
      );
    }
    
    this.defaultStorage = instance.storage;
  }
  
  /**
   * Create storage with presets
   */
  static createWithPreset(
    preset: 'minimal' | 'standard' | 'advanced' | 'secure',
    overrides?: Partial<StorageConfig>
  ): AdvancedStorage {
    const presets: Record<string, StorageConfig> = {
      minimal: {
        cache: { enabled: false },
        encryption: { enabled: false },
        compression: { enabled: false },
        sync: { enabled: false },
        monitoring: { enabled: false }
      },
      standard: {
        cache: { enabled: true },
        encryption: { enabled: false },
        compression: { enabled: true },
        sync: { enabled: false },
        monitoring: { enabled: false }
      },
      advanced: {
        cache: { enabled: true },
        encryption: { enabled: false },
        compression: { enabled: true },
        sync: { enabled: true },
        monitoring: { enabled: true },
        versioning: { enabled: true }
      },
      secure: {
        cache: { enabled: true },
        encryption: { enabled: true, algorithm: 'AES-GCM' },
        compression: { enabled: true },
        sync: { enabled: true },
        monitoring: { enabled: true },
        versioning: { enabled: true }
      }
    };
    
    const config = { ...presets[preset], ...overrides };
    return StorageManager.getInstance().create(`${preset}_${Date.now()}`, config);
  }
}

// Export singleton instance
export const storageManager = StorageManager.getInstance();