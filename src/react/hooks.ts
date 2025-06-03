// React hooks for Chrome Storage

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AdvancedStorage } from '../core/advanced-storage';
import { StorageManager } from '../core/storage-manager';
import {
  StorageChange,
  SetOptions,
  QueryOptions,
  StorageStats,
  Session,
  HistoryItem,
  Settings,
  StorageError,
  SyncStatus
} from '../core/types';

// Get default storage instance
const getDefaultStorage = (): AdvancedStorage => {
  return StorageManager.getInstance().getDefault();
};

/**
 * Hook for basic storage operations
 */
export function useStorage<T = any>(
  key: string,
  defaultValue?: T,
  options?: {
    storage?: AdvancedStorage;
    syncToStorage?: boolean;
  }
): [T | undefined, (value: T | ((prev: T | undefined) => T)) => Promise<void>, boolean, Error | null] {
  const storage = options?.storage || getDefaultStorage();
  const [value, setValue] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const isMounted = useRef(true);
  
  // Load initial value
  useEffect(() => {
    let cancelled = false;
    
    const loadValue = async () => {
      try {
        setLoading(true);
        const stored = await storage.get<T>(key);
        
        if (!cancelled && isMounted.current) {
          setValue(stored !== null ? stored : defaultValue);
          setError(null);
        }
      } catch (err) {
        if (!cancelled && isMounted.current) {
          setError(err as Error);
          setValue(defaultValue);
        }
      } finally {
        if (!cancelled && isMounted.current) {
          setLoading(false);
        }
      }
    };
    
    loadValue();
    
    return () => {
      cancelled = true;
    };
  }, [key, storage]);
  
  // Subscribe to changes
  useEffect(() => {
    const unsubscribe = storage.watch(key, (change: StorageChange) => {
      if (isMounted.current) {
        setValue(change.newValue as T);
      }
    });
    
    return unsubscribe;
  }, [key, storage]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);
  
  // Update function
  const updateValue = useCallback(async (newValue: T | ((prev: T | undefined) => T)) => {
    try {
      const actualValue = typeof newValue === 'function'
        ? (newValue as (prev: T | undefined) => T)(value)
        : newValue;
      
      if (options?.syncToStorage !== false) {
        await storage.set(key, actualValue);
      }
      
      setValue(actualValue);
      setError(null);
    } catch (err) {
      setError(err as Error);
      throw err;
    }
  }, [key, storage, value, options?.syncToStorage]);
  
  return [value, updateValue, loading, error];
}

/**
 * Hook with automatic state synchronization
 */
export function useStorageState<T = any>(
  key: string,
  initialValue?: T,
  options?: SetOptions & { storage?: AdvancedStorage }
): {
  value: T | undefined;
  setValue: (value: T) => Promise<void>;
  loading: boolean;
  error: Error | null;
  remove: () => Promise<void>;
} {
  const storage = options?.storage || getDefaultStorage();
  const [value, setValue, loading, error] = useStorage<T>(key, initialValue, { storage });
  
  const remove = useCallback(async () => {
    try {
      await storage.delete(key);
      setValue(undefined as any);
    } catch (err) {
      throw err;
    }
  }, [key, storage, setValue]);
  
  const setValueWithOptions = useCallback(async (newValue: T) => {
    const { storage: _, ...setOptions } = options || {};
    await storage.set(key, newValue, setOptions);
    setValue(newValue);
  }, [key, storage, setValue, options]);
  
  return {
    value,
    setValue: setValueWithOptions,
    loading,
    error,
    remove
  };
}

/**
 * Hook for querying storage
 */
export function useStorageQuery<T = any>(
  queryOptions: QueryOptions,
  options?: {
    storage?: AdvancedStorage;
    refreshInterval?: number;
    enabled?: boolean;
  }
): {
  data: T[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  isRefetching: boolean;
} {
  const storage = options?.storage || getDefaultStorage();
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isRefetching, setIsRefetching] = useState(false);
  const enabled = options?.enabled !== false;
  
  const executeQuery = useCallback(async (isRefetch = false) => {
    if (!enabled) return;
    
    try {
      if (isRefetch) {
        setIsRefetching(true);
      } else {
        setLoading(true);
      }
      
      const results = await storage.query<T>(queryOptions);
      setData(results);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
      setIsRefetching(false);
    }
  }, [storage, queryOptions, enabled]);
  
  // Initial query
  useEffect(() => {
    executeQuery();
  }, [executeQuery]);
  
  // Refresh interval
  useEffect(() => {
    if (!options?.refreshInterval || !enabled) return;
    
    const interval = setInterval(() => {
      executeQuery(true);
    }, options.refreshInterval);
    
    return () => clearInterval(interval);
  }, [options?.refreshInterval, executeQuery, enabled]);
  
  const refetch = useCallback(() => executeQuery(true), [executeQuery]);
  
  return { data, loading, error, refetch, isRefetching };
}

/**
 * Hook for storage synchronization
 */
