# @chrome-storage/core

Advanced storage solution for Chrome extensions with encryption, compression, sync, and enterprise features.

## Features

- 🔐 **Enterprise-grade Security** - AES-GCM, ChaCha20-Poly1305 encryption
- 🗜️ **Smart Compression** - Automatic compression with multiple algorithms
- 🔄 **Cross-context Sync** - Real-time synchronization across extension contexts
- 📊 **Advanced Querying** - SQL-like queries with full-text search
- 💾 **Multi-adapter Support** - Chrome Storage, IndexedDB, Memory
- ⚡ **High Performance** - Multi-level caching with LRU/LFU strategies
- 🔍 **Session Tracking** - Automatic session and activity monitoring
- 📝 **History Management** - Searchable history with timeline view
- ⚙️ **Settings Management** - Type-safe settings with schema validation
- 📈 **Performance Monitoring** - Built-in metrics and analytics

## Installation

```bash
npm install @chrome-storage/core
# or
yarn add @chrome-storage/core
# or
pnpm add @chrome-storage/core
```

## Quick Start

```typescript
import { getStorage } from '@chrome-storage/core';

// Get default storage instance
const storage = getStorage();

// Store data
await storage.set('user', { 
  name: 'John Doe', 
  email: 'john@example.com' 
});

// Retrieve data
const user = await storage.get('user');

// Delete data
await storage.delete('user');
```

## Core Concepts

### Storage Adapters

The library supports multiple storage backends with automatic selection:

```typescript
import { createStorage } from '@chrome-storage/core';

// Auto-detect best adapter
const storage = createStorage('standard');

// Use specific adapter
import { ChromeAdapter, IndexedDBAdapter } from '@chrome-storage/core';

const chromeStorage = new AdvancedStorage({
  adapter: 'chrome'
});

const indexedStorage = new AdvancedStorage({
  adapter: 'indexeddb'
});
```

### Configuration Presets

Quick setup with pre-configured settings:

```typescript
// Minimal - Basic storage without extra features
const minimal = createStorage('minimal');

// Standard - Caching and compression enabled
const standard = createStorage('standard');

// Advanced - All features including sync and monitoring
const advanced = createStorage('advanced');

// Secure - All features with encryption enabled
const secure = createStorage('secure');
```

### Custom Configuration

```typescript
import { AdvancedStorage } from '@chrome-storage/core';

const storage = new AdvancedStorage({
  adapter: 'auto',
  namespace: 'myapp',
  
  encryption: {
    enabled: true,
    algorithm: 'AES-GCM',
    key: 'your-encryption-key' // or auto-generated
  },
  
  compression: {
    enabled: true,
    algorithm: 'gzip',
    threshold: 1024, // Compress data > 1KB
    level: 6
  },
  
  cache: {
    enabled: true,
    strategy: 'lru',
    maxSize: 1000,
    maxMemory: 10 * 1024 * 1024, // 10MB
    ttl: 3600000 // 1 hour
  },
  
  sync: {
    enabled: true,
    interval: 300000, // 5 minutes
    conflictResolution: 'local'
  },
  
  versioning: {
    enabled: true,
    maxVersions: 10
  },
  
  quota: {
    maxSize: 100, // 100MB
    warnAt: 80 // Warn at 80% usage
  }
});
```

## Core Features

### Basic Operations

```typescript
// Set with options
await storage.set('key', value, {
  ttl: 3600000, // Expire in 1 hour
  tags: ['important', 'user-data'],
  encrypt: true,
  compress: true
});

// Bulk operations
await storage.bulk([
  { type: 'set', key: 'key1', value: 'value1' },
  { type: 'set', key: 'key2', value: 'value2' },
  { type: 'delete', key: 'key3' }
]);

// Update existing value
await storage.update('counter', (current) => (current || 0) + 1);
```

### Advanced Querying

```typescript
// SQL-like queries
const results = await storage.query({
  where: {
    type: 'user',
    'metadata.active': true,
    age: { $gte: 18, $lte: 65 }
  },
  orderBy: [['createdAt', 'desc']],
  limit: 10,
  offset: 0
});

// Full-text search
const searchResults = await storage.search('john doe', {
  fields: ['name', 'email'],
  fuzzy: true,
  limit: 5
});

// SQL queries
const users = await storage.sql(
  'SELECT * FROM storage WHERE type = ? AND age > ? ORDER BY name',
  ['user', 18]
);
```

### Session Management

