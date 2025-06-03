// Advanced query engine with SQL-like capabilities

import alasql from 'alasql';
import * as lunr from 'lunr';
import {
  StorageAdapter,
  QueryOptions,
  WhereClause,
  OrderByClause,
  StorageError,
  StorageItem
} from '../core/types';

export interface QueryResult<T = any> {
  data: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

export interface IndexDefinition {
  name: string;
  fields: string[];
  unique?: boolean;
  type?: 'btree' | 'hash' | 'fulltext';
}

export class QueryEngine {
  private adapter: StorageAdapter;
  private indexes = new Map<string, IndexDefinition>();
  private searchIndex?: lunr.Index;
  private searchDocuments = new Map<string, any>();
  
  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
  }
  
  /**
   * Execute query
   */
  async query<T = any>(options: QueryOptions): Promise<T[]> {
    // Get all data
    const keys = await this.adapter.keys();
    const items: StorageItem<T>[] = [];
    
    // Fetch all items
    for (const key of keys) {
      const item = await this.adapter.get<StorageItem<T>>(key);
      if (item && this.isStorageItem(item)) {
        items.push(item);
      }
    }
    
    // Apply where clause
    let filtered = options.where 
      ? items.filter(item => this.matchesWhere(item, options.where!))
      : items;
    
    // Apply grouping
    if (options.groupBy && options.groupBy.length > 0) {
      filtered = this.groupBy(filtered, options.groupBy, options.having);
    }
    
    // Apply ordering
    if (options.orderBy) {
      filtered = this.orderBy(filtered, options.orderBy);
    }
    
    // Apply pagination
    if (options.offset || options.limit) {
      const start = options.offset || 0;
      const end = options.limit ? start + options.limit : undefined;
      filtered = filtered.slice(start, end);
    }
    
    // Apply selection
    if (options.select && options.select.length > 0) {
      return filtered.map(item => this.selectFields(item, options.select!));
    }
    
    return filtered.map(item => item.value);
  }
  
  /**
   * Execute SQL query
   */
  async sql<T = any>(query: string, params?: any[]): Promise<T[]> {
    // Get all data
    const keys = await this.adapter.keys();
    const data: any[] = [];
    
    for (const key of keys) {
      const item = await this.adapter.get<StorageItem<T>>(key);
      if (item && this.isStorageItem(item)) {
        data.push({
          key: item.key,
          ...item.value,
          _metadata: item.metadata
        });
      }
    }
    
    // Execute SQL query using alasql
    try {
      const result = alasql(query, [data, ...(params || [])]);
      return result;
    } catch (error) {
      throw new StorageError(
        `SQL query failed: ${error.message}`,
        'QUERY_ERROR',
        error
      );
    }
  }
  
  /**
   * Full-text search
   */
  async search(query: string, options?: {
    fields?: string[];
    fuzzy?: boolean;
    limit?: number;
  }): Promise<any[]> {
    if (!this.searchIndex) {
      await this.buildSearchIndex(options?.fields);
    }
    
    const searchOptions: lunr.Index.QueryBuilder = (q) => {
      const terms = query.split(' ');
      
      terms.forEach(term => {
        if (options?.fuzzy) {
          q.term(term, { 
            wildcard: lunr.Query.wildcard.TRAILING,
            editDistance: 1
          });
        } else {
          q.term(term);
        }
        
        if (options?.fields) {
          q.term(term, { fields: options.fields });
        }
      });
    };
    
    const results = this.searchIndex!.search(query);
    const items = results.map(result => this.searchDocuments.get(result.ref));
    
    return options?.limit ? items.slice(0, options.limit) : items;
  }
  
  /**
   * Create index
   */
  async createIndex(definition: IndexDefinition): Promise<void> {
    this.indexes.set(definition.name, definition);
    
    if (definition.type === 'fulltext') {
      await this.buildSearchIndex(definition.fields);
    }
  }
  
  /**
   * Drop index
   */
  dropIndex(name: string): void {
    this.indexes.delete(name);
  }
  
