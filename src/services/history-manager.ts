// History tracking and management service

import { EventEmitter } from 'eventemitter3';
import { z } from 'zod';
import { AdvancedStorage } from '../core/advanced-storage';
import { HistoryItem } from '../core/types';

export const HistoryItemSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  type: z.enum(['analysis', 'fact_check', 'search', 'action', 'view', 'custom']),
  title: z.string(),
  description: z.string().optional(),
  url: z.string().optional(),
  data: z.record(z.any()),
  metadata: z.object({
    duration: z.number().optional(),
    status: z.enum(['success', 'failure', 'pending']).optional(),
    tags: z.array(z.string()).optional(),
    source: z.string().optional()
  }).optional(),
  groupId: z.string().optional()
});

export interface HistoryGroup {
  id: string;
  title: string;
  date: Date;
  items: HistoryItem[];
  collapsed?: boolean;
}

export interface HistoryFilters {
  types?: HistoryItem['type'][];
  dateRange?: {
    start: Date;
    end: Date;
  };
  search?: string;
  tags?: string[];
  status?: string[];
}

export interface HistoryStats {
  totalItems: number;
  itemsByType: Record<string, number>;
  itemsByDay: Array<{ date: string; count: number }>;
  recentActivity: HistoryItem[];
  topTags: Array<{ tag: string; count: number }>;
}

export class HistoryManager extends EventEmitter {
  private storage: AdvancedStorage;
  private historyKey = 'history_items';
  private maxItems: number;
  private groupByTime: boolean;
  
  constructor(
    storage: AdvancedStorage,
    options: { maxItems?: number; groupByTime?: boolean } = {}
  ) {
    super();
    
    this.storage = storage;
    this.maxItems = options.maxItems || 10000;
    this.groupByTime = options.groupByTime !== false;
  }
  
