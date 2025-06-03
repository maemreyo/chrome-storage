// Settings management with schema validation

import { EventEmitter } from 'eventemitter3';
import { z } from 'zod';
import { AdvancedStorage } from '../core/advanced-storage';
import { Settings } from '../core/types';

// Define settings schemas
export const ThemeSchema = z.enum(['light', 'dark', 'system', 'auto']);

export const NotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  sound: z.boolean(),
  desktop: z.boolean(),
  types: z.object({
    info: z.boolean(),
    warning: z.boolean(),
    error: z.boolean(),
    success: z.boolean()
  })
});

export const PrivacySettingsSchema = z.object({
  trackingEnabled: z.boolean(),
  shareAnalytics: z.boolean(),
  storageEncryption: z.boolean(),
  clearDataOnUninstall: z.boolean()
});

export const AppearanceSettingsSchema = z.object({
  theme: ThemeSchema,
  fontSize: z.enum(['small', 'medium', 'large']),
  compactMode: z.boolean(),
  animations: z.boolean(),
  highContrast: z.boolean()
});

export const SettingsSchema = z.object({
  version: z.string(),
  appearance: AppearanceSettingsSchema,
  notifications: NotificationSettingsSchema,
  privacy: PrivacySettingsSchema,
  features: z.record(z.boolean()),
  shortcuts: z.record(z.string()),
  advanced: z.record(z.any())
});

export type SettingsType = z.infer<typeof SettingsSchema>;
export type SettingsKey = keyof SettingsType;
export type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T;

export interface SettingsChangeEvent {
  key: string;
  oldValue: any;
  newValue: any;
  timestamp: Date;
}

export class SettingsStore extends EventEmitter {
  private storage: AdvancedStorage;
  private cache: SettingsType | null = null;
  private settingsKey = '__app_settings__';
  private defaultSettings: SettingsType;
  
  constructor(storage: AdvancedStorage) {
    super();
    
    this.storage = storage;
    this.defaultSettings = this.getDefaultSettings();
    this.initialize();
  }
  
  private async initialize(): Promise<void> {
    await this.load();
    
    // Listen for storage changes
    this.storage.watch(this.settingsKey, (change) => {
      if (change.newValue) {
        this.cache = change.newValue as SettingsType;
        this.notifyListeners('*', null, change.newValue);
      }
    });
  }
  
  private getDefaultSettings(): SettingsType {
    return {
      version: '1.0.0',
      appearance: {
        theme: 'system',
        fontSize: 'medium',
        compactMode: false,
        animations: true,
        highContrast: false
      },
      notifications: {
        enabled: true,
        sound: true,
        desktop: true,
        types: {
          info: true,
          warning: true,
          error: true,
          success: true
        }
      },
      privacy: {
        trackingEnabled: true,
        shareAnalytics: false,
        storageEncryption: false,
        clearDataOnUninstall: false
      },
      features: {},
      shortcuts: {
        'toggle-extension': 'Ctrl+Shift+E',
        'open-settings': 'Ctrl+,',
        'quick-search': 'Ctrl+K'
      },
      advanced: {}
    };
  }
  
  async load(): Promise<SettingsType> {
    try {
      const stored = await this.storage.get<SettingsType>(this.settingsKey);
      
      if (stored) {
        // Validate and merge with defaults
        const validated = SettingsSchema.parse({
          ...this.defaultSettings,
          ...stored
        });
        this.cache = validated;
      } else {
        // First time - use defaults
        this.cache = this.defaultSettings;
        await this.save();
      }
      
      return this.cache;
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.cache = this.defaultSettings;
      return this.cache;
    }
  }
  
  async save(): Promise<void> {
    if (!this.cache) return;
    
    try {
      await this.storage.set(this.settingsKey, this.cache, { tags: ['settings'] });
    } catch (error) {
      console.error('Failed to save settings:', error);
      throw error;
    }
  }
  
  get<K extends SettingsKey>(key: K): SettingsType[K];
  get<K extends string>(key: K): any;
  get(key: string): any {
    if (!this.cache) {
      throw new Error('Settings not loaded');
    }
    
    // Support nested keys like 'appearance.theme'
    return key.split('.').reduce((obj, k) => obj?.[k], this.cache as any);
  }
  
