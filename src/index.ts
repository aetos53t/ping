/**
 * PING - Agent-to-Agent Messenger
 * 
 * Simple. No bullshit. Just messaging.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const app = new Hono();

// ════════════════════════════════════════════════════════════════
//                         STORAGE (in-memory for MVP)
// ════════════════════════════════════════════════════════════════

interface Agent {
  id: string;
  publicKey: string;
  name: string;
  provider?: string;
  capabilities: string[];
  webhookUrl?: string;
  createdAt: number;
  isPublic: boolean;
}

interface Message {
  id: string;
  type: string;
  from: string;
  to: string;
  payload: any;
  replyTo?: string;
  timestamp: number;
  signature: string;
  delivered: boolean;
  acknowledged: boolean;
}

interface Contact {
  agentId: string;
  contactId: string;
  alias?: string;
  notes?: string;
  addedAt: number;
}

const agents = new Map<string, Agent>();
const messages: Message[] = [];
const contacts: Contact[] = [];

// ════════════════════════════════════════════════════════════════
//                         MIDDLEWARE
// ════════════════════════════════════════════════════════════════

app.use('*', cors());
app.use('*', logger());

// ════════════════════════════════════════════════════════════════
//                         UTILITIES
// ════════════════════════════════════════════════════════════════

function generateId(): string {
  return crypto.randomUUID();
}

function verifySignature(message: any, signature: string, publicKey: string): boolean {
  try {
    const msgBytes = new TextEncoder().encode(JSON.stringify({
      type: message.type,
      from: message.from,
      to: message.to,
      payload: message.payload,
      replyTo: message.replyTo,
      timestamp: message.timestamp,
    }));
    const sigBytes = hexToBytes(signature);
    const pubBytes = hexToBytes(publicKey);
    return ed.verify(sigBytes, msgBytes, pubBytes);
  } catch {
    return false;
  }
}

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

async function deliverWebhook(agent: Agent, message: Message): Promise<boolean> {
  if (!agent.webhookUrl) return false;
  
  try {
    const res = await fetch(agent.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//                         ROUTES: HEALTH
// ════════════════════════════════════════════════════════════════

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'ping',
    version: '0.1.0',
    agents: agents.size,
    messages: messages.length,
  });
});

// ════════════════════════════════════════════════════════════════
//                         ROUTES: AGENTS
// ════════════════════════════════════════════════════════════════

// Register a new agent
app.post('/agents', async (c) => {
  const body = await c.req.json();
  
  const { publicKey, name, provider, capabilities, webhookUrl, isPublic } = body;
  
  if (!publicKey || !name) {
    return c.json({ error: 'publicKey and name required' }, 400);
  }
  
  // Check if publicKey already registered
  for (const agent of agents.values()) {
    if (agent.publicKey === publicKey) {
      return c.json({ error: 'Agent with this publicKey already exists', id: agent.id }, 409);
    }
  }
  
  const agent: Agent = {
    id: generateId(),
    publicKey,
    name,
    provider: provider || 'unknown',
    capabilities: capabilities || [],
    webhookUrl,
    createdAt: Date.now(),
    isPublic: isPublic ?? false,
  };
  
  agents.set(agent.id, agent);
  
  return c.json(agent, 201);
});

// Get agent by ID
app.get('/agents/:id', (c) => {
  const agent = agents.get(c.req.param('id'));
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  return c.json(agent);
});

// Update agent
app.patch('/agents/:id', async (c) => {
  const agent = agents.get(c.req.param('id'));
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  const body = await c.req.json();
  const { signature, ...updates } = body;
  
  // TODO: Verify signature proves ownership
  
  Object.assign(agent, updates);
  return c.json(agent);
});

// Delete agent
app.delete('/agents/:id', (c) => {
  const id = c.req.param('id');
  if (!agents.has(id)) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  agents.delete(id);
  return c.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
//                         ROUTES: DIRECTORY
// ════════════════════════════════════════════════════════════════

// Public directory
app.get('/directory', (c) => {
  const publicAgents = Array.from(agents.values())
    .filter(a => a.isPublic)
    .map(a => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      capabilities: a.capabilities,
    }));
  
  return c.json(publicAgents);
});

// Search directory
app.get('/directory/search', (c) => {
  const query = c.req.query('q')?.toLowerCase();
  const capability = c.req.query('capability');
  const provider = c.req.query('provider');
  
  let results = Array.from(agents.values()).filter(a => a.isPublic);
  
  if (query) {
    results = results.filter(a => 
      a.name.toLowerCase().includes(query) ||
      a.id.toLowerCase().includes(query)
    );
  }
  
  if (capability) {
    results = results.filter(a => a.capabilities.includes(capability));
  }
  
  if (provider) {
    results = results.filter(a => a.provider === provider);
  }
  
  return c.json(results.map(a => ({
    id: a.id,
    name: a.name,
    provider: a.provider,
    capabilities: a.capabilities,
  })));
});

// ════════════════════════════════════════════════════════════════
//                         ROUTES: CONTACTS
// ════════════════════════════════════════════════════════════════

// Get contacts for an agent
app.get('/agents/:id/contacts', (c) => {
  const agentId = c.req.param('id');
  const agentContacts = contacts
    .filter(c => c.agentId === agentId)
    .map(c => {
      const contact = agents.get(c.contactId);
      return {
        ...c,
        contact: contact ? { id: contact.id, name: contact.name, provider: contact.provider } : null,
      };
    });
  
  return c.json(agentContacts);
});

// Add contact
app.post('/agents/:id/contacts', async (c) => {
  const agentId = c.req.param('id');
  const body = await c.req.json();
  
  if (!agents.has(agentId)) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  const { contactId, alias, notes } = body;
  
  if (!contactId) {
    return c.json({ error: 'contactId required' }, 400);
  }
  
  // Check if already a contact
  const existing = contacts.find(c => c.agentId === agentId && c.contactId === contactId);
  if (existing) {
    return c.json({ error: 'Already a contact' }, 409);
  }
  
  const contact: Contact = {
    agentId,
    contactId,
    alias,
    notes,
    addedAt: Date.now(),
  };
  
  contacts.push(contact);
  return c.json(contact, 201);
});

// Remove contact
app.delete('/agents/:id/contacts/:contactId', (c) => {
  const agentId = c.req.param('id');
  const contactId = c.req.param('contactId');
  
  const idx = contacts.findIndex(c => c.agentId === agentId && c.contactId === contactId);
  if (idx === -1) {
    return c.json({ error: 'Contact not found' }, 404);
  }
  
  contacts.splice(idx, 1);
  return c.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
//                         ROUTES: MESSAGES
// ════════════════════════════════════════════════════════════════

// Send a message
app.post('/messages', async (c) => {
  const body = await c.req.json();
  
  const { type, from, to, payload, replyTo, signature } = body;
  
  if (!type || !from || !to || !signature) {
    return c.json({ error: 'type, from, to, and signature required' }, 400);
  }
  
  // Verify sender exists
  const sender = agents.get(from);
  if (!sender) {
    return c.json({ error: 'Sender agent not found' }, 404);
  }
  
  // Verify recipient exists
  const recipient = agents.get(to);
  if (!recipient) {
    return c.json({ error: 'Recipient agent not found' }, 404);
  }
  
  const message: Message = {
    id: generateId(),
    type,
    from,
    to,
    payload: payload || {},
    replyTo,
    timestamp: Date.now(),
    signature,
    delivered: false,
    acknowledged: false,
  };
  
  // Verify signature
  const isValid = verifySignature(message, signature, sender.publicKey);
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  
  messages.push(message);
  
  // Try webhook delivery
  const webhookSuccess = await deliverWebhook(recipient, message);
  if (webhookSuccess) {
    message.delivered = true;
  }
  
  return c.json({
    id: message.id,
    delivered: message.delivered,
    deliveryMethod: webhookSuccess ? 'webhook' : 'polling',
  }, 201);
});

// Get inbox (undelivered messages)
app.get('/agents/:id/inbox', (c) => {
  const agentId = c.req.param('id');
  const includeDelivered = c.req.query('all') === 'true';
  
  let inbox = messages.filter(m => m.to === agentId);
  
  if (!includeDelivered) {
    inbox = inbox.filter(m => !m.acknowledged);
  }
  
  // Mark as delivered (they fetched them)
  inbox.forEach(m => m.delivered = true);
  
  return c.json(inbox);
});

// Get conversation history with another agent
app.get('/agents/:id/messages/:otherId', (c) => {
  const agentId = c.req.param('id');
  const otherId = c.req.param('otherId');
  const limit = parseInt(c.req.query('limit') || '50');
  
  const conversation = messages
    .filter(m => 
      (m.from === agentId && m.to === otherId) ||
      (m.from === otherId && m.to === agentId)
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
  
  return c.json(conversation);
});

// Acknowledge message receipt
app.post('/messages/:id/ack', (c) => {
  const messageId = c.req.param('id');
  const message = messages.find(m => m.id === messageId);
  
  if (!message) {
    return c.json({ error: 'Message not found' }, 404);
  }
  
  message.acknowledged = true;
  return c.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
//                         SERVER
// ════════════════════════════════════════════════════════════════

const port = parseInt(process.env.PORT || '3100');

console.log(`
┌─────────────────────────────────────────┐
│           PING v0.1.0                   │
│     Agent-to-Agent Messenger            │
├─────────────────────────────────────────┤
│  Port: ${port.toString().padEnd(31)}│
│  Agents: ${agents.size.toString().padEnd(29)}│
└─────────────────────────────────────────┘
`);

export default {
  port,
  fetch: app.fetch,
};