export function useStorageSync(options?: {
  storage?: AdvancedStorage;
  onSync?: (result: any) => void;
  onError?: (error: Error) => void;
}): {
  status: SyncStatus;
  sync: () => Promise<void>;
  isSyncing: boolean;
} {
  const storage = options?.storage || getDefaultStorage();
  const [status, setStatus] = useState<SyncStatus>({
    lastSync: null,
    nextSync: null,
    inProgress: false,
    conflicts: 0,
    pendingChanges: 0,
    errors: []
  });
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Update status periodically
  useEffect(() => {
    const updateStatus = () => {
      const syncManager = (storage as any).sync;
      if (syncManager) {
        setStatus(syncManager.getStatus());
      }
    };
    
    updateStatus();
    const interval = setInterval(updateStatus, 1000);
    
    return () => clearInterval(interval);
  }, [storage]);
  
  const sync = useCallback(async () => {
    try {
      setIsSyncing(true);
      const syncManager = (storage as any).sync;
      
      if (syncManager) {
        await syncManager.syncNow();
        options?.onSync?.(true);
      }
    } catch (error) {
      options?.onError?.(error as Error);
      throw error;
    } finally {
      setIsSyncing(false);
    }
  }, [storage, options]);
  
  return { status, sync, isSyncing };
}

/**
 * Hook for storage statistics
 */
export function useStorageStats(
  options?: {
    storage?: AdvancedStorage;
    refreshInterval?: number;
  }
): {
  stats: StorageStats | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const storage = options?.storage || getDefaultStorage();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  
  const loadStats = useCallback(async () => {
    try {
      setLoading(true);
      const currentStats = await storage.getStats();
      setStats(currentStats);
    } catch (error) {
      console.error('Failed to load storage stats:', error);
    } finally {
      setLoading(false);
    }
  }, [storage]);
  
  useEffect(() => {
    loadStats();
    
    if (options?.refreshInterval) {
      const interval = setInterval(loadStats, options.refreshInterval);
      return () => clearInterval(interval);
    }
  }, [loadStats, options?.refreshInterval]);
  
  return { stats, loading, refresh: loadStats };
}

/**
 * Hook for session management
 */
export function useSession(options?: {
  storage?: AdvancedStorage;
  autoStart?: boolean;
}): {
  session: Session | null;
  isActive: boolean;
  startSession: (userId?: string, data?: any) => Promise<Session>;
  endSession: (reason?: string) => Promise<void>;
  updateSession: (data: any) => Promise<void>;
  trackActivity: (type: string, details?: any) => void;
} {
  const storage = options?.storage || getDefaultStorage();
  const [session, setSession] = useState<Session | null>(null);
  const [isActive, setIsActive] = useState(false);
  
  // Session manager methods would be implemented here
  // This is a simplified version
  
  const startSession = useCallback(async (userId?: string, data?: any): Promise<Session> => {
    const newSession: Session = {
      id: `session_${Date.now()}`,
      userId,
      startedAt: new Date(),
      lastActiveAt: new Date(),
      data: data || {},
      activities: []
    };
    
    await storage.set('__current_session__', newSession);
    setSession(newSession);
    setIsActive(true);
    
    return newSession;
  }, [storage]);
  
  const endSession = useCallback(async (reason?: string) => {
    if (session) {
      await storage.set(`__session_archive_${session.id}`, {
        ...session,
        endedAt: new Date(),
        endReason: reason
      });
      await storage.delete('__current_session__');
    }
    
    setSession(null);
    setIsActive(false);
  }, [storage, session]);
  
  const updateSession = useCallback(async (data: any) => {
    if (!session) throw new Error('No active session');
    
    const updated = {
      ...session,
      data: { ...session.data, ...data },
      lastActiveAt: new Date()
    };
    
    await storage.set('__current_session__', updated);
    setSession(updated);
  }, [storage, session]);
  
  const trackActivity = useCallback((type: string, details?: any) => {
    if (!session) return;
    
    const activity = {
      timestamp: new Date(),
      type,
      details
    };
    
    const updated = {
      ...session,
      activities: [...session.activities, activity],
      lastActiveAt: new Date()
    };
    
    storage.set('__current_session__', updated).then(() => {
      setSession(updated);
    });
  }, [storage, session]);
  
  // Load current session on mount
  useEffect(() => {
    const loadSession = async () => {
      const current = await storage.get<Session>('__current_session__');
      if (current) {
        setSession(current);
        setIsActive(true);
      } else if (options?.autoStart) {
        startSession();
      }
    };
    
    loadSession();
  }, [storage, options?.autoStart]);
  
  return {
    session,
    isActive,
    startSession,
    endSession,
    updateSession,
    trackActivity
  };
}

/**
 * Hook for history management
 */
