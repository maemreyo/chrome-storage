// Session management service

import { EventEmitter } from 'eventemitter3';
import { AdvancedStorage } from '../core/advanced-storage';
import { Session, SessionActivity } from '../core/types';

export interface SessionConfig {
  maxDuration?: number; // in minutes
  idleTimeout?: number; // in minutes
  persistSession?: boolean;
  trackActivities?: boolean;
  maxActivities?: number;
}

export class SessionManager extends EventEmitter {
  private storage: AdvancedStorage;
  private config: Required<SessionConfig>;
  private currentSession: Session | null = null;
  private activityBuffer: SessionActivity[] = [];
  private idleTimer?: NodeJS.Timeout;
  private sessionKey = '__current_session__';
  
  constructor(storage: AdvancedStorage, config: SessionConfig = {}) {
    super();
    
    this.storage = storage;
    this.config = {
      maxDuration: config.maxDuration || 480, // 8 hours
      idleTimeout: config.idleTimeout || 30, // 30 minutes
      persistSession: config.persistSession !== false,
      trackActivities: config.trackActivities !== false,
      maxActivities: config.maxActivities || 1000
    };
    
    this.initialize();
  }
  
  private async initialize(): Promise<void> {
    // Load existing session
    if (this.config.persistSession) {
      const stored = await this.storage.get<Session>(this.sessionKey);
      if (stored && this.isSessionValid(stored)) {
        this.currentSession = stored;
        this.startIdleTimer();
        this.emit('session-resumed', stored);
      }
    }
    
    // Setup activity listeners
    this.setupActivityListeners();
  }
  
