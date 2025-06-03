// Main entry point for @matthew.ngo/chrome-storage package

// Core exports
export { AdvancedStorage } from './core/advanced-storage';
export { StorageManager, storageManager } from './core/storage-manager';
export * from './core/types';

// Adapter exports
export { BaseAdapter } from './adapters/base-adapter';
export { ChromeAdapter } from './adapters/chrome-adapter';
export { IndexedDBAdapter } from './adapters/indexeddb-adapter';
export { MemoryAdapter, memoryAdapter } from './adapters/memory-adapter';

// Service exports
export { SessionManager } from './services/session-manager';
export { HistoryManager } from './services/history-manager';
export { SettingsStore } from './services/settings-store';

// Cache exports
export { StorageCache } from './cache/storage-cache';

// Security exports
export { EncryptionService } from './security/encryption-service';

// Compression exports
export { CompressionService } from './compression/compression-service';

// Sync exports
export { SyncManager } from './sync/sync-manager';

// Query exports
export { QueryEngine } from './query/query-engine';

// Monitoring exports
export { MetricsCollector } from './monitoring/metrics-collector';

// Validation exports
export { SchemaValidator } from './validation/schema-validator';

// React exports (only if React is available)
export * from './react/hooks';

// Convenience exports for common use cases
import { storageManager } from './core/storage-manager';
import { AdvancedStorage } from './core/advanced-storage';
import { SessionManager } from './services/session-manager';
import { HistoryManager } from './services/history-manager';
import { SettingsStore } from './services/settings-store';

/**
 * Get or create default storage instance
 */
export function getStorage(name?: string): AdvancedStorage {
  return name ? storageManager.get(name) : storageManager.getDefault();
}

/**
 * Create storage with preset configuration
 */
export function createStorage(
  preset: 'minimal' | 'standard' | 'advanced' | 'secure',
  overrides?: any
): AdvancedStorage {
  return StorageManager.createWithPreset(preset, overrides);
}

/**
 * Create session manager for default storage
 */
export function createSessionManager(options?: any): SessionManager {
  return new SessionManager(storageManager.getDefault(), options);
}

/**
 * Create history manager for default storage
 */
export function createHistoryManager(options?: any): HistoryManager {
  return new HistoryManager(storageManager.getDefault(), options);
}

/**
 * Create settings store for default storage
 */
export function createSettingsStore(): SettingsStore {
  return new SettingsStore(storageManager.getDefault());
}

// Default export
export default {
  getStorage,
  createStorage,
  createSessionManager,
  createHistoryManager,
  createSettingsStore,
  storageManager
};