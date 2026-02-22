/**
 * Database layer for PING
 * 
 * Uses PostgreSQL for persistence, falls back to in-memory for dev.
 */

import { Pool } from 'pg';

// ════════════════════════════════════════════════════════════════
//                         TYPES
// ════════════════════════════════════════════════════════════════

export interface Agent {
  id: string;
  public_key: string;
  name: string;
  provider: string;
  capabilities: string[];
  webhook_url: string | null;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Message {
  id: string;
  type: string;
  from_agent: string;
  to_agent: string;
  payload: any;
  reply_to: string | null;
  signature: string;
  delivered: boolean;
  acknowledged: boolean;
  created_at: Date;
}

export interface Contact {
  id: string;
  agent_id: string;
  contact_id: string;
  alias: string | null;
  notes: string | null;
  created_at: Date;
}

// ════════════════════════════════════════════════════════════════
//                         DATABASE CLASS
// ════════════════════════════════════════════════════════════════

export class Database {
  private pool: Pool | null = null;
  private useMemory: boolean = false;
  
  // In-memory fallback
  private agents = new Map<string, Agent>();
  private messages: Message[] = [];
  private contacts: Contact[] = [];

  async connect(databaseUrl?: string): Promise<void> {
    const url = databaseUrl || process.env.DATABASE_URL;
    
    if (!url) {
      console.log('[db] No DATABASE_URL, using in-memory storage');
      this.useMemory = true;
      return;
    }

    try {
      this.pool = new Pool({ connectionString: url });
      await this.pool.query('SELECT 1');
      console.log('[db] Connected to PostgreSQL');
      await this.migrate();
    } catch (err) {
      console.error('[db] Failed to connect, falling back to in-memory:', err);
      this.useMemory = true;
    }
  }

  async migrate(): Promise<void> {
    if (this.useMemory || !this.pool) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        public_key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        provider TEXT DEFAULT 'unknown',
        capabilities TEXT[] DEFAULT '{}',
        webhook_url TEXT,
        is_public BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type TEXT NOT NULL,
        from_agent UUID NOT NULL REFERENCES agents(id),
        to_agent UUID NOT NULL REFERENCES agents(id),
        payload JSONB DEFAULT '{}',
        reply_to UUID REFERENCES messages(id),
        signature TEXT NOT NULL,
        delivered BOOLEAN DEFAULT false,
        acknowledged BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        alias TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(agent_id, contact_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agents_is_public ON agents(is_public);
    `);

    console.log('[db] Migrations complete');
  }

  // ════════════════════════════════════════════════════════════════
  //                         AGENTS
  // ════════════════════════════════════════════════════════════════

  async createAgent(data: Omit<Agent, 'id' | 'created_at' | 'updated_at'>): Promise<Agent> {
    if (this.useMemory) {
      const agent: Agent = {
        id: crypto.randomUUID(),
        ...data,
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.agents.set(agent.id, agent);
      return agent;
    }

    const result = await this.pool!.query(`
      INSERT INTO agents (public_key, name, provider, capabilities, webhook_url, is_public)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [data.public_key, data.name, data.provider, data.capabilities, data.webhook_url, data.is_public]);

    return result.rows[0];
  }