  private setupActivityListeners(): void {
    // Track user activity
    if (typeof document !== 'undefined') {
      const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
      events.forEach(event => {
        document.addEventListener(event, this.handleUserActivity, { passive: true });
      });
      
      // Track page visibility
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.trackActivity('page_view', { action: 'hidden' });
        } else {
          this.trackActivity('page_view', { action: 'visible' });
          this.updateLastActive();
        }
      });
    }
    
    // Track Chrome extension navigation if available
    if (typeof chrome !== 'undefined' && chrome.webNavigation) {
      chrome.webNavigation.onCompleted.addListener((details) => {
        if (details.frameId === 0) {
          this.trackActivity('page_view', {
            url: details.url,
            tabId: details.tabId
          });
        }
      });
    }
  }
  
  private handleUserActivity = (): void => {
    this.updateLastActive();
    this.resetIdleTimer();
  }
  
  private startIdleTimer(): void {
    this.resetIdleTimer();
  }
  
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    if (this.config.idleTimeout && this.currentSession) {
      this.idleTimer = setTimeout(() => {
        this.handleIdleTimeout();
      }, this.config.idleTimeout * 60 * 1000);
    }
  }
  
  private handleIdleTimeout(): void {
    if (this.currentSession) {
      this.trackActivity('action', { type: 'idle_timeout' });
      this.endSession('idle_timeout');
    }
  }
  
  async startSession(userId?: string, data?: Record<string, any>): Promise<Session> {
    // End current session if exists
    if (this.currentSession) {
      await this.endSession('new_session');
    }
    
    const now = new Date();
    const session: Session = {
      id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      startedAt: now,
      lastActiveAt: now,
      expiresAt: this.config.maxDuration
        ? new Date(now.getTime() + this.config.maxDuration * 60 * 1000)
        : undefined,
      data: data || {},
      device: this.getDeviceInfo(),
      activities: []
    };
    
    this.currentSession = session;
    await this.saveSession();
    
    this.startIdleTimer();
    this.trackActivity('action', { type: 'session_start' });
    
    this.emit('session-started', session);
    
    return session;
  }
  
  async endSession(reason = 'manual'): Promise<void> {
    if (!this.currentSession) return;
    
    this.trackActivity('action', { type: 'session_end', reason });
    
    // Flush activity buffer
    await this.flushActivities();
    
    // Save final state
    await this.saveSession();
    
    // Archive session
    await this.archiveSession(this.currentSession);
    
    // Clear current session
    const endedSession = this.currentSession;
    this.currentSession = null;
    await this.storage.delete(this.sessionKey);
    
    // Clear timers
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    
    this.emit('session-ended', { session: endedSession, reason });
  }
  
  async updateSession(data: Partial<Session['data']>): Promise<void> {
    if (!this.currentSession) {
      throw new Error('No active session');
    }
    
    this.currentSession.data = {
      ...this.currentSession.data,
      ...data
    };
    
    await this.saveSession();
  }
  
  trackActivity(type: SessionActivity['type'], details: Record<string, any> = {}): void {
    if (!this.currentSession || !this.config.trackActivities) return;
    
    const activity: SessionActivity = {
      timestamp: new Date(),
      type,
      details
    };
    
    this.activityBuffer.push(activity);
    
    // Batch save activities
    if (this.activityBuffer.length >= 10) {
      this.flushActivities();
    }
  }
  
  private async flushActivities(): Promise<void> {
    if (!this.currentSession || this.activityBuffer.length === 0) return;
    
    this.currentSession.activities.push(...this.activityBuffer);
    
    // Limit activities
    if (this.config.maxActivities && this.currentSession.activities.length > this.config.maxActivities) {
      this.currentSession.activities = this.currentSession.activities.slice(-this.config.maxActivities);
    }
    
    this.activityBuffer = [];
    await this.saveSession();
  }
  
  private async saveSession(): Promise<void> {
    if (!this.currentSession || !this.config.persistSession) return;
    
    await this.storage.set(this.sessionKey, this.currentSession);
  }
  
  private async archiveSession(session: Session): Promise<void> {
    const archiveKey = `__session_archive_${session.id}`;
    await this.storage.set(archiveKey, session, { tags: ['session', 'archive'] });
  }
  
  private updateLastActive(): void {
    if (!this.currentSession) return;
    
    this.currentSession.lastActiveAt = new Date();
    this.saveSession();
  }
  
  private isSessionValid(session: Session): boolean {
    const now = new Date();
    
    // Check expiration
    if (session.expiresAt && now > new Date(session.expiresAt)) {
      return false;
    }
    
    // Check idle timeout
    if (this.config.idleTimeout) {
      const idleTime = now.getTime() - new Date(session.lastActiveAt).getTime();
      if (idleTime > this.config.idleTimeout * 60 * 1000) {
        return false;
      }
    }
    
    return true;
  }
  
  private getDeviceInfo(): Session['device'] {
    if (typeof navigator === 'undefined') {
      return undefined;
    }
    
    return {
      browser: navigator.userAgent,
      os: navigator.platform,
      screen: typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : 'unknown'
    };
  }
  
  // Public methods
  
  getCurrentSession(): Session | null {
    return this.currentSession;
  }
  
  isActive(): boolean {
    return this.currentSession !== null && this.isSessionValid(this.currentSession);
  }
  
  async getSessionHistory(userId?: string, limit = 10): Promise<Session[]> {
    const keys = await this.storage.keys();
    const archiveKeys = keys.filter(k => k.startsWith('__session_archive_'));
    
    const sessions: Session[] = [];
    for (const key of archiveKeys) {
      const session = await this.storage.get<Session>(key);
      if (session && (!userId || session.userId === userId)) {
        sessions.push(session);
      }
    }
    
    // Sort by start time descending
    sessions.sort((a, b) => 
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    
    return sessions.slice(0, limit);
  }
  
  async getSessionById(sessionId: string): Promise<Session | null> {
    return this.storage.get(`__session_archive_${sessionId}`);
  }
  
  async clearOldSessions(daysToKeep = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    const keys = await this.storage.keys();
    const archiveKeys = keys.filter(k => k.startsWith('__session_archive_'));
    
    let deletedCount = 0;
    
    for (const key of archiveKeys) {
      const session = await this.storage.get<Session>(key);
      if (session && new Date(session.startedAt) < cutoffDate) {
        await this.storage.delete(key);
        deletedCount++;
      }
    }
    
    return deletedCount;
  }
  
  destroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    if (typeof document !== 'undefined') {
      const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
      events.forEach(event => {
        document.removeEventListener(event, this.handleUserActivity);
      });
    }
    
    this.removeAllListeners();
  }
}