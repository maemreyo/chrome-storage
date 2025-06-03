// Compression service with multiple algorithms

import * as pako from 'pako';
import { StorageError } from '../core/types';

export interface CompressionConfig {
  algorithm: 'gzip' | 'lz4' | 'brotli';
  level: number; // 1-9
  threshold?: number; // Min size to compress
}

export interface CompressedData {
  algorithm: string;
  data: string;
  originalSize: number;
  compressedSize: number;
}

export class CompressionService {
  private config: Required<CompressionConfig>;
  private totalOriginalSize = 0;
  private totalCompressedSize = 0;
  
  constructor(config: CompressionConfig) {
    this.config = {
      algorithm: config.algorithm || 'gzip',
      level: Math.min(9, Math.max(1, config.level || 6)),
      threshold: config.threshold || 1024 // 1KB
    };
  }
  
  /**
   * Compress data
   */
  async compress<T = any>(data: T): Promise<CompressedData> {
    const serialized = JSON.stringify(data);
    const originalSize = new Blob([serialized]).size;
    
    // Skip compression for small data
    if (originalSize < this.config.threshold) {
      return {
        algorithm: 'none',
        data: serialized,
        originalSize,
        compressedSize: originalSize
      };
    }
    
    let compressed: Uint8Array;
    
    switch (this.config.algorithm) {
      case 'gzip':
        compressed = await this.compressGzip(serialized);
        break;
      case 'lz4':
        compressed = await this.compressLZ4(serialized);
        break;
      case 'brotli':
        compressed = await this.compressBrotli(serialized);
        break;
      default:
        throw new StorageError(
          `Unsupported compression algorithm: ${this.config.algorithm}`,
          'COMPRESSION_ERROR'
        );
    }
    
    const compressedSize = compressed.length;
    this.totalOriginalSize += originalSize;
    this.totalCompressedSize += compressedSize;
    
    return {
      algorithm: this.config.algorithm,
      data: this.uint8ArrayToBase64(compressed),
      originalSize,
      compressedSize
    };
  }
  
  /**
   * Decompress data
   */
  async decompress<T = any>(compressed: CompressedData): Promise<T> {
    if (compressed.algorithm === 'none') {
      return JSON.parse(compressed.data);
    }
    
    const compressedData = this.base64ToUint8Array(compressed.data);
    let decompressed: string;
    
    switch (compressed.algorithm) {
      case 'gzip':
        decompressed = await this.decompressGzip(compressedData);
        break;
      case 'lz4':
        decompressed = await this.decompressLZ4(compressedData);
        break;
      case 'brotli':
        decompressed = await this.decompressBrotli(compressedData);
        break;
      default:
        throw new StorageError(
          `Unsupported decompression algorithm: ${compressed.algorithm}`,
          'DECOMPRESSION_ERROR'
        );
    }
    
    return JSON.parse(decompressed);
  }
  
  /**
   * Compress raw data (for exports)
   */
  async compressRaw(data: string): Promise<Uint8Array> {
    switch (this.config.algorithm) {
      case 'gzip':
        return pako.gzip(data, { level: this.config.level });
      case 'lz4':
        // LZ4 would require additional library
        return pako.gzip(data, { level: this.config.level }); // Fallback to gzip
      case 'brotli':
        return this.compressBrotliRaw(data);
      default:
        throw new StorageError(
          `Unsupported compression algorithm: ${this.config.algorithm}`,
          'COMPRESSION_ERROR'
        );
    }
  }
  
  /**
   * Decompress raw data (for imports)
   */
  async decompressRaw(data: Uint8Array): Promise<string> {
    // Try to detect compression type
    if (this.isGzip(data)) {
      return pako.ungzip(data, { to: 'string' });
    } else if (this.isBrotli(data)) {
      return this.decompressBrotliRaw(data);
    } else {
      // Try as gzip by default
      try {
        return pako.ungzip(data, { to: 'string' });
      } catch {
        // Not compressed
        return new TextDecoder().decode(data);
      }
    }
  }
  
  /**
   * Get compression ratio
   */
  getCompressionRatio(): number {
    if (this.totalOriginalSize === 0) return 1;
    return this.totalCompressedSize / this.totalOriginalSize;
  }
  
  /**
   * Get statistics
   */
  getStats(): {
    algorithm: string;
    level: number;
    totalOriginalSize: number;
    totalCompressedSize: number;
    compressionRatio: number;
    spaceSaved: number;
  } {
    const spaceSaved = this.totalOriginalSize - this.totalCompressedSize;
    
    return {
      algorithm: this.config.algorithm,
      level: this.config.level,
      totalOriginalSize: this.totalOriginalSize,
      totalCompressedSize: this.totalCompressedSize,
      compressionRatio: this.getCompressionRatio(),
      spaceSaved
    };
  }
  
  // Private methods
  
  private async compressGzip(data: string): Promise<Uint8Array> {
    return pako.gzip(data, { level: this.config.level });
  }
  
  private async decompressGzip(data: Uint8Array): Promise<string> {
    return pako.ungzip(data, { to: 'string' });
  }
  
  private async compressLZ4(data: string): Promise<Uint8Array> {
    // LZ4 implementation would go here
    // For now, fallback to gzip
    return this.compressGzip(data);
  }
  
  private async decompressLZ4(data: Uint8Array): Promise<string> {
    // LZ4 implementation would go here
    // For now, fallback to gzip
    return this.decompressGzip(data);
  }
  
  private async compressBrotli(data: string): Promise<Uint8Array> {
    // Check if native Brotli is available
    if ('CompressionStream' in globalThis) {
      return this.compressBrotliNative(data);
    }
    
    // Fallback to gzip
    return this.compressGzip(data);
  }
  
  private async decompressBrotli(data: Uint8Array): Promise<string> {
    // Check if native Brotli is available
    if ('DecompressionStream' in globalThis) {
      return this.decompressBrotliNative(data);
    }
    
    // Fallback to gzip
    return this.decompressGzip(data);
  }
  
  private async compressBrotliNative(data: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const input = encoder.encode(data);
    
    const cs = new CompressionStream('brotli');
    const writer = cs.writable.getWriter();
    writer.write(input);
    writer.close();
    
    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    return result;
  }
  
  private async decompressBrotliNative(data: Uint8Array): Promise<string> {
    const ds = new DecompressionStream('brotli');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    
    const chunks: Uint8Array[] = [];
    const reader = ds.readable.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    const decoder = new TextDecoder();
    return decoder.decode(result);
  }
  
  private compressBrotliRaw(data: string): Uint8Array {
    // This would use native Brotli or a library
    // For now, use gzip
    return pako.gzip(data, { level: this.config.level });
  }
  
  private decompressBrotliRaw(data: Uint8Array): string {
    // This would use native Brotli or a library
    // For now, try gzip
    return pako.ungzip(data, { to: 'string' });
  }
  
  private isGzip(data: Uint8Array): boolean {
    // Check gzip magic number
    return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
  }
  
  private isBrotli(data: Uint8Array): boolean {
    // Brotli doesn't have a consistent magic number
    // This is a simplified check
    return false;
  }
  
  private uint8ArrayToBase64(data: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }
  
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }
    return data;
  }
}