```typescript
import { createSessionManager } from '@chrome-storage/core';

const sessions = createSessionManager({
  maxDuration: 480, // 8 hours
  idleTimeout: 30, // 30 minutes
  trackActivities: true
});

// Start session
const session = await sessions.startSession('user123', {
  source: 'login'
});

// Track activity
sessions.trackActivity('page_view', {
  url: window.location.href,
  title: document.title
});

// Get session info
const current = sessions.getCurrentSession();
const isActive = sessions.isActive();

// End session
await sessions.endSession('logout');
```

### History Management

```typescript
import { createHistoryManager } from '@chrome-storage/core';

const history = createHistoryManager({
  maxItems: 10000,
  groupByTime: true
});

// Add history item
await history.addItem({
  type: 'search',
  title: 'User searched for products',
  description: 'Search query: laptops',
  data: { query: 'laptops', results: 42 },
  metadata: {
    duration: 1250,
    status: 'success',
    tags: ['search', 'products']
  }
});

// Get history with filters
const items = await history.getItems({
  types: ['search', 'action'],
  dateRange: {
    start: new Date('2024-01-01'),
    end: new Date()
  },
  tags: ['important']
}, 50);

// Get timeline view
const timeline = await history.getTimeline(7); // Last 7 days

// Get statistics
const stats = await history.getStats(30); // Last 30 days

// Export history
const blob = await history.exportHistory();
```

### Settings Management

```typescript
import { createSettingsStore } from '@chrome-storage/core';

const settings = createSettingsStore();

// Get settings
const theme = settings.get('appearance.theme');
const allSettings = await settings.load();

// Update settings
await settings.set('appearance.theme', 'dark');
await settings.update({
  appearance: { theme: 'dark', fontSize: 'large' },
  notifications: { enabled: true }
});

// Subscribe to changes
const unsubscribe = settings.subscribe('appearance', (event) => {
  console.log('Appearance changed:', event);
});

// Reset settings
await settings.reset(); // Reset all
await settings.reset('appearance'); // Reset specific

// Import/Export
const json = await settings.export();
await settings.import(json);
```

## React Integration

### Hooks

```typescript
import { 
  useStorage, 
  useStorageState,
  useStorageQuery,
  useSession,
  useHistory,
  useSettings
} from '@chrome-storage/core';

function MyComponent() {
  // Basic storage hook
  const [value, setValue, loading, error] = useStorage('myKey', defaultValue);
  
  // Storage state with additional features
  const { value, setValue, remove } = useStorageState('user', null, {
    ttl: 3600000,
    encrypt: true
  });
  
  // Query hook
  const { data, loading, refetch } = useStorageQuery({
    where: { type: 'product' },
    orderBy: [['price', 'asc']]
  }, {
    refreshInterval: 30000 // Refresh every 30s
  });
  
  // Session hook
  const { session, startSession, endSession } = useSession({
    autoStart: true
  });
  
  // History hook
  const { items, addItem, searchHistory } = useHistory({
    limit: 100,
    types: ['action', 'view']
  });
  
  // Settings hook
  const { settings, update } = useSettings();
  
  return (
    <div>
      {/* Your component */}
    </div>
  );
}
```

### Optimistic Updates

```typescript
function OptimisticComponent() {
  const { 
    value, 
    optimisticValue, 
    update, 
    isUpdating 
  } = useOptimisticStorage('counter', 0);
  
  const increment = async () => {
    try {
      await update(optimisticValue + 1);
    } catch (error) {
      // Automatically rolled back
    }
  };
  
  return (
    <div>
      Count: {optimisticValue}
      {isUpdating && <span>Saving...</span>}
    </div>
  );
}
```

## Advanced Features

### Encryption

```typescript
// Enable encryption globally
const storage = new AdvancedStorage({
  encryption: {
    enabled: true,
    algorithm: 'AES-GCM'
  }
});

// Or per-item
await storage.set('sensitive', data, { encrypt: true });

// Generate encryption key
const key = await storage.generateKey();

// Derive key from password
const derivedKey = await storage.deriveKey('user-password');
```

### Compression

```typescript
// Auto-compress large data
const storage = new AdvancedStorage({
  compression: {
    enabled: true,
    algorithm: 'gzip',
    threshold: 1024 // Compress > 1KB
  }
});

// Get compression stats
const stats = storage.getCompressionStats();
console.log(`Compression ratio: ${stats.ratio}`);
```

### Synchronization

