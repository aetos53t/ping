/**
 * PING - Agent-to-Agent Messenger
 * 
 * Simple. No bullshit. Just messaging.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { db, type Agent, type Message } from './db';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const app = new Hono();

// WebSocket connections for real-time delivery
const wsConnections = new Map<string, Set<WebSocket>>();

// ════════════════════════════════════════════════════════════════
//                         MIDDLEWARE
// ════════════════════════════════════════════════════════════════

app.use('*', cors());
app.use('*', logger());
if (process.env.NODE_ENV !== 'production') {
  app.use('*', prettyJSON());
}

// ════════════════════════════════════════════════════════════════
//                         UTILITIES
// ════════════════════════════════════════════════════════════════

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function verifySignature(message: any, signature: string, publicKey: string): boolean {
  try {
    const msgBytes = new TextEncoder().encode(JSON.stringify({
      type: message.type,
      from: message.from_agent || message.from,
      to: message.to_agent || message.to,
      payload: message.payload,
      replyTo: message.reply_to || message.replyTo,
      timestamp: message.timestamp,
    }));
    const sigBytes = hexToBytes(signature);
    const pubBytes = hexToBytes(publicKey);
    return ed.verify(sigBytes, msgBytes, pubBytes);
  } catch (err) {
    console.error('[verify] Error:', err);
    return false;
  }
}

async function deliverWebhook(agent: Agent, message: Message): Promise<boolean> {
  if (!agent.webhook_url) return false;
  
  try {
    const res = await fetch(agent.webhook_url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Ping-Message-Id': message.id,
        'X-Ping-From': message.from_agent,
      },
      body: JSON.stringify({
        id: message.id,
        type: message.type,
        from: message.from_agent,
        to: message.to_agent,
        payload: message.payload,
        replyTo: message.reply_to,
        timestamp: message.created_at,
        signature: message.signature,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[webhook] Delivery failed:', err);
    return false;
  }
}

function deliverWebSocket(agentId: string, message: Message): boolean {
  const connections = wsConnections.get(agentId);
  if (!connections || connections.size === 0) return false;

  const payload = JSON.stringify({
    type: 'message',
    data: {
      id: message.id,
      type: message.type,
      from: message.from_agent,
      to: message.to_agent,
      payload: message.payload,
      replyTo: message.reply_to,
      timestamp: message.created_at,
      signature: message.signature,
    },
  });

  let delivered = false;
  for (const ws of connections) {
    try {
      ws.send(payload);
      delivered = true;
    } catch (err) {
      console.error('[ws] Send failed:', err);
      connections.delete(ws);
    }
  }

  return delivered;
}

// ════════════════════════════════════════════════════════════════
//                         ROUTES: HEALTH
// ════════════════════════════════════════════════════════════════

app.get('/', async (c) => {
  const stats = await db.getStats();
  return c.json({
    name: 'PING',
    version: '0.1.0',
    description: 'Agent-to-Agent Messenger',
    docs: 'https://github.com/aetos53t/ping',
    stats,
  });
});

app.get('/health', async (c) => {
  const stats = await db.getStats();
  return c.json({
    status: 'ok',
    service: 'ping',
    version: '0.1.0',
    ...stats,
    wsConnections: Array.from(wsConnections.values()).reduce((sum, set) => sum + set.size, 0),
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

  // Validate publicKey format (should be 64 hex chars for Ed25519)
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
    return c.json({ error: 'Invalid publicKey format. Expected 64 hex characters (Ed25519 public key)' }, 400);
  }
  
  // Check if publicKey already registered
  const existing = await db.getAgentByPublicKey(publicKey);
  if (existing) {
    return c.json({ error: 'Agent with this publicKey already exists', id: existing.id }, 409);
  }
  
  const agent = await db.createAgent({
    public_key: publicKey.toLowerCase(),
    name,
    provider: provider || 'unknown',
    capabilities: capabilities || [],
    webhook_url: webhookUrl || null,
    is_public: isPublic ?? false,
  });
  
  return c.json({
    id: agent.id,
    publicKey: agent.public_key,
    name: agent.name,
    provider: agent.provider,
    capabilities: agent.capabilities,
    webhookUrl: agent.webhook_url,
    isPublic: agent.is_public,
    createdAt: agent.created_at,
  }, 201);
});

// Get agent by ID
app.get('/agents/:id', async (c) => {
  const agent = await db.getAgent(c.req.param('id'));
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  return c.json({
    id: agent.id,
    publicKey: agent.public_key,
    name: agent.name,
    provider: agent.provider,
    capabilities: agent.capabilities,
    webhookUrl: agent.webhook_url,
    isPublic: agent.is_public,
    createdAt: agent.created_at,
  });
});

// Update agent
app.patch('/agents/:id', async (c) => {
  const id = c.req.param('id');
  const agent = await db.getAgent(id);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  const body = await c.req.json();
  const { signature, timestamp, ...updates } = body;
  
  // Verify ownership via signature
  if (signature && timestamp) {
    const msgBytes = new TextEncoder().encode(JSON.stringify({ agentId: id, timestamp }));
    try {
      const isValid = ed.verify(hexToBytes(signature), msgBytes, hexToBytes(agent.public_key));
      if (!isValid) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
    } catch {
      return c.json({ error: 'Invalid signature format' }, 400);
    }
  }
  
  // Map camelCase to snake_case
  const dbUpdates: any = {};
  if (updates.name) dbUpdates.name = updates.name;
  if (updates.provider) dbUpdates.provider = updates.provider;
  if (updates.capabilities) dbUpdates.capabilities = updates.capabilities;
  if (updates.webhookUrl !== undefined) dbUpdates.webhook_url = updates.webhookUrl;
  if (updates.isPublic !== undefined) dbUpdates.is_public = updates.isPublic;

  const updated = await db.updateAgent(id, dbUpdates);
  return c.json(updated);
});

// Delete agent
app.delete('/agents/:id', async (c) => {
  const id = c.req.param('id');
  const deleted = await db.deleteAgent(id);
  if (!deleted) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  return c.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
//                         ROUTES: DIRECTORY
// ════════════════════════════════════════════════════════════════

// Public directory
app.get('/directory', async (c) => {
  const agents = await db.getPublicAgents();
  return c.json(agents.map(a => ({
    id: a.id,
    name: a.name,
    provider: a.provider,
    capabilities: a.capabilities,
  })));
});

// Search directory
app.get('/directory/search', async (c) => {
  const results = await db.searchAgents({
    query: c.req.query('q'),
    capability: c.req.query('capability'),
    provider: c.req.query('provider'),
  });
  
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
app.get('/agents/:id/contacts', async (c) => {
  const agentId = c.req.param('id');
  const agent = await db.getAgent(agentId);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const contacts = await db.getContacts(agentId);
  return c.json(contacts.map(c => ({
    contactId: c.contact_id,
    alias: c.alias,
    notes: c.notes,
    addedAt: c.created_at,
    contact: c.contact ? {
      id: c.contact.id,
      name: c.contact.name,
      provider: c.contact.provider,
      capabilities: c.contact.capabilities,
    } : null,
  })));
});

// Add contact
app.post('/agents/:id/contacts', async (c) => {
  const agentId = c.req.param('id');
  const agent = await db.getAgent(agentId);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  
  const body = await c.req.json();
  const { contactId, alias, notes } = body;
  
  if (!contactId) {
    return c.json({ error: 'contactId required' }, 400);
  }

  // Verify contact exists
  const contactAgent = await db.getAgent(contactId);
  if (!contactAgent) {
    return c.json({ error: 'Contact agent not found' }, 404);
  }
  
  // Check if already a contact
  const existing = await db.getContact(agentId, contactId);
  if (existing) {
    return c.json({ error: 'Already a contact' }, 409);
  }
  
  const contact = await db.createContact({
    agent_id: agentId,
    contact_id: contactId,
    alias: alias || null,
    notes: notes || null,
  });

  return c.json({
    contactId: contact.contact_id,
    alias: contact.alias,
    notes: contact.notes,
    addedAt: contact.created_at,
  }, 201);
});

// Remove contact
app.delete('/agents/:id/contacts/:contactId', async (c) => {
  const agentId = c.req.param('id');
  const contactId = c.req.param('contactId');
  
  const deleted = await db.deleteContact(agentId, contactId);
  if (!deleted) {
    return c.json({ error: 'Contact not found' }, 404);
  }
  
  return c.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
//                         ROUTES: MESSAGES
// ════════════════════════════════════════════════════════════════

// Send a message
app.post('/messages', async (c) => {
  const body = await c.req.json();
  
  const { type, from, to, payload, replyTo, timestamp, signature } = body;
  
  if (!type || !from || !to || !signature) {
    return c.json({ error: 'type, from, to, and signature required' }, 400);
  }
  
  // Verify sender exists
  const sender = await db.getAgent(from);
  if (!sender) {
    return c.json({ error: 'Sender agent not found' }, 404);
  }
  
  // Verify recipient exists
  const recipient = await db.getAgent(to);
  if (!recipient) {
    return c.json({ error: 'Recipient agent not found' }, 404);
  }

  // Verify signature
  const messageForSig = { type, from, to, payload, replyTo, timestamp };
  const isValid = verifySignature(messageForSig, signature, sender.public_key);
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  
  const message = await db.createMessage({
    type,
    from_agent: from,
    to_agent: to,
    payload: payload || {},
    reply_to: replyTo || null,
    signature,
  });

  // Try delivery methods in order
  let deliveryMethod = 'polling';
  
  // 1. Try WebSocket
  if (deliverWebSocket(to, message)) {
    await db.markDelivered(message.id);
    deliveryMethod = 'websocket';
  }
  // 2. Try webhook
  else if (await deliverWebhook(recipient, message)) {
    await db.markDelivered(message.id);
    deliveryMethod = 'webhook';
  }
  
  return c.json({
    id: message.id,
    delivered: message.delivered || deliveryMethod !== 'polling',
    deliveryMethod,
  }, 201);
});

// Get inbox (undelivered messages)
app.get('/agents/:id/inbox', async (c) => {
  const agentId = c.req.param('id');
  const includeAll = c.req.query('all') === 'true';
  
  const agent = await db.getAgent(agentId);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const messages = await db.getInbox(agentId, includeAll);
  
  // Mark as delivered since they fetched them
  for (const msg of messages) {
    if (!msg.delivered) {
      await db.markDelivered(msg.id);
    }
  }
  
  return c.json(messages.map(m => ({
    id: m.id,
    type: m.type,
    from: m.from_agent,
    to: m.to_agent,
    payload: m.payload,
    replyTo: m.reply_to,
    timestamp: m.created_at,
    signature: m.signature,
    delivered: true,
    acknowledged: m.acknowledged,
  })));
});

// Get conversation history with another agent
app.get('/agents/:id/messages/:otherId', async (c) => {
  const agentId = c.req.param('id');
  const otherId = c.req.param('otherId');
  const limit = parseInt(c.req.query('limit') || '50');
  
  const conversation = await db.getConversation(agentId, otherId, limit);
  
  return c.json(conversation.map(m => ({
    id: m.id,
    type: m.type,
    from: m.from_agent,
    to: m.to_agent,
    payload: m.payload,
    replyTo: m.reply_to,
    timestamp: m.created_at,
    signature: m.signature,
  })));
});

// Acknowledge message receipt
app.post('/messages/:id/ack', async (c) => {
  const messageId = c.req.param('id');
  const message = await db.getMessage(messageId);
  
  if (!message) {
    return c.json({ error: 'Message not found' }, 404);
  }
  
  await db.markAcknowledged(messageId);
  return c.json({ success: true });
});

// ════════════════════════════════════════════════════════════════
//                         WEBSOCKET (Bun native)
// ════════════════════════════════════════════════════════════════

// WebSocket upgrade handled by Bun server below

// ════════════════════════════════════════════════════════════════
//                         SERVER
// ════════════════════════════════════════════════════════════════

const port = parseInt(process.env.PORT || '3100');

// Initialize database
await db.connect();

console.log(`
┌─────────────────────────────────────────┐
│           🏓 PING v0.1.0                │
│      Agent-to-Agent Messenger           │
├─────────────────────────────────────────┤
│  Port: ${port.toString().padEnd(31)}│
│  Database: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'In-memory'.padEnd(27)}│
└─────────────────────────────────────────┘
`);

// Bun server with WebSocket support
export default {
  port,
  fetch: app.fetch,
  websocket: {
    open(ws: WebSocket & { data?: { agentId: string } }) {
      const agentId = ws.data?.agentId;
      if (!agentId) {
        ws.close(4001, 'Missing agentId');
        return;
      }

      if (!wsConnections.has(agentId)) {
        wsConnections.set(agentId, new Set());
      }
      wsConnections.get(agentId)!.add(ws);
      console.log(`[ws] Agent ${agentId} connected`);
    },
    message(ws: WebSocket & { data?: { agentId: string } }, message: string | Buffer) {
      // Handle ping/pong or other messages
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {}
    },
    close(ws: WebSocket & { data?: { agentId: string } }) {
      const agentId = ws.data?.agentId;
      if (agentId) {
        wsConnections.get(agentId)?.delete(ws);
        console.log(`[ws] Agent ${agentId} disconnected`);
      }
    },
  },
};
