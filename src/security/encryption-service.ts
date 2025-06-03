// Encryption service with multiple algorithms support

import * as nacl from 'tweetnacl';
import * as naclUtil from 'tweetnacl-util';
import { EncryptionError } from '../core/types';

export interface EncryptionConfig {
  algorithm: 'AES-GCM' | 'AES-CBC' | 'ChaCha20-Poly1305';
  key?: string;
  keyDerivation?: 'PBKDF2' | 'Argon2';
  saltLength?: number;
  iterations?: number;
}

export interface EncryptedData {
  algorithm: string;
  data: string;
  nonce?: string;
  salt?: string;
  tag?: string;
}

export class EncryptionService {
  private config: Required<EncryptionConfig>;
  private key?: CryptoKey | Uint8Array;
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();
  
  constructor(config: EncryptionConfig) {
    this.config = {
      algorithm: config.algorithm || 'AES-GCM',
      key: config.key,
      keyDerivation: config.keyDerivation || 'PBKDF2',
      saltLength: config.saltLength || 16,
      iterations: config.iterations || 100000
    };
    
    this.initializeKey();
  }
  
  /**
   * Encrypt data
   */
  async encrypt<T = any>(data: T): Promise<EncryptedData> {
    const serialized = JSON.stringify(data);
    const dataBuffer = this.textEncoder.encode(serialized);
    
    switch (this.config.algorithm) {
      case 'AES-GCM':
        return this.encryptAESGCM(dataBuffer);
      case 'AES-CBC':
        return this.encryptAESCBC(dataBuffer);
      case 'ChaCha20-Poly1305':
        return this.encryptChaCha20(dataBuffer);
      default:
        throw new EncryptionError(
          `Unsupported encryption algorithm: ${this.config.algorithm}`
        );
    }
  }
  
  /**
   * Decrypt data
   */
  async decrypt<T = any>(encrypted: EncryptedData): Promise<T> {
    let decrypted: ArrayBuffer;
    
    switch (encrypted.algorithm) {
      case 'AES-GCM':
        decrypted = await this.decryptAESGCM(encrypted);
        break;
      case 'AES-CBC':
        decrypted = await this.decryptAESCBC(encrypted);
        break;
      case 'ChaCha20-Poly1305':
        decrypted = await this.decryptChaCha20(encrypted);
        break;
      default:
        throw new EncryptionError(
          `Unsupported decryption algorithm: ${encrypted.algorithm}`
        );
    }
    
    const decoded = this.textDecoder.decode(decrypted);
    return JSON.parse(decoded);
  }
  
  /**
   * Generate encryption key
   */
  async generateKey(): Promise<string> {
    if (this.config.algorithm === 'ChaCha20-Poly1305') {
      // Use tweetnacl for ChaCha20
      const key = nacl.randomBytes(32);
      return naclUtil.encodeBase64(key);
    } else {
      // Use Web Crypto API for AES
      const key = await crypto.subtle.generateKey(
        {
          name: this.config.algorithm,
          length: 256
        },
        true,
        ['encrypt', 'decrypt']
      );
      
      const exported = await crypto.subtle.exportKey('raw', key);
      return this.arrayBufferToBase64(exported);
    }
  }
  