export function useHistory(options?: {
  storage?: AdvancedStorage;
  limit?: number;
  types?: HistoryItem['type'][];
}): {
  items: HistoryItem[];
  loading: boolean;
  addItem: (item: Omit<HistoryItem, 'id' | 'timestamp'>) => Promise<void>;
  clearHistory: () => Promise<void>;
  searchHistory: (query: string) => Promise<HistoryItem[]>;
} {
  const storage = options?.storage || getDefaultStorage();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  
  const loadHistory = useCallback(async () => {
    try {
      setLoading(true);
      const keys = await storage.keys();
      const historyKeys = keys.filter(k => k.startsWith('__history_'));
      
      const historyItems: HistoryItem[] = [];
      for (const key of historyKeys) {
        const item = await storage.get<HistoryItem>(key);
        if (item && (!options?.types || options.types.includes(item.type))) {
          historyItems.push(item);
        }
      }
      
      // Sort by timestamp descending
      historyItems.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      
      // Apply limit
      const limited = options?.limit 
        ? historyItems.slice(0, options.limit)
        : historyItems;
      
      setItems(limited);
    } catch (error) {
      console.error('Failed to load history:', error);
    } finally {
      setLoading(false);
    }
  }, [storage, options?.types, options?.limit]);
  
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);
  
  const addItem = useCallback(async (item: Omit<HistoryItem, 'id' | 'timestamp'>) => {
    const historyItem: HistoryItem = {
      ...item,
      id: `history_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    };
    
    await storage.set(`__history_${historyItem.id}`, historyItem);
    await loadHistory();
  }, [storage, loadHistory]);
  
  const clearHistory = useCallback(async () => {
    const keys = await storage.keys();
    const historyKeys = keys.filter(k => k.startsWith('__history_'));
    
    for (const key of historyKeys) {
      await storage.delete(key);
    }
    
    setItems([]);
  }, [storage]);
  
  const searchHistory = useCallback(async (query: string): Promise<HistoryItem[]> => {
    const lowerQuery = query.toLowerCase();
    
    return items.filter(item => 
      item.title.toLowerCase().includes(lowerQuery) ||
      item.description?.toLowerCase().includes(lowerQuery) ||
      JSON.stringify(item.data).toLowerCase().includes(lowerQuery)
    );
  }, [items]);
  
  return {
    items,
    loading,
    addItem,
    clearHistory,
    searchHistory
  };
}

/**
 * Hook for settings management
 */
export function useSettings<T = Settings>(
  key?: string,
  options?: {
    storage?: AdvancedStorage;
    schema?: any; // Zod schema
  }
): {
  settings: T | null;
  loading: boolean;
  update: (updates: Partial<T>) => Promise<void>;
  reset: () => Promise<void>;
  subscribe: (callback: (settings: T) => void) => () => void;
} {
  const storage = options?.storage || getDefaultStorage();
  const settingsKey = key || '__app_settings__';
  const [settings, setSettings] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  
  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const stored = await storage.get<T>(settingsKey);
      setSettings(stored);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  }, [storage, settingsKey]);
  
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);
  
  const update = useCallback(async (updates: Partial<T>) => {
    const current = settings || {} as T;
    const updated = { ...current, ...updates };
    
    // Validate if schema provided
    if (options?.schema) {
      try {
        options.schema.parse(updated);
      } catch (error) {
        throw new ValidationError('Settings validation failed', error);
      }
    }
    
    await storage.set(settingsKey, updated);
    setSettings(updated);
  }, [storage, settingsKey, settings, options?.schema]);
  
  const reset = useCallback(async () => {
    await storage.delete(settingsKey);
    setSettings(null);
  }, [storage, settingsKey]);
  
  const subscribe = useCallback((callback: (settings: T) => void) => {
    const unsubscribe = storage.watch(settingsKey, (change) => {
      if (change.newValue) {
        setSettings(change.newValue as T);
        callback(change.newValue as T);
      }
    });
    
    return unsubscribe;
  }, [storage, settingsKey]);
  
  return {
    settings,
    loading,
    update,
    reset,
    subscribe
  };
}

/**
 * Hook for optimistic updates
 */
export function useOptimisticStorage<T = any>(
  key: string,
  defaultValue?: T,
  options?: {
    storage?: AdvancedStorage;
    onError?: (error: Error, rollbackValue: T | undefined) => void;
  }
): {
  value: T | undefined;
  optimisticValue: T | undefined;
  update: (value: T) => Promise<void>;
  isUpdating: boolean;
  error: Error | null;
} {
  const storage = options?.storage || getDefaultStorage();
  const [value, setValue] = useState<T | undefined>(undefined);
  const [optimisticValue, setOptimisticValue] = useState<T | undefined>(undefined);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  // Load initial value
  useEffect(() => {
    storage.get<T>(key).then(stored => {
      const initial = stored !== null ? stored : defaultValue;
      setValue(initial);
      setOptimisticValue(initial);
    });
  }, [key, storage, defaultValue]);
  
  const update = useCallback(async (newValue: T) => {
    const previousValue = value;
    
    try {
      // Optimistic update
      setOptimisticValue(newValue);
      setIsUpdating(true);
      setError(null);
      
      // Actual update
      await storage.set(key, newValue);
      setValue(newValue);
    } catch (err) {
      // Rollback on error
      setOptimisticValue(previousValue);
      setError(err as Error);
      options?.onError?.(err as Error, previousValue);
      throw err;
    } finally {
      setIsUpdating(false);
    }
  }, [key, storage, value, options]);
  
  return {
    value,
    optimisticValue,
    update,
    isUpdating,
    error
  };
}