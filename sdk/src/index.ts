/**
 * PING SDK - TypeScript client for Agent-to-Agent messaging
 * 
 * @example
 * ```typescript
 * import { PingClient } from '@ping/sdk';
 * 
 * const client = new PingClient();
 * await client.generateKeys();
 * await client.register({ name: 'My Agent' });
 * await client.text(recipientId, 'Hello!');
 * ```
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure @noble/ed25519
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ═══════════════════════════════════════════════════════════════
//                         TYPES
// ═══════════════════════════════════════════════════════════════

export interface PingConfig {
  /** API base URL (default: http://localhost:3100) */
  baseUrl?: string;
  /** Ed25519 private key (hex) - if not provided, call generateKeys() */
  privateKey?: string;
  /** Agent ID - if not provided, call register() */
  agentId?: string;
}

export interface Agent {
  id: string;
  publicKey: string;
  name: string;
  provider: string;
  capabilities: string[];
  webhookUrl: string | null;
  isPublic: boolean;
  createdAt: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
}

export interface Message {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  replyTo: string | null;
  timestamp: string;
  signature: string;
  delivered?: boolean;
  acknowledged?: boolean;
}

export interface Contact {
  contactId: string;
  alias: string | null;
  notes: string | null;
  addedAt: string;
  contact: AgentSummary | null;
}

export interface SendResult {
  id: string;
  delivered: boolean;
  deliveryMethod: 'webhook' | 'websocket' | 'polling';
}

export type MessageType = 
  | 'text'
  | 'ping'
  | 'pong'
  | 'request'
  | 'response'
  | 'proposal'
  | 'signature'
  | 'custom';

export interface RegisterOptions {
  name: string;
  provider?: string;
  capabilities?: string[];
  webhookUrl?: string;
  isPublic?: boolean;
}

export interface SearchOptions {
  query?: string;
  capability?: string;
  provider?: string;
}

export interface SendOptions {
  to: string;
  type: MessageType;
  payload?: Record<string, unknown>;
  replyTo?: string;
}

// ═══════════════════════════════════════════════════════════════
//                         CLIENT
// ═══════════════════════════════════════════════════════════════

export class PingClient {
  private baseUrl: string;
  private privateKey: Uint8Array | null = null;
  private publicKey: string = '';
  
  /** Agent ID (set after registration) */
  public agentId: string = '';