  /**
   * Get query plan
   */
  explainQuery(options: QueryOptions): {
    steps: string[];
    estimatedCost: number;
    indexes: string[];
  } {
    const steps: string[] = [];
    let cost = 100; // Base cost
    const usedIndexes: string[] = [];
    
    // Where clause
    if (options.where) {
      steps.push('Filter by WHERE clause');
      const indexHint = this.findApplicableIndex(options.where);
      if (indexHint) {
        steps.push(`  Using index: ${indexHint}`);
        usedIndexes.push(indexHint);
        cost *= 0.1; // Index reduces cost significantly
      } else {
        steps.push('  Full scan required');
      }
    }
    
    // Group by
    if (options.groupBy) {
      steps.push(`Group by: ${options.groupBy.join(', ')}`);
      cost *= 1.5;
    }
    
    // Order by
    if (options.orderBy) {
      steps.push(`Sort by: ${options.orderBy}`);
      cost *= 1.2;
    }
    
    // Limit
    if (options.limit) {
      steps.push(`Limit to ${options.limit} results`);
      cost *= 0.8;
    }
    
    return {
      steps,
      estimatedCost: Math.round(cost),
      indexes: usedIndexes
    };
  }
  
  /**
   * Aggregate functions
   */
  async aggregate(aggregations: {
    count?: string;
    sum?: string;
    avg?: string;
    min?: string;
    max?: string;
    groupBy?: string[];
  }): Promise<any[]> {
    const keys = await this.adapter.keys();
    const data: any[] = [];
    
    for (const key of keys) {
      const item = await this.adapter.get(key);
      if (item && this.isStorageItem(item)) {
        data.push(item.value);
      }
    }
    
    // Build SQL query
    const selectClauses: string[] = [];
    
    if (aggregations.count) {
      selectClauses.push(`COUNT(${aggregations.count}) as count`);
    }
    if (aggregations.sum) {
      selectClauses.push(`SUM(${aggregations.sum}) as sum`);
    }
    if (aggregations.avg) {
      selectClauses.push(`AVG(${aggregations.avg}) as avg`);
    }
    if (aggregations.min) {
      selectClauses.push(`MIN(${aggregations.min}) as min`);
    }
    if (aggregations.max) {
      selectClauses.push(`MAX(${aggregations.max}) as max`);
    }
    
    if (aggregations.groupBy) {
      selectClauses.push(...aggregations.groupBy);
    }
    
    const query = `
      SELECT ${selectClauses.join(', ')}
      FROM ?
      ${aggregations.groupBy ? `GROUP BY ${aggregations.groupBy.join(', ')}` : ''}
    `;
    
    return alasql(query, [data]);
  }
  
  // Private methods
  
  private isStorageItem(value: any): value is StorageItem {
    return value && 
           typeof value === 'object' &&
           'id' in value &&
           'key' in value &&
           'value' in value &&
           'metadata' in value;
  }
  
  private matchesWhere(item: StorageItem, where: WhereClause): boolean {
    for (const [field, condition] of Object.entries(where)) {
      const value = this.getFieldValue(item, field);
      
      if (!this.matchesCondition(value, condition)) {
        return false;
      }
    }
    
    return true;
  }
  
  private matchesCondition(value: any, condition: any): boolean {
    // Simple equality
    if (typeof condition !== 'object' || condition === null) {
      return value === condition;
    }
    
    // Complex conditions
    if ('$eq' in condition) {
      return value === condition.$eq;
    }
    
    if ('$ne' in condition) {
      return value !== condition.$ne;
    }
    
    if ('$gt' in condition) {
      return value > condition.$gt;
    }
    
    if ('$gte' in condition) {
      return value >= condition.$gte;
    }
    
    if ('$lt' in condition) {
      return value < condition.$lt;
    }
    
    if ('$lte' in condition) {
      return value <= condition.$lte;
    }
    
    if ('$in' in condition) {
      return Array.isArray(condition.$in) && condition.$in.includes(value);
    }
    
    if ('$nin' in condition) {
      return Array.isArray(condition.$nin) && !condition.$nin.includes(value);
    }
    
    if ('$contains' in condition && typeof value === 'string') {
      return value.includes(condition.$contains);
    }
    
    if ('$startsWith' in condition && typeof value === 'string') {
      return value.startsWith(condition.$startsWith);
    }
    
    if ('$endsWith' in condition && typeof value === 'string') {
      return value.endsWith(condition.$endsWith);
    }
    
    if ('$regex' in condition && typeof value === 'string') {
      const regex = typeof condition.$regex === 'string' 
        ? new RegExp(condition.$regex)
        : condition.$regex;
      return regex.test(value);
    }
    
    if ('$exists' in condition) {
      return condition.$exists ? value !== undefined : value === undefined;
    }
    
    if ('$type' in condition) {
      return typeof value === condition.$type;
    }
    
    if ('$size' in condition) {
      if (Array.isArray(value)) {
        return value.length === condition.$size;
      }
      if (typeof value === 'string') {
        return value.length === condition.$size;
      }
      if (typeof value === 'object' && value !== null) {
        return Object.keys(value).length === condition.$size;
      }
    }
    
    if ('$all' in condition && Array.isArray(value)) {
      return condition.$all.every((item: any) => value.includes(item));
    }
    
    if ('$elemMatch' in condition && Array.isArray(value)) {
      return value.some((item: any) => 
        this.matchesWhere({ value: item } as any, condition.$elemMatch)
      );
    }
    
    return true;
  }
  
