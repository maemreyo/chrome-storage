// Performance monitoring and metrics collection

import { EventEmitter } from 'eventemitter3';
import Debug from 'debug';
import { PerformanceMetrics } from '../core/types';

const debug = Debug('chrome-storage:metrics');

export interface MonitoringConfig {
  enabled: boolean;
  performance?: boolean;
  errors?: boolean;
  usage?: boolean;
  sampleRate?: number; // 0-1, percentage of operations to track
  bufferSize?: number; // Max metrics to keep in memory
  flushInterval?: number; // How often to flush metrics
}

export interface OperationMetrics {
  operation: string;
  count: number;
  totalDuration: number;
  minDuration: number;
  maxDuration: number;
  avgDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  errors: number;
  errorRate: number;
}

export interface UsageMetrics {
  timestamp: Date;
  operationCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  cacheHitRate: number;
  storageSize: number;
  itemCount: number;
  memoryUsage: number;
}

export interface ErrorMetrics {
  timestamp: Date;
  error: Error;
  operation: string;
  context: Record<string, any>;
  stack?: string;
}

export class MetricsCollector extends EventEmitter {
  private config: Required<MonitoringConfig>;
  private metrics: PerformanceMetrics[] = [];
  private errors: ErrorMetrics[] = [];
  private operationStats = new Map<string, number[]>();
  private flushTimer?: NodeJS.Timer;
  private startTime = Date.now();
  
  constructor(config: MonitoringConfig) {
    super();
    
    this.config = {
      enabled: config.enabled || false,
      performance: config.performance !== false,
      errors: config.errors !== false,
      usage: config.usage !== false,
      sampleRate: config.sampleRate || 1,
      bufferSize: config.bufferSize || 10000,
      flushInterval: config.flushInterval || 60000 // 1 minute
    };
  }
  
