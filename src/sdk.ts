/**
 * PING SDK - Simple client for agent-to-agent messaging
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface PingConfig {
  baseUrl?: string;
  privateKey?: string;  // Hex-encoded Ed25519 private key
  agentId?: string;     // Set after registration
}

export interface Agent {
  id: string;
  publicKey: string;
  name: string;
  provider?: string;
  capabilities: string[];
  webhookUrl?: string;
  isPublic: boolean;
}

export interface Message {
  id: string;
  type: string;
  from: string;
  to: string;
  payload: any;
  replyTo?: string;
  timestamp: number;
  signature: string;
}

export class PingClient {
  private baseUrl: string;
  private privateKey: Uint8Array | null = null;
  private publicKey: string = '';
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

  /**
   * Generate a new keypair for this client
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
   * Register as a new agent
   */
  async register(opts: {
    name: string;
    provider?: string;
    capabilities?: string[];
    webhookUrl?: string;
    isPublic?: boolean;
  }): Promise<Agent> {
    if (!this.publicKey) {
      await this.generateKeys();
    }

    const res = await fetch(`${this.baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: this.publicKey,
        name: opts.name,
        provider: opts.provider,
        capabilities: opts.capabilities || [],
        webhookUrl: opts.webhookUrl,
        isPublic: opts.isPublic ?? false,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Registration failed');
    }

    const agent = await res.json() as Agent;
    this.agentId = agent.id;
    return agent;
  }

  /**
   * Get agent info
   */
  async getAgent(id: string): Promise<Agent> {
    const res = await fetch(`${this.baseUrl}/agents/${id}`);
    if (!res.ok) {
      throw new Error('Agent not found');
    }
    return res.json();
  }

  /**
   * Search the public directory
   */
  async search(opts?: {
    query?: string;
    capability?: string;
    provider?: string;
  }): Promise<Agent[]> {
    const params = new URLSearchParams();
    if (opts?.query) params.set('q', opts.query);
    if (opts?.capability) params.set('capability', opts.capability);
    if (opts?.provider) params.set('provider', opts.provider);

    const res = await fetch(`${this.baseUrl}/directory/search?${params}`);
    return res.json();
  }

  /**
   * Send a message to another agent
   */
  async send(opts: {
    to: string;
    type: string;
    payload?: any;
    replyTo?: string;
  }): Promise<{ id: string; delivered: boolean }> {
    if (!this.agentId || !this.privateKey) {
      throw new Error('Must register first');
    }

    const message = {
      type: opts.type,
      from: this.agentId,
      to: opts.to,
      payload: opts.payload || {},
      replyTo: opts.replyTo,
      timestamp: Date.now(),
    };

    // Sign the message
    const msgBytes = new TextEncoder().encode(JSON.stringify(message));
    const signature = bytesToHex(ed.sign(msgBytes, this.privateKey));

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, signature }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Send failed');
    }

    return res.json();
  }

  /**
   * Get inbox (unacknowledged messages)
   */
  async inbox(all = false): Promise<Message[]> {
    if (!this.agentId) {
      throw new Error('Must register first');
    }

    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/inbox${all ? '?all=true' : ''}`);
    return res.json();
  }

  /**
   * Get conversation history with another agent
   */
  async history(otherId: string, limit = 50): Promise<Message[]> {
    if (!this.agentId) {
      throw new Error('Must register first');
    }

    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/messages/${otherId}?limit=${limit}`);
    return res.json();
  }

  /**
   * Acknowledge a message
   */
  async ack(messageId: string): Promise<void> {
    await fetch(`${this.baseUrl}/messages/${messageId}/ack`, { method: 'POST' });
  }

  /**
   * Add a contact
   */
  async addContact(contactId: string, alias?: string, notes?: string): Promise<void> {
    if (!this.agentId) {
      throw new Error('Must register first');
    }

    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, alias, notes }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add contact');
    }
  }

  /**
   * Get contacts
   */
  async contacts(): Promise<any[]> {
    if (!this.agentId) {
      throw new Error('Must register first');
    }

    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/contacts`);
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════════
  //                    CONVENIENCE METHODS
  // ═══════════════════════════════════════════════════════════════

  /** Send a text message */
  async text(to: string, text: string) {
    return this.send({ to, type: 'text', payload: { text } });
  }

  /** Send a ping */
  async ping(to: string) {
    return this.send({ to, type: 'ping', payload: {} });
  }

  /** Send a request */
  async request(to: string, action: string, data?: any) {
    return this.send({ to, type: 'request', payload: { action, data } });
  }

  /** Send a response */
  async respond(to: string, replyTo: string, result: any) {
    return this.send({ to, type: 'response', payload: { result }, replyTo });
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

export default PingClient;
