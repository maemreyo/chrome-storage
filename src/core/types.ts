// Core type definitions for Chrome Storage package

import { z } from 'zod';

/**
 * Storage adapter interface - all adapters must implement this
 */
export interface StorageAdapter {
  readonly name: string;
  readonly type: 'chrome' | 'indexeddb' | 'memory' | 'hybrid';
  
  get<T = any>(key: string): Promise<T | null>;
  set<T = any>(key: string, value: T, options?: SetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  size(): Promise<number>;
  has(key: string): Promise<boolean>;
  
  // Batch operations
  getMany<T = any>(keys: string[]): Promise<Array<T | null>>;
  setMany(items: Array<{ key: string; value: any; options?: SetOptions }>): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  
  // Advanced features
  transaction?(operations: TransactionOperation[]): Promise<void>;
  watch?(key: string, callback: WatchCallback): () => void;
  close?(): Promise<void>;
}

/**
 * Storage configuration
 */
export interface StorageConfig {
  adapter?: 'auto' | 'chrome' | 'indexeddb' | 'memory' | 'hybrid';
  namespace?: string;
  
  encryption?: {
    enabled: boolean;
    key?: string;
    algorithm?: 'AES-GCM' | 'AES-CBC' | 'ChaCha20-Poly1305';
    keyDerivation?: 'PBKDF2' | 'Argon2';
  };
  
  compression?: {
    enabled: boolean;
    algorithm?: 'gzip' | 'lz4' | 'brotli';
    threshold?: number; // Min size in bytes to compress
    level?: number; // Compression level 1-9
  };
  
  cache?: {
    enabled: boolean;
    strategy?: 'lru' | 'lfu' | 'fifo' | 'ttl';
    maxSize?: number;
    maxMemory?: number;
    ttl?: number;
  };
  
  sync?: {
    enabled: boolean;
    interval?: number;
    conflictResolution?: 'local' | 'remote' | 'merge' | 'manual';
    providers?: Array<'chrome.sync' | 'firebase' | 'custom'>;
  };
  
  versioning?: {
    enabled: boolean;
    maxVersions?: number;
    autoCleanup?: boolean;
  };
  
  quota?: {
    maxSize?: number; // in MB
    warnAt?: number; // percentage
    enforceLimit?: boolean;
  };
  
  monitoring?: {
    enabled: boolean;
    performance?: boolean;
    errors?: boolean;
    usage?: boolean;
  };
  
