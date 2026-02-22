/**
 * PING - Agent-to-Agent Messenger (Node.js compatible)
 * 
 * Simple. No bullshit. Just messaging.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { serve } from '@hono/node-server';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import * as fs from 'fs';
import * as path from 'path';
import { db, type Agent, type Message } from './db.js';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const app = new Hono();

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

// ════════════════════════════════════════════════════════════════
//                         ROUTES: STATIC
// ════════════════════════════════════════════════════════════════

// Serve landing page
app.get('/landing', (c) => {
  try {
    const html = fs.readFileSync(path.join(process.cwd(), 'landing/index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Landing page not found', 404);
  }
});

// Admin dashboard (protected with simple token auth)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'ping-admin-secret';

app.get('/admin', (c) => {
  // Check auth via query param or cookie
  const token = c.req.query('token') || c.req.header('X-Admin-Token');
  
  if (token !== ADMIN_TOKEN) {
    return c.html(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>PING Admin - Login</title>
        <style>
          body { font-family: sans-serif; background: #09090b; color: #fafafa; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
          .login { background: #18181b; padding: 2rem; border-radius: 8px; text-align: center; }
          h1 { font-size: 1.5rem; margin-bottom: 1rem; }
          input { padding: 0.75rem; font-size: 1rem; border: 1px solid #3f3f46; border-radius: 6px; background: #27272a; color: #fff; width: 200px; }
          button { padding: 0.75rem 1.5rem; font-size: 1rem; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="login">
          <h1>🏓 PING Admin</h1>
          <form action="/admin" method="get">
            <input type="password" name="token" placeholder="Admin token" required />
            <br>
            <button type="submit">Login</button>
          </form>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const html = fs.readFileSync(path.join(process.cwd(), 'admin/index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('Admin page not found', 404);
  }
});

// Admin API: Get ALL agents (not just public)
app.get('/admin/agents', async (c) => {
  const token = c.req.header('X-Admin-Token') || c.req.query('token');
  if (token !== ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  // Get all agents including private ones
  const stats = await db.getStats();
  const publicAgents = await db.getPublicAgents();
  // For now return public agents - in production you'd query all
  return c.json(publicAgents);
});

// Admin API: Get ALL messages for an agent
app.get('/admin/agents/:id/messages', async (c) => {
  const token = c.req.header('X-Admin-Token') || c.req.query('token');
  if (token !== ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const agentId = c.req.param('id');
  const messages = await db.getInbox(agentId, true);
  return c.json(messages);
});

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
  return c.json(contacts.map(ct => ({
    contactId: ct.contact_id,
    alias: ct.alias,
    notes: ct.notes,
    addedAt: ct.created_at,
    contact: ct.contact ? {
      id: ct.contact.id,
      name: ct.contact.name,
      provider: ct.contact.provider,
      capabilities: ct.contact.capabilities,
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

  // Try webhook delivery
  let deliveryMethod = 'polling';
  if (await deliverWebhook(recipient, message)) {
    await db.markDelivered(message.id);
    deliveryMethod = 'webhook';
  }
  
  return c.json({
    id: message.id,
    delivered: deliveryMethod !== 'polling',
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
│  Runtime: Node.js                       │
│  Database: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'In-memory'.padEnd(27)}│
└─────────────────────────────────────────┘
`);

serve({
  fetch: app.fetch,
  port,
});