```typescript
// Enable cross-context sync
const storage = new AdvancedStorage({
  sync: {
    enabled: true,
    providers: ['chrome.sync'],
    conflictResolution: 'merge'
  }
});

// Manual sync
await storage.sync();

// Listen for sync events
storage.on('sync-complete', (result) => {
  console.log('Synced:', result);
});
```

### Performance Monitoring

```typescript
// Enable monitoring
const storage = new AdvancedStorage({
  monitoring: {
    enabled: true,
    performance: true,
    errors: true
  }
});

// Get metrics
const metrics = storage.getMetrics();
console.log('Operation stats:', metrics.operations);
console.log('Cache hit rate:', metrics.cacheHitRate);

// Listen for metrics
storage.on('metric', (metric) => {
  console.log(`${metric.operation}: ${metric.duration}ms`);
});
```

### Import/Export

```typescript
// Export all data
const blob = await storage.export({
  format: 'json',
  compressed: true,
  encrypted: true
});

// Export filtered data
const filtered = await storage.export({
  format: 'csv',
  include: ['users', 'settings'],
  headers: true
});

// Import data
await storage.import(blob, {
  format: 'json',
  compressed: true
});
```

### Schema Validation

```typescript
import { z } from 'zod';

// Define schema
const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().positive()
});

// Register schema
storage.registerSchema('user', UserSchema);

// Now all 'user:*' keys will be validated
await storage.set('user:123', {
  id: '123',
  name: 'John',
  email: 'invalid-email' // Will throw validation error
});
```

## Best Practices

### 1. Use Namespaces

```typescript
const userStorage = new AdvancedStorage({ namespace: 'users' });
const appStorage = new AdvancedStorage({ namespace: 'app' });
```

### 2. Set Appropriate TTLs

```typescript
// Cache API responses
await storage.set('api:users', users, { 
  ttl: 5 * 60 * 1000 // 5 minutes
});

// Store user preferences permanently
await storage.set('preferences', prefs); // No TTL
```

### 3. Use Tags for Organization

```typescript
await storage.set('doc:123', document, {
  tags: ['document', 'important', 'v2']
});

// Query by tags
const important = await storage.query({
  where: { 'metadata.tags': { $contains: 'important' } }
});
```

### 4. Monitor Storage Usage

```typescript
storage.on('quota-warning', async (stats) => {
  console.warn(`Storage ${stats.percentage}% full`);
  
  // Clean up old data
  const old = await storage.query({
    where: { 
      'metadata.created': { 
        $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      }
    }
  });
  
  for (const item of old) {
    await storage.delete(item.key);
  }
});
```

### 5. Handle Errors Gracefully

```typescript
try {
  await storage.set('key', value);
} catch (error) {
  if (error.code === 'QUOTA_EXCEEDED') {
    // Handle quota errors
    await cleanupOldData();
  } else if (error.code === 'ENCRYPTION_ERROR') {
    // Handle encryption errors
    console.error('Encryption failed:', error);
  }
}
```

## API Reference

### Core Classes

- `AdvancedStorage` - Main storage class
- `StorageManager` - Manages multiple storage instances
- `SessionManager` - Session tracking and management
- `HistoryManager` - History tracking with timeline
- `SettingsStore` - Type-safe settings management

### Adapters

- `ChromeAdapter` - Chrome storage API adapter
- `IndexedDBAdapter` - IndexedDB adapter using Dexie
- `MemoryAdapter` - In-memory storage adapter

### React Hooks

- `useStorage` - Basic storage operations
- `useStorageState` - Storage with React state
- `useStorageQuery` - Query storage data
- `useSession` - Session management
- `useHistory` - History tracking
- `useSettings` - Settings management
- `useOptimisticStorage` - Optimistic updates

## Migration Guide

### From localStorage

```typescript
// Before
localStorage.setItem('key', JSON.stringify(value));
const value = JSON.parse(localStorage.getItem('key'));

// After
await storage.set('key', value);
const value = await storage.get('key');
```

### From chrome.storage

```typescript
// Before
chrome.storage.local.set({ key: value }, () => {
  // callback
});

// After
await storage.set('key', value);
// No callback needed - uses Promises
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

- 📚 [Documentation](https://github.com/yourusername/chrome-storage-core/docs)
- 🐛 [Issue Tracker](https://github.com/yourusername/chrome-storage-core/issues)
- 💬 [Discussions](https://github.com/yourusername/chrome-storage-core/discussions)
- 📧 [Email Support](mailto:support@example.com)