  /**
   * Start collecting metrics
   */
  start(): void {
    if (!this.config.enabled) return;
    
    debug('Starting metrics collector');
    
    // Start flush timer
    if (this.config.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush();
      }, this.config.flushInterval);
    }
    
    // Monitor performance if available
    if (this.config.performance && typeof performance !== 'undefined') {
      this.setupPerformanceObserver();
    }
  }
  
  /**
   * Stop collecting metrics
   */
  stop(): void {
    debug('Stopping metrics collector');
    
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    this.flush();
  }
  
  /**
   * Record operation metrics
   */
  recordOperation(operation: string, duration: number, metadata?: Record<string, any>): void {
    if (!this.config.enabled || !this.config.performance) return;
    
    // Apply sampling
    if (Math.random() > this.config.sampleRate) return;
    
    const metric: PerformanceMetrics = {
      operation,
      duration,
      timestamp: new Date(),
      metadata
    };
    
    this.metrics.push(metric);
    
    // Update operation stats
    if (!this.operationStats.has(operation)) {
      this.operationStats.set(operation, []);
    }
    this.operationStats.get(operation)!.push(duration);
    
    // Enforce buffer size
    if (this.metrics.length > this.config.bufferSize) {
      this.metrics = this.metrics.slice(-this.config.bufferSize);
    }
    
    // Emit metric event
    this.emit('metric', metric);
  }
  
  /**
   * Record error
   */
  recordError(error: Error, operation: string, context?: Record<string, any>): void {
    if (!this.config.enabled || !this.config.errors) return;
    
    const errorMetric: ErrorMetrics = {
      timestamp: new Date(),
      error,
      operation,
      context: context || {},
      stack: error.stack
    };
    
    this.errors.push(errorMetric);
    
    // Enforce buffer size
    if (this.errors.length > this.config.bufferSize) {
      this.errors = this.errors.slice(-this.config.bufferSize);
    }
    
    // Emit error event
    this.emit('error', errorMetric);
    
    debug('Error recorded:', error.message);
  }
  
  /**
   * Record cache hit
   */
  recordHit(cache: string): void {
    this.recordOperation(`cache.${cache}.hit`, 0);
  }
  
  /**
   * Record cache miss
   */
  recordMiss(cache: string): void {
    this.recordOperation(`cache.${cache}.miss`, 0);
  }
  
  /**
   * Get operation statistics
   */
  getOperationStats(): Map<string, OperationMetrics> {
    const stats = new Map<string, OperationMetrics>();
    
    for (const [operation, durations] of this.operationStats) {
      if (durations.length === 0) continue;
      
      const sorted = durations.sort((a, b) => a - b);
      const count = durations.length;
      const total = durations.reduce((sum, d) => sum + d, 0);
      
      stats.set(operation, {
        operation,
        count,
        totalDuration: total,
        minDuration: sorted[0],
        maxDuration: sorted[count - 1],
        avgDuration: total / count,
        p50Duration: this.percentile(sorted, 0.5),
        p95Duration: this.percentile(sorted, 0.95),
        p99Duration: this.percentile(sorted, 0.99),
        errors: this.errors.filter(e => e.operation === operation).length,
        errorRate: this.errors.filter(e => e.operation === operation).length / count
      });
    }
    
    return stats;
  }
  
  /**
   * Get usage metrics
   */
  async getUsageMetrics(): Promise<UsageMetrics> {
    const operationCounts: Record<string, number> = {};
    const errorCounts: Record<string, number> = {};
    
    // Count operations
    for (const metric of this.metrics) {
      operationCounts[metric.operation] = (operationCounts[metric.operation] || 0) + 1;
    }
    
    // Count errors
    for (const error of this.errors) {
      errorCounts[error.operation] = (errorCounts[error.operation] || 0) + 1;
    }
    
    // Calculate cache hit rate
    const cacheHits = operationCounts['cache.hit'] || 0;
    const cacheMisses = operationCounts['cache.miss'] || 0;
    const cacheTotal = cacheHits + cacheMisses;
    const cacheHitRate = cacheTotal > 0 ? cacheHits / cacheTotal : 0;
    
    return {
      timestamp: new Date(),
      operationCounts,
      errorCounts,
      cacheHitRate,
      storageSize: 0, // TODO: Get from storage
      itemCount: 0, // TODO: Get from storage
      memoryUsage: this.getMemoryUsage()
    };
  }
  
  /**
   * Get recent errors
   */
  getRecentErrors(limit: number = 10): ErrorMetrics[] {
    return this.errors.slice(-limit);
  }
  
  /**
   * Get performance summary
   */
  getPerformanceSummary(): {
    uptime: number;
    totalOperations: number;
    totalErrors: number;
    errorRate: number;
    operationsPerSecond: number;
    topOperations: Array<{ operation: string; count: number }>;
    slowestOperations: Array<{ operation: string; avgDuration: number }>;
  } {
    const uptime = Date.now() - this.startTime;
    const totalOperations = this.metrics.length;
    const totalErrors = this.errors.length;
    const errorRate = totalOperations > 0 ? totalErrors / totalOperations : 0;
    const operationsPerSecond = totalOperations / (uptime / 1000);
    
    // Get top operations
    const operationCounts = new Map<string, number>();
    for (const metric of this.metrics) {
      operationCounts.set(
        metric.operation,
        (operationCounts.get(metric.operation) || 0) + 1
      );
    }
    
    const topOperations = Array.from(operationCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([operation, count]) => ({ operation, count }));
    
    // Get slowest operations
    const stats = this.getOperationStats();
    const slowestOperations = Array.from(stats.values())
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 5)
      .map(stat => ({ operation: stat.operation, avgDuration: stat.avgDuration }));
    
    return {
      uptime,
      totalOperations,
      totalErrors,
      errorRate,
      operationsPerSecond,
      topOperations,
      slowestOperations
    };
  }
  
  /**
   * Export metrics
   */
  exportMetrics(): {
    metrics: PerformanceMetrics[];
    errors: ErrorMetrics[];
    stats: Record<string, OperationMetrics>;
    summary: any;
  } {
    const stats: Record<string, OperationMetrics> = {};
    this.getOperationStats().forEach((value, key) => {
      stats[key] = value;
    });
    
    return {
      metrics: [...this.metrics],
      errors: [...this.errors],
      stats,
      summary: this.getPerformanceSummary()
    };
  }
  
  /**
   * Clear metrics
   */
  clear(): void {
    this.metrics = [];
    this.errors = [];
    this.operationStats.clear();
  }
  
  /**
   * Flush metrics
   */
  private flush(): void {
    if (this.metrics.length === 0 && this.errors.length === 0) return;
    
    debug(`Flushing ${this.metrics.length} metrics and ${this.errors.length} errors`);
    
    // Emit flush event with current metrics
    this.emit('flush', {
      metrics: [...this.metrics],
      errors: [...this.errors],
      stats: this.getOperationStats()
    });
    
    // Clear old metrics based on buffer size
    if (this.metrics.length > this.config.bufferSize) {
      this.metrics = this.metrics.slice(-this.config.bufferSize / 2);
    }
    
    if (this.errors.length > this.config.bufferSize) {
      this.errors = this.errors.slice(-this.config.bufferSize / 2);
    }
  }
  
  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }
  
  /**
   * Get memory usage
   */
  private getMemoryUsage(): number {
    if (typeof performance !== 'undefined' && 'memory' in performance) {
      return (performance as any).memory.usedJSHeapSize || 0;
    }
    return 0;
  }
  
  /**
   * Setup performance observer
   */
  private setupPerformanceObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'measure' && entry.name.startsWith('chrome-storage:')) {
            this.recordOperation(
              entry.name.replace('chrome-storage:', ''),
              entry.duration
            );
          }
        }
      });
      
      observer.observe({ entryTypes: ['measure'] });
    } catch (error) {
      debug('Failed to setup performance observer:', error);
    }
  }
}