  async addItem(item: Omit<HistoryItem, 'id' | 'timestamp'>): Promise<HistoryItem> {
    // Validate input
    const validatedItem = HistoryItemSchema.parse({
      ...item,
      id: `history_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    });
    
    // Store item
    await this.storage.set(
      `${this.historyKey}_${validatedItem.id}`,
      validatedItem,
      { tags: ['history', validatedItem.type] }
    );
    
    // Cleanup old items
    await this.cleanupOldItems();
    
    // Dispatch event
    this.emit('history-item-added', validatedItem);
    
    return validatedItem;
  }
  
  async getItems(filters?: HistoryFilters, limit = 50): Promise<HistoryItem[]> {
    const query: any = {
      where: {},
      orderBy: [['timestamp', 'desc']],
      limit
    };
    
    // Build where clause
    const whereClauses: any = {};
    
    if (filters?.types && filters.types.length > 0) {
      whereClauses.type = { $in: filters.types };
    }
    
    if (filters?.dateRange) {
      whereClauses.timestamp = {
        $gte: filters.dateRange.start,
        $lte: filters.dateRange.end
      };
    }
    
    if (filters?.tags && filters.tags.length > 0) {
      whereClauses['metadata.tags'] = { $all: filters.tags };
    }
    
    if (filters?.status && filters.status.length > 0) {
      whereClauses['metadata.status'] = { $in: filters.status };
    }
    
    // Get all history items
    const keys = await this.storage.keys();
    const historyKeys = keys.filter(k => k.startsWith(`${this.historyKey}_`));
    
    const items: HistoryItem[] = [];
    for (const key of historyKeys) {
      const item = await this.storage.get<HistoryItem>(key);
      if (item && this.matchesFilters(item, whereClauses)) {
        items.push(item);
      }
    }
    
    // Sort items
    items.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    
    // Apply text search if needed
    let filteredItems = items;
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      filteredItems = items.filter(item =>
        item.title.toLowerCase().includes(searchLower) ||
        item.description?.toLowerCase().includes(searchLower) ||
        JSON.stringify(item.data).toLowerCase().includes(searchLower)
      );
    }
    
    return filteredItems.slice(0, limit);
  }
  
  async getTimeline(days = 7, filters?: HistoryFilters): Promise<HistoryGroup[]> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const items = await this.getItems({
      ...filters,
      dateRange: { start: startDate, end: endDate }
    }, 1000);
    
    // Group by day
    const groups = new Map<string, HistoryItem[]>();
    
    items.forEach(item => {
      const date = new Date(item.timestamp);
      const dateKey = date.toISOString().split('T')[0];
      
      if (!groups.has(dateKey)) {
        groups.set(dateKey, []);
      }
      groups.get(dateKey)!.push(item);
    });
    
    // Convert to HistoryGroup array
    return Array.from(groups.entries())
      .map(([dateStr, items]) => ({
        id: `group_${dateStr}`,
        title: this.formatGroupTitle(new Date(dateStr)),
        date: new Date(dateStr),
        items: items.sort((a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }
  
  async getStats(days = 30): Promise<HistoryStats> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const items = await this.getItems({
      dateRange: { start: startDate, end: endDate }
    }, 10000);
    
    // Calculate stats
    const itemsByType: Record<string, number> = {};
    const itemsByDay = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    
    items.forEach(item => {
      // By type
      itemsByType[item.type] = (itemsByType[item.type] || 0) + 1;
      
      // By day
      const dateKey = new Date(item.timestamp).toISOString().split('T')[0];
      itemsByDay.set(dateKey, (itemsByDay.get(dateKey) || 0) + 1);
      
      // Tags
      item.metadata?.tags?.forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });
    
    // Fill missing days
    const dayArray: Array<{ date: string; count: number }> = [];
    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0];
      dayArray.push({
        date: dateKey,
        count: itemsByDay.get(dateKey) || 0
      });
    }
    
    // Top tags
    const topTags = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return {
      totalItems: items.length,
      itemsByType,
      itemsByDay: dayArray.reverse(),
      recentActivity: items.slice(0, 10),
      topTags
    };
  }
  
  async searchHistory(query: string, limit = 50): Promise<HistoryItem[]> {
    return this.getItems({ search: query }, limit);
  }
  
  async getRelatedItems(itemId: string, limit = 10): Promise<HistoryItem[]> {
    const item = await this.storage.get<HistoryItem>(`${this.historyKey}_${itemId}`);
    if (!item) return [];
    
    // Find items with similar tags or from same group
    const allItems = await this.getItems({}, 1000);
    
    const relatedItems = allItems.filter(i => {
      if (i.id === itemId) return false;
      
      // Same group
      if (item.groupId && i.groupId === item.groupId) return true;
      
      // Similar tags
      if (item.metadata?.tags && i.metadata?.tags) {
        const sharedTags = item.metadata.tags.filter(tag => 
          i.metadata!.tags!.includes(tag)
        );
        return sharedTags.length > 0;
      }
      
      return false;
    });
    
    return relatedItems.slice(0, limit);
  }
  
  async updateItem(
    itemId: string,
    updates: Partial<Omit<HistoryItem, 'id' | 'timestamp'>>
  ): Promise<void> {
    const key = `${this.historyKey}_${itemId}`;
    const item = await this.storage.get<HistoryItem>(key);
    
    if (!item) {
      throw new Error(`History item ${itemId} not found`);
    }
    
    const updated = {
      ...item,
      ...updates,
      metadata: {
        ...item.metadata,
        ...updates.metadata
      }
    };
    
    await this.storage.set(key, updated);
  }
  
  async deleteItem(itemId: string): Promise<void> {
    await this.storage.delete(`${this.historyKey}_${itemId}`);
  }
  
  async clearHistory(filters?: HistoryFilters): Promise<number> {
    const items = await this.getItems(filters, 100000);
    
    for (const item of items) {
      await this.deleteItem(item.id);
    }
    
    return items.length;
  }
  
  async exportHistory(filters?: HistoryFilters): Promise<Blob> {
    const items = await this.getItems(filters, 100000);
    
    const exportData = {
      exportDate: new Date().toISOString(),
      version: '1.0',
      itemCount: items.length,
      items
    };
    
    return new Blob(
      [JSON.stringify(exportData, null, 2)],
      { type: 'application/json' }
    );
  }
  
  async importHistory(file: Blob): Promise<number> {
    const text = await file.text();
    const data = JSON.parse(text);
    
    if (!data.items || !Array.isArray(data.items)) {
      throw new Error('Invalid history export file');
    }
    
    let imported = 0;
    for (const item of data.items) {
      try {
        // Validate and import
        const validated = HistoryItemSchema.parse({
          ...item,
          timestamp: new Date(item.timestamp)
        });
        
        await this.storage.set(
          `${this.historyKey}_${validated.id}`,
          validated,
          { tags: ['history', validated.type, 'imported'] }
        );
        
        imported++;
      } catch (error) {
        console.error('Failed to import history item:', error);
      }
    }
    
    return imported;
  }
  
  private async cleanupOldItems(): Promise<void> {
    const items = await this.getItems({}, 100000);
    
    if (items.length > this.maxItems) {
      const toDelete = items.slice(this.maxItems);
      for (const item of toDelete) {
        await this.deleteItem(item.id);
      }
    }
  }
  
  private formatGroupTitle(date: Date): string {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
      });
    }
  }
  
  private matchesFilters(item: HistoryItem, filters: any): boolean {
    for (const [key, condition of Object.entries(filters)) {
      const value = this.getNestedValue(item, key);
      
      if (!this.matchesCondition(value, condition)) {
        return false;
      }
    }
    
    return true;
  }
  
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((curr, key) => curr?.[key], obj);
  }
  
  private matchesCondition(value: any, condition: any): boolean {
    if (typeof condition === 'object' && condition !== null) {
      if ('$in' in condition) {
        return Array.isArray(condition.$in) && condition.$in.includes(value);
      }
      if ('$gte' in condition && '$lte' in condition) {
        return value >= condition.$gte && value <= condition.$lte;
      }
      if ('$all' in condition && Array.isArray(value)) {
        return condition.$all.every((item: any) => value.includes(item));
      }
    }
    
    return value === condition;
  }
}