  private getFieldValue(item: StorageItem, field: string): any {
    // Handle nested fields
    const parts = field.split('.');
    let value: any = item;
    
    for (const part of parts) {
      if (part === 'value' && this.isStorageItem(value)) {
        value = value.value;
      } else if (part === 'metadata' && this.isStorageItem(value)) {
        value = value.metadata;
      } else if (value && typeof value === 'object') {
        value = value[part];
      } else {
        return undefined;
      }
    }
    
    return value;
  }
  
  private groupBy(items: StorageItem[], fields: string[], having?: WhereClause): StorageItem[] {
    const groups = new Map<string, StorageItem[]>();
    
    // Group items
    for (const item of items) {
      const key = fields.map(field => this.getFieldValue(item, field)).join('::');
      
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      
      groups.get(key)!.push(item);
    }
    
    // Apply having clause and return first item from each group
    const result: StorageItem[] = [];
    
    for (const [key, groupItems] of groups) {
      if (!having || this.matchesWhere(groupItems[0], having)) {
        result.push(groupItems[0]); // Simple strategy - return first item
      }
    }
    
    return result;
  }
  
  private orderBy(items: StorageItem[], orderBy: OrderByClause): StorageItem[] {
    const orders: Array<[string, 'asc' | 'desc']> = [];
    
    if (typeof orderBy === 'string') {
      orders.push([orderBy, 'asc']);
    } else if (Array.isArray(orderBy)) {
      for (const order of orderBy) {
        if (typeof order === 'string') {
          orders.push([order, 'asc']);
        } else {
          orders.push(order);
        }
      }
    }
    
    return items.sort((a, b) => {
      for (const [field, direction] of orders) {
        const aValue = this.getFieldValue(a, field);
        const bValue = this.getFieldValue(b, field);
        
        if (aValue < bValue) {
          return direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return direction === 'asc' ? 1 : -1;
        }
      }
      
      return 0;
    });
  }
  
  private selectFields(item: StorageItem, fields: string[]): any {
    const result: any = {};
    
    for (const field of fields) {
      const value = this.getFieldValue(item, field);
      this.setFieldValue(result, field, value);
    }
    
    return result;
  }
  
  private setFieldValue(obj: any, field: string, value: any): void {
    const parts = field.split('.');
    let current = obj;
    
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    
    current[parts[parts.length - 1]] = value;
  }
  
  private findApplicableIndex(where: WhereClause): string | null {
    const whereFields = Object.keys(where);
    
    for (const [name, index] of this.indexes) {
      // Check if index fields match where clause
      if (index.fields.some(field => whereFields.includes(field))) {
        return name;
      }
    }
    
    return null;
  }
  
  private async buildSearchIndex(fields?: string[]): Promise<void> {
    const keys = await this.adapter.keys();
    const documents: any[] = [];
    
    for (const key of keys) {
      const item = await this.adapter.get(key);
      if (item && this.isStorageItem(item)) {
        const doc = {
          id: key,
          ...this.flattenObject(item.value, fields)
        };
        documents.push(doc);
        this.searchDocuments.set(key, item.value);
      }
    }
    
    this.searchIndex = lunr(function() {
      this.ref('id');
      
      if (fields) {
        fields.forEach(field => this.field(field));
      } else {
        // Index all string fields
        if (documents.length > 0) {
          Object.keys(documents[0]).forEach(key => {
            if (key !== 'id' && typeof documents[0][key] === 'string') {
              this.field(key);
            }
          });
        }
      }
      
      documents.forEach(doc => this.add(doc));
    });
  }
  
  private flattenObject(obj: any, fields?: string[], prefix = ''): any {
    const result: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      
      if (fields && !fields.some(f => fullKey.startsWith(f))) {
        continue;
      }
      
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(result, this.flattenObject(value, fields, fullKey));
      } else if (typeof value === 'string' || typeof value === 'number') {
        result[fullKey] = String(value);
      }
    }
    
    return result;
  }
}