  /**
   * Derive key from password
   */
  async deriveKey(password: string, salt?: Uint8Array): Promise<string> {
    const passwordBuffer = this.textEncoder.encode(password);
    salt = salt || crypto.getRandomValues(new Uint8Array(this.config.saltLength));
    
    if (this.config.keyDerivation === 'PBKDF2') {
      const importedKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        'PBKDF2',
        false,
        ['deriveBits']
      );
      
      const derivedBits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt,
          iterations: this.config.iterations,
          hash: 'SHA-256'
        },
        importedKey,
        256
      );
      
      return this.arrayBufferToBase64(derivedBits);
    } else {
      // Argon2 would require additional library
      throw new EncryptionError('Argon2 not implemented yet');
    }
  }
  
  /**
   * Verify encrypted data integrity
   */
  async verify(encrypted: EncryptedData): Promise<boolean> {
    try {
      // Try to decrypt - if successful, data is valid
      await this.decrypt(encrypted);
      return true;
    } catch {
      return false;
    }
  }
  
  // Private methods
  
  private async initializeKey(): Promise<void> {
    if (!this.config.key) {
      this.config.key = await this.generateKey();
    }
    
    if (this.config.algorithm === 'ChaCha20-Poly1305') {
      // ChaCha20 uses raw bytes
      this.key = naclUtil.decodeBase64(this.config.key);
    } else {
      // AES uses CryptoKey
      const keyData = this.base64ToArrayBuffer(this.config.key);
      this.key = await crypto.subtle.importKey(
        'raw',
        keyData,
        this.config.algorithm,
        false,
        ['encrypt', 'decrypt']
      );
    }
  }
  
  private async encryptAESGCM(data: Uint8Array): Promise<EncryptedData> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce
      },
      this.key as CryptoKey,
      data
    );
    
    return {
      algorithm: 'AES-GCM',
      data: this.arrayBufferToBase64(encrypted),
      nonce: this.arrayBufferToBase64(nonce)
    };
  }
  
  private async decryptAESGCM(encrypted: EncryptedData): Promise<ArrayBuffer> {
    if (!encrypted.nonce) {
      throw new EncryptionError('Missing nonce for AES-GCM decryption');
    }
    
    const data = this.base64ToArrayBuffer(encrypted.data);
    const nonce = this.base64ToArrayBuffer(encrypted.nonce);
    
    return crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce
      },
      this.key as CryptoKey,
      data
    );
  }
  
  private async encryptAESCBC(data: Uint8Array): Promise<EncryptedData> {
    const iv = crypto.getRandomValues(new Uint8Array(16));
    
    // Pad data to multiple of 16 bytes
    const padded = this.pkcs7Pad(data);
    
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-CBC',
        iv
      },
      this.key as CryptoKey,
      padded
    );
    
    return {
      algorithm: 'AES-CBC',
      data: this.arrayBufferToBase64(encrypted),
      nonce: this.arrayBufferToBase64(iv)
    };
  }
  
  private async decryptAESCBC(encrypted: EncryptedData): Promise<ArrayBuffer> {
    if (!encrypted.nonce) {
      throw new EncryptionError('Missing IV for AES-CBC decryption');
    }
    
    const data = this.base64ToArrayBuffer(encrypted.data);
    const iv = this.base64ToArrayBuffer(encrypted.nonce);
    
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-CBC',
        iv
      },
      this.key as CryptoKey,
      data
    );
    
    // Remove padding
    return this.pkcs7Unpad(new Uint8Array(decrypted));
  }
  
  private encryptChaCha20(data: Uint8Array): EncryptedData {
    const nonce = nacl.randomBytes(24);
    const encrypted = nacl.secretbox(data, nonce, this.key as Uint8Array);
    
    return {
      algorithm: 'ChaCha20-Poly1305',
      data: naclUtil.encodeBase64(encrypted),
      nonce: naclUtil.encodeBase64(nonce)
    };
  }
  
  private decryptChaCha20(encrypted: EncryptedData): ArrayBuffer {
    if (!encrypted.nonce) {
      throw new EncryptionError('Missing nonce for ChaCha20 decryption');
    }
    
    const data = naclUtil.decodeBase64(encrypted.data);
    const nonce = naclUtil.decodeBase64(encrypted.nonce);
    
    const decrypted = nacl.secretbox.open(data, nonce, this.key as Uint8Array);
    
    if (!decrypted) {
      throw new EncryptionError('Decryption failed - invalid key or corrupted data');
    }
    
    return decrypted.buffer;
  }
  
  private pkcs7Pad(data: Uint8Array): Uint8Array {
    const blockSize = 16;
    const padding = blockSize - (data.length % blockSize);
    const padded = new Uint8Array(data.length + padding);
    padded.set(data);
    padded.fill(padding, data.length);
    return padded;
  }
  
  private pkcs7Unpad(data: Uint8Array): ArrayBuffer {
    const padding = data[data.length - 1];
    return data.slice(0, data.length - padding).buffer;
  }
  
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}