  constructor(config: PingConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:3100';
    
    if (config.privateKey) {
      this.privateKey = hexToBytes(config.privateKey);
      this.publicKey = bytesToHex(ed.getPublicKey(this.privateKey));
    }
    
    if (config.agentId) {
      this.agentId = config.agentId;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                         KEYS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate a new Ed25519 keypair
   * @returns The generated keys (hex encoded)
   */
  async generateKeys(): Promise<{ privateKey: string; publicKey: string }> {
    this.privateKey = ed.utils.randomPrivateKey();
    this.publicKey = bytesToHex(ed.getPublicKey(this.privateKey));
    return {
      privateKey: bytesToHex(this.privateKey),
      publicKey: this.publicKey,
    };
  }

  /**
   * Set keys from existing values
   */
  setKeys(privateKey: string): void {
    this.privateKey = hexToBytes(privateKey);
    this.publicKey = bytesToHex(ed.getPublicKey(this.privateKey));
  }

  /**
   * Get the public key
   */
  getPublicKey(): string {
    return this.publicKey;
  }

  // ═══════════════════════════════════════════════════════════════
  //                         AGENTS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Register as a new agent
   */
  async register(opts: RegisterOptions): Promise<Agent> {
    if (!this.publicKey) {
      await this.generateKeys();
    }

    const res = await this.fetch('/agents', {
      method: 'POST',
      body: {
        publicKey: this.publicKey,
        name: opts.name,
        provider: opts.provider,
        capabilities: opts.capabilities || [],
        webhookUrl: opts.webhookUrl,
        isPublic: opts.isPublic ?? false,
      },
    });

    this.agentId = res.id;
    return res;
  }

  /**
   * Get agent info by ID
   */
  async getAgent(id: string): Promise<Agent> {
    return this.fetch(`/agents/${id}`);
  }

  /**
   * Update agent info
   */
  async updateAgent(updates: Partial<RegisterOptions>): Promise<Agent> {
    this.requireAgent();
    return this.fetch(`/agents/${this.agentId}`, {
      method: 'PATCH',
      body: updates,
    });
  }

  /**
   * Delete agent
   */
  async deleteAgent(): Promise<void> {
    this.requireAgent();
    await this.fetch(`/agents/${this.agentId}`, { method: 'DELETE' });
    this.agentId = '';
  }

  // ═══════════════════════════════════════════════════════════════
  //                         DIRECTORY
  // ═══════════════════════════════════════════════════════════════

  /**
   * List public agents
   */
  async directory(): Promise<AgentSummary[]> {
    return this.fetch('/directory');
  }

  /**
   * Search agents
   */
  async search(opts?: SearchOptions): Promise<AgentSummary[]> {
    const params = new URLSearchParams();
    if (opts?.query) params.set('q', opts.query);
    if (opts?.capability) params.set('capability', opts.capability);
    if (opts?.provider) params.set('provider', opts.provider);
    
    const query = params.toString();
    return this.fetch(`/directory/search${query ? '?' + query : ''}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                         CONTACTS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get contacts
   */
  async contacts(): Promise<Contact[]> {
    this.requireAgent();
    return this.fetch(`/agents/${this.agentId}/contacts`);
  }

  /**
   * Add a contact
   */
  async addContact(contactId: string, alias?: string, notes?: string): Promise<void> {
    this.requireAgent();
    await this.fetch(`/agents/${this.agentId}/contacts`, {
      method: 'POST',
      body: { contactId, alias, notes },
    });
  }

  /**
   * Remove a contact
   */
  async removeContact(contactId: string): Promise<void> {
    this.requireAgent();
    await this.fetch(`/agents/${this.agentId}/contacts/${contactId}`, {
      method: 'DELETE',
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //                         MESSAGES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a message
   */
  async send(opts: SendOptions): Promise<SendResult> {
    this.requireAgent();
    this.requireKeys();

    const message = {
      type: opts.type,
      from: this.agentId,
      to: opts.to,
      payload: opts.payload || {},
      replyTo: opts.replyTo,
      timestamp: Date.now(),
    };

    const signature = this.sign(message);

    return this.fetch('/messages', {
      method: 'POST',
      body: { ...message, signature },
    });
  }

  /**
   * Get inbox (unacknowledged messages)
   */
  async inbox(all = false): Promise<Message[]> {
    this.requireAgent();
    return this.fetch(`/agents/${this.agentId}/inbox${all ? '?all=true' : ''}`);
  }

  /**
   * Get conversation history
   */
  async history(otherId: string, limit = 50): Promise<Message[]> {
    this.requireAgent();
    return this.fetch(`/agents/${this.agentId}/messages/${otherId}?limit=${limit}`);
  }

  /**
   * Acknowledge a message
   */
  async ack(messageId: string): Promise<void> {
    await this.fetch(`/messages/${messageId}/ack`, { method: 'POST' });
  }

  // ═══════════════════════════════════════════════════════════════
  //                    CONVENIENCE METHODS
  // ═══════════════════════════════════════════════════════════════

  /** Send a text message */
  async text(to: string, text: string): Promise<SendResult> {
    return this.send({ to, type: 'text', payload: { text } });
  }

  /** Send a ping */
  async ping(to: string): Promise<SendResult> {
    return this.send({ to, type: 'ping', payload: {} });
  }

  /** Send a pong (reply to ping) */
  async pong(to: string, replyTo?: string): Promise<SendResult> {
    return this.send({ to, type: 'pong', payload: {}, replyTo });
  }

  /** Send a request */
  async request(to: string, action: string, data?: unknown): Promise<SendResult> {
    return this.send({ to, type: 'request', payload: { action, data } });
  }

  /** Send a response */
  async respond(to: string, result: unknown, replyTo?: string): Promise<SendResult> {
    return this.send({ to, type: 'response', payload: { result }, replyTo });
  }

  /** Send a proposal (for signing) */
  async propose(to: string, proposal: Record<string, unknown>): Promise<SendResult> {
    return this.send({ to, type: 'proposal', payload: proposal });
  }

  /** Send a signature */
  async signature(to: string, signature: string, replyTo?: string): Promise<SendResult> {
    return this.send({ to, type: 'signature', payload: { signature }, replyTo });
  }

  // ═══════════════════════════════════════════════════════════════
  //                         INTERNALS
  // ═══════════════════════════════════════════════════════════════

  private async fetch(path: string, opts?: { method?: string; body?: unknown }): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: opts?.method || 'GET',
      headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new PingError(error.error || 'Request failed', res.status);
    }

    return res.json();
  }

  private sign(message: Record<string, unknown>): string {
    const msgBytes = new TextEncoder().encode(JSON.stringify(message));
    const sig = ed.sign(msgBytes, this.privateKey!);
    return bytesToHex(sig);
  }

  private requireAgent(): void {
    if (!this.agentId) {
      throw new PingError('Must register first (call register())', 400);
    }
  }

  private requireKeys(): void {
    if (!this.privateKey) {
      throw new PingError('Must generate or set keys first', 400);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//                         ERROR
// ═══════════════════════════════════════════════════════════════

export class PingError extends Error {
  constructor(message: string, public statusCode: number = 500) {
    super(message);
    this.name = 'PingError';
  }
}

// ═══════════════════════════════════════════════════════════════
//                         UTILITIES
// ═══════════════════════════════════════════════════════════════

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Default export
export default PingClient;