  debug?: boolean;
}

/**
 * Storage item structure
 */
export interface StorageItem<T = any> {
  id: string;
  key: string;
  value: T;
  metadata: StorageMetadata;
  versions?: StorageVersion[];
}

/**
 * Storage metadata
 */
export interface StorageMetadata {
  created: Date;
  updated: Date;
  accessed?: Date;
  version: number;
  size: number;
  compressed: boolean;
  encrypted: boolean;
  checksum?: string;
  tags?: string[];
  ttl?: number;
  expiresAt?: Date;
}

/**
 * Storage version for versioning support
 */
export interface StorageVersion {
  version: number;
  timestamp: Date;
  size: number;
  checksum: string;
  author?: string;
  message?: string;
}

/**
 * Set operation options
 */
export interface SetOptions {
  ttl?: number;
  tags?: string[];
  encrypt?: boolean;
  compress?: boolean;
  metadata?: Record<string, any>;
  ifNotExists?: boolean;
  version?: number;
}

/**
 * Query options for advanced queries
 */
export interface QueryOptions {
  where?: WhereClause;
  orderBy?: OrderByClause;
  limit?: number;
  offset?: number;
  select?: string[];
  include?: string[];
  groupBy?: string[];
  having?: WhereClause;
}

/**
 * Where clause for queries
 */
export interface WhereClause {
  [field: string]: any | {
    $eq?: any;
    $ne?: any;
    $gt?: any;
    $gte?: any;
    $lt?: any;
    $lte?: any;
    $in?: any[];
    $nin?: any[];
    $contains?: string;
    $startsWith?: string;
    $endsWith?: string;
    $regex?: string | RegExp;
    $exists?: boolean;
    $type?: string;
    $size?: number;
    $all?: any[];
    $elemMatch?: WhereClause;
  };
}

/**
 * Order by clause
 */
export type OrderByClause = string | Array<string | [string, 'asc' | 'desc']>;

/**
 * Transaction operation
 */
export interface TransactionOperation {
  type: 'get' | 'set' | 'delete' | 'update';
  key: string;
  value?: any;
  options?: SetOptions;
  updateFn?: (current: any) => any;
}

/**
 * Watch callback
 */
export type WatchCallback = (change: StorageChange) => void;

/**
 * Storage change event
 */
export interface StorageChange {
  key: string;
  type: 'set' | 'delete' | 'clear';
  oldValue?: any;
  newValue?: any;
  timestamp: Date;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  totalSize: number;
  itemCount: number;
  quotaUsed: number;
  quotaAvailable: number;
  cacheSize?: number;
  cacheHitRate?: number;
  compressionRatio?: number;
  lastSync?: Date;
  lastBackup?: Date;
  adapterStats?: Record<string, any>;
}

/**
 * Bulk operation for batch processing
 */
export interface BulkOperation {
  type: 'set' | 'update' | 'delete';
  key: string;
  value?: any;
  updateFn?: (current: any) => any;
  options?: SetOptions;
}

/**
 * Import/Export options
 */
export interface ImportExportOptions {
  format: 'json' | 'csv' | 'sqlite' | 'xlsx' | 'xml';
  include?: string[] | RegExp;
  exclude?: string[] | RegExp;
  encrypted?: boolean;
  compressed?: boolean;
  pretty?: boolean;
  headers?: boolean; // For CSV
  sheetName?: string; // For Excel
}

/**
 * Migration definition
 */
export interface Migration {
  version: number;
  name: string;
  up: (storage: any) => Promise<void>;
  down: (storage: any) => Promise<void>;
  description?: string;
  timestamp?: Date;
}

/**
 * Schema definition using Zod
 */
export type StorageSchema<T = any> = z.ZodSchema<T>;

/**
 * Error types
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export class QuotaExceededError extends StorageError {
  constructor(message: string, public usage: number, public quota: number) {
    super(message, 'QUOTA_EXCEEDED', { usage, quota });
  }
}

export class EncryptionError extends StorageError {
  constructor(message: string, details?: any) {
    super(message, 'ENCRYPTION_ERROR', details);
  }
}

export class ValidationError extends StorageError {
  constructor(message: string, public errors: any[]) {
    super(message, 'VALIDATION_ERROR', { errors });
  }
}

/**
 * Events
 */
export interface StorageEvents {
  'change': (change: StorageChange) => void;
  'error': (error: StorageError) => void;
  'quota-warning': (usage: StorageStats) => void;
  'sync-start': () => void;
  'sync-complete': (result: any) => void;
  'sync-error': (error: Error) => void;
  'backup-created': (backup: any) => void;
  'migration-start': (version: number) => void;
  'migration-complete': (version: number) => void;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  operation: string;
  duration: number;
  timestamp: Date;
  metadata?: Record<string, any>;
}

/**
 * Cache statistics
 */
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

/**
 * Sync status
 */
export interface SyncStatus {
  lastSync: Date | null;
  nextSync: Date | null;
  inProgress: boolean;
  conflicts: number;
  pendingChanges: number;
  errors: Error[];
}

/**
 * Backup metadata
 */
export interface BackupMetadata {
  id: string;
  name: string;
  created: Date;
  size: number;
  itemCount: number;
  version: string;
  checksum: string;
  compressed: boolean;
  encrypted: boolean;
  incremental: boolean;
  baseBackup?: string;
  tags: string[];
}

/**
 * Session data structure
 */
export interface Session {
  id: string;
  userId?: string;
  startedAt: Date;
  lastActiveAt: Date;
  expiresAt?: Date;
  data: Record<string, any>;
  device?: {
    browser: string;
    os: string;
    screen: string;
  };
  activities: SessionActivity[];
}

/**
 * Session activity
 */
export interface SessionActivity {
  timestamp: Date;
  type: 'page_view' | 'action' | 'api_call' | 'error' | string;
  details: Record<string, any>;
}

/**
 * History item
 */
export interface HistoryItem {
  id: string;
  timestamp: Date;
  type: 'analysis' | 'fact_check' | 'search' | 'action' | 'view' | 'custom';
  title: string;
  description?: string;
  url?: string;
  data: Record<string, any>;
  metadata?: {
    duration?: number;
    status?: 'success' | 'failure' | 'pending';
    tags?: string[];
    source?: string;
  };
  groupId?: string;
}

/**
 * Settings structure
 */
export interface Settings {
  version: string;
  [key: string]: any;
}