  async set<K extends SettingsKey>(key: K, value: SettingsType[K]): Promise<void>;
  async set(key: string, value: any): Promise<void>;
  async set(key: string, value: any): Promise<void> {
    if (!this.cache) {
      await this.load();
    }
    
    const oldValue = this.get(key);
    
    // Set nested value
    const keys = key.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((obj, k) => {
      if (!obj[k]) obj[k] = {};
      return obj[k];
    }, this.cache as any);
    
    target[lastKey] = value;
    
    // Validate entire settings
    try {
      this.cache = SettingsSchema.parse(this.cache);
    } catch (error) {
      // Rollback
      target[lastKey] = oldValue;
      throw new Error(`Invalid settings value: ${error}`);
    }
    
    // Save to storage
    await this.save();
    
    // Notify listeners
    this.notifyListeners(key, oldValue, value);
  }
  
  async update(updates: DeepPartial<SettingsType>): Promise<void> {
    if (!this.cache) {
      await this.load();
    }
    
    const oldSettings = { ...this.cache };
    
    // Deep merge
    this.cache = this.deepMerge(this.cache!, updates) as SettingsType;
    
    // Validate
    try {
      this.cache = SettingsSchema.parse(this.cache);
    } catch (error) {
      // Rollback
      this.cache = oldSettings;
      throw new Error(`Invalid settings update: ${error}`);
    }
    
    // Save
    await this.save();
    
    // Notify about all changes
    this.findChanges(oldSettings, this.cache).forEach(({ key, oldValue, newValue }) => {
      this.notifyListeners(key, oldValue, newValue);
    });
  }
  
  async reset(key?: string): Promise<void> {
    if (!key) {
      // Reset all settings
      const oldSettings = { ...this.cache };
      this.cache = this.defaultSettings;
      await this.save();
      
      // Notify about all changes
      this.findChanges(oldSettings, this.cache).forEach(({ key, oldValue, newValue }) => {
        this.notifyListeners(key, oldValue, newValue);
      });
    } else {
      // Reset specific key
      const defaultValue = this.getDefaultValue(key);
      await this.set(key, defaultValue);
    }
  }
  
  subscribe(key: string, callback: (event: SettingsChangeEvent) => void): () => void {
    const listener = (event: SettingsChangeEvent) => {
      if (key === '*' || event.key === key || event.key.startsWith(`${key}.`)) {
        callback(event);
      }
    };
    
    this.on('change', listener);
    
    // Return unsubscribe function
    return () => {
      this.off('change', listener);
    };
  }
  
  async export(): Promise<string> {
    if (!this.cache) {
      await this.load();
    }
    
    return JSON.stringify(this.cache, null, 2);
  }
  
  async import(settingsJson: string): Promise<void> {
    try {
      const imported = JSON.parse(settingsJson);
      const validated = SettingsSchema.parse(imported);
      
      const oldSettings = { ...this.cache };
      this.cache = validated;
      await this.save();
      
      // Notify about changes
      this.findChanges(oldSettings, this.cache).forEach(({ key, oldValue, newValue }) => {
        this.notifyListeners(key, oldValue, newValue);
      });
    } catch (error) {
      throw new Error(`Invalid settings import: ${error}`);
    }
  }
  
  getSchema(): typeof SettingsSchema {
    return SettingsSchema;
  }
  
  validate(settings: any): SettingsType {
    return SettingsSchema.parse(settings);
  }
  
  private notifyListeners(key: string, oldValue: any, newValue: any): void {
    const event: SettingsChangeEvent = {
      key,
      oldValue,
      newValue,
      timestamp: new Date()
    };
    
    this.emit('change', event);
  }
  
  private deepMerge(target: any, source: any): any {
    const output = { ...target };
    
    Object.keys(source).forEach(key => {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (key in target) {
          output[key] = this.deepMerge(target[key], source[key]);
        } else {
          output[key] = source[key];
        }
      } else {
        output[key] = source[key];
      }
    });
    
    return output;
  }
  
  private findChanges(
    oldObj: any,
    newObj: any,
    path = ''
  ): Array<{ key: string; oldValue: any; newValue: any }> {
    const changes: Array<{ key: string; oldValue: any; newValue: any }> = [];
    
    Object.keys(newObj).forEach(key => {
      const fullKey = path ? `${path}.${key}` : key;
      const oldValue = oldObj?.[key];
      const newValue = newObj[key];
      
      if (typeof newValue === 'object' && newValue !== null && !Array.isArray(newValue)) {
        changes.push(...this.findChanges(oldValue || {}, newValue, fullKey));
      } else if (oldValue !== newValue) {
        changes.push({ key: fullKey, oldValue, newValue });
      }
    });
    
    return changes;
  }
  
  private getDefaultValue(key: string): any {
    return key.split('.').reduce((obj, k) => obj?.[k], this.defaultSettings as any);
  }
  
  destroy(): void {
    this.removeAllListeners();
  }
}