  async getAgent(id: string): Promise<Agent | null> {
    if (this.useMemory) {
      return this.agents.get(id) || null;
    }

    const result = await this.pool!.query('SELECT * FROM agents WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async getAgentByPublicKey(publicKey: string): Promise<Agent | null> {
    if (this.useMemory) {
      for (const agent of this.agents.values()) {
        if (agent.public_key === publicKey) return agent;
      }
      return null;
    }

    const result = await this.pool!.query('SELECT * FROM agents WHERE public_key = $1', [publicKey]);
    return result.rows[0] || null;
  }

  async updateAgent(id: string, data: Partial<Agent>): Promise<Agent | null> {
    if (this.useMemory) {
      const agent = this.agents.get(id);
      if (!agent) return null;
      Object.assign(agent, data, { updated_at: new Date() });
      return agent;
    }

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (key !== 'id' && key !== 'created_at') {
        fields.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (fields.length === 0) return this.getAgent(id);

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.pool!.query(
      `UPDATE agents SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  }

  async deleteAgent(id: string): Promise<boolean> {
    if (this.useMemory) {
      return this.agents.delete(id);
    }

    const result = await this.pool!.query('DELETE FROM agents WHERE id = $1', [id]);
    return (result.rowCount || 0) > 0;
  }

  async getPublicAgents(): Promise<Agent[]> {
    if (this.useMemory) {
      return Array.from(this.agents.values()).filter(a => a.is_public);
    }

    const result = await this.pool!.query('SELECT * FROM agents WHERE is_public = true ORDER BY created_at DESC');
    return result.rows;
  }

  async searchAgents(opts: { query?: string; capability?: string; provider?: string }): Promise<Agent[]> {
    if (this.useMemory) {
      let results = Array.from(this.agents.values()).filter(a => a.is_public);
      
      if (opts.query) {
        const q = opts.query.toLowerCase();
        results = results.filter(a => 
          a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
        );
      }
      if (opts.capability) {
        results = results.filter(a => a.capabilities.includes(opts.capability!));
      }
      if (opts.provider) {
        results = results.filter(a => a.provider === opts.provider);
      }
      
      return results;
    }

    let query = 'SELECT * FROM agents WHERE is_public = true';
    const values: any[] = [];
    let idx = 1;

    if (opts.query) {
      query += ` AND (name ILIKE $${idx} OR id::text ILIKE $${idx})`;
      values.push(`%${opts.query}%`);
      idx++;
    }
    if (opts.capability) {
      query += ` AND $${idx} = ANY(capabilities)`;
      values.push(opts.capability);
      idx++;
    }
    if (opts.provider) {
      query += ` AND provider = $${idx}`;
      values.push(opts.provider);
      idx++;
    }

    query += ' ORDER BY created_at DESC';
    const result = await this.pool!.query(query, values);
    return result.rows;
  }

  // ════════════════════════════════════════════════════════════════
  //                         MESSAGES
  // ════════════════════════════════════════════════════════════════

  async createMessage(data: Omit<Message, 'id' | 'created_at' | 'delivered' | 'acknowledged'>): Promise<Message> {
    if (this.useMemory) {
      const message: Message = {
        id: crypto.randomUUID(),
        ...data,
        delivered: false,
        acknowledged: false,
        created_at: new Date(),
      };
      this.messages.push(message);
      return message;
    }

    const result = await this.pool!.query(`
      INSERT INTO messages (type, from_agent, to_agent, payload, reply_to, signature)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [data.type, data.from_agent, data.to_agent, data.payload, data.reply_to, data.signature]);

    return result.rows[0];
  }

  async getMessage(id: string): Promise<Message | null> {
    if (this.useMemory) {
      return this.messages.find(m => m.id === id) || null;
    }

    const result = await this.pool!.query('SELECT * FROM messages WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async getInbox(agentId: string, includeAcknowledged = false): Promise<Message[]> {
    if (this.useMemory) {
      let msgs = this.messages.filter(m => m.to_agent === agentId);
      if (!includeAcknowledged) {
        msgs = msgs.filter(m => !m.acknowledged);
      }
      return msgs.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    }

    let query = 'SELECT * FROM messages WHERE to_agent = $1';
    if (!includeAcknowledged) {
      query += ' AND acknowledged = false';
    }
    query += ' ORDER BY created_at DESC';

    const result = await this.pool!.query(query, [agentId]);
    return result.rows;
  }

  async getConversation(agentId: string, otherId: string, limit = 50): Promise<Message[]> {
    if (this.useMemory) {
      return this.messages
        .filter(m => 
          (m.from_agent === agentId && m.to_agent === otherId) ||
          (m.from_agent === otherId && m.to_agent === agentId)
        )
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(0, limit);
    }

    const result = await this.pool!.query(`
      SELECT * FROM messages 
      WHERE (from_agent = $1 AND to_agent = $2) OR (from_agent = $2 AND to_agent = $1)
      ORDER BY created_at DESC
      LIMIT $3
    `, [agentId, otherId, limit]);

    return result.rows;
  }

  async markDelivered(id: string): Promise<void> {
    if (this.useMemory) {
      const msg = this.messages.find(m => m.id === id);
      if (msg) msg.delivered = true;
      return;
    }

    await this.pool!.query('UPDATE messages SET delivered = true WHERE id = $1', [id]);
  }

  async markAcknowledged(id: string): Promise<void> {
    if (this.useMemory) {
      const msg = this.messages.find(m => m.id === id);
      if (msg) msg.acknowledged = true;
      return;
    }

    await this.pool!.query('UPDATE messages SET acknowledged = true WHERE id = $1', [id]);
  }

  // ════════════════════════════════════════════════════════════════
  //                         CONTACTS
  // ════════════════════════════════════════════════════════════════

  async createContact(data: Omit<Contact, 'id' | 'created_at'>): Promise<Contact> {
    if (this.useMemory) {
      const contact: Contact = {
        id: crypto.randomUUID(),
        ...data,
        created_at: new Date(),
      };
      this.contacts.push(contact);
      return contact;
    }

    const result = await this.pool!.query(`
      INSERT INTO contacts (agent_id, contact_id, alias, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [data.agent_id, data.contact_id, data.alias, data.notes]);

    return result.rows[0];
  }

  async getContacts(agentId: string): Promise<(Contact & { contact: Agent | null })[]> {
    if (this.useMemory) {
      return this.contacts
        .filter(c => c.agent_id === agentId)
        .map(c => ({
          ...c,
          contact: this.agents.get(c.contact_id) || null,
        }));
    }

    const result = await this.pool!.query(`
      SELECT c.*, row_to_json(a.*) as contact
      FROM contacts c
      LEFT JOIN agents a ON a.id = c.contact_id
      WHERE c.agent_id = $1
      ORDER BY c.created_at DESC
    `, [agentId]);

    return result.rows;
  }

  async getContact(agentId: string, contactId: string): Promise<Contact | null> {
    if (this.useMemory) {
      return this.contacts.find(c => c.agent_id === agentId && c.contact_id === contactId) || null;
    }

    const result = await this.pool!.query(
      'SELECT * FROM contacts WHERE agent_id = $1 AND contact_id = $2',
      [agentId, contactId]
    );
    return result.rows[0] || null;
  }

  async deleteContact(agentId: string, contactId: string): Promise<boolean> {
    if (this.useMemory) {
      const idx = this.contacts.findIndex(c => c.agent_id === agentId && c.contact_id === contactId);
      if (idx === -1) return false;
      this.contacts.splice(idx, 1);
      return true;
    }

    const result = await this.pool!.query(
      'DELETE FROM contacts WHERE agent_id = $1 AND contact_id = $2',
      [agentId, contactId]
    );
    return (result.rowCount || 0) > 0;
  }

  // ════════════════════════════════════════════════════════════════
  //                         STATS
  // ════════════════════════════════════════════════════════════════

  async getStats(): Promise<{ agents: number; messages: number; contacts: number }> {
    if (this.useMemory) {
      return {
        agents: this.agents.size,
        messages: this.messages.length,
        contacts: this.contacts.length,
      };
    }

    const [agents, messages, contacts] = await Promise.all([
      this.pool!.query('SELECT COUNT(*) FROM agents'),
      this.pool!.query('SELECT COUNT(*) FROM messages'),
      this.pool!.query('SELECT COUNT(*) FROM contacts'),
    ]);

    return {
      agents: parseInt(agents.rows[0].count),
      messages: parseInt(messages.rows[0].count),
      contacts: parseInt(contacts.rows[0].count),
    };
  }
}

export const db = new Database();
