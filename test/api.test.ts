/**
 * PING API Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const BASE_URL = process.env.TEST_URL || 'http://localhost:3100';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateKeys() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
  };
}

function signMessage(message: any, privateKeyHex: string): string {
  const msgBytes = new TextEncoder().encode(JSON.stringify(message));
  const privBytes = new Uint8Array(privateKeyHex.length / 2);
  for (let i = 0; i < privBytes.length; i++) {
    privBytes[i] = parseInt(privateKeyHex.slice(i * 2, i * 2 + 2), 16);
  }
  const sig = ed.sign(msgBytes, privBytes);
  return bytesToHex(sig);
}

describe('Health', () => {
  it('GET / returns service info', async () => {
    const res = await fetch(`${BASE_URL}/`);
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(data.name).toBe('PING');
    expect(data.version).toBe('0.1.0');
  });

  it('GET /health returns status', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(data.status).toBe('ok');
  });
});

describe('Agents', () => {
  let testAgent: { id: string; publicKey: string; privateKey: string };

  it('POST /agents registers a new agent', async () => {
    const keys = await generateKeys();
    
    const res = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: keys.publicKey,
        name: 'Test Agent',
        provider: 'test',
        capabilities: ['chat', 'sign'],
        isPublic: true,
      }),
    });
    
    const data = await res.json();
    
    expect(res.status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBe('Test Agent');
    expect(data.provider).toBe('test');
    
    testAgent = { id: data.id, ...keys };
  });

  it('POST /agents rejects duplicate publicKey', async () => {
    const res = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: testAgent.publicKey,
        name: 'Duplicate Agent',
      }),
    });
    
    expect(res.status).toBe(409);
  });

  it('POST /agents rejects invalid publicKey', async () => {
    const res = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: 'invalid',
        name: 'Bad Agent',
      }),
    });
    
    expect(res.status).toBe(400);
  });

  it('GET /agents/:id returns agent info', async () => {
    const res = await fetch(`${BASE_URL}/agents/${testAgent.id}`);
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(data.id).toBe(testAgent.id);
    expect(data.name).toBe('Test Agent');
  });

  it('GET /agents/:id returns 404 for unknown agent', async () => {
    const res = await fetch(`${BASE_URL}/agents/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('DELETE /agents/:id removes agent', async () => {
    // Create a new agent to delete
    const keys = await generateKeys();
    const createRes = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: keys.publicKey,
        name: 'Agent To Delete',
      }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${BASE_URL}/agents/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    // Verify deleted
    const getRes = await fetch(`${BASE_URL}/agents/${id}`);
    expect(getRes.status).toBe(404);
  });
});

describe('Directory', () => {
  it('GET /directory returns public agents', async () => {
    const res = await fetch(`${BASE_URL}/directory`);
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /directory/search filters by capability', async () => {
    const res = await fetch(`${BASE_URL}/directory/search?capability=chat`);
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    for (const agent of data) {
      expect(agent.capabilities).toContain('chat');
    }
  });
});

describe('Messages', () => {
  let alice: { id: string; publicKey: string; privateKey: string };
  let bob: { id: string; publicKey: string; privateKey: string };

  beforeAll(async () => {
    // Create two agents for messaging tests
    const aliceKeys = await generateKeys();
    const bobKeys = await generateKeys();

    const aliceRes = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: aliceKeys.publicKey,
        name: 'Alice (Test)',
        isPublic: true,
      }),
    });
    const aliceData = await aliceRes.json();
    alice = { id: aliceData.id, ...aliceKeys };

    const bobRes = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: bobKeys.publicKey,
        name: 'Bob (Test)',
        isPublic: true,
      }),
    });
    const bobData = await bobRes.json();
    bob = { id: bobData.id, ...bobKeys };
  });

  it('POST /messages sends a message', async () => {
    const message = {
      type: 'text',
      from: alice.id,
      to: bob.id,
      payload: { text: 'Hello Bob!' },
      timestamp: Date.now(),
    };

    const signature = signMessage(message, alice.privateKey);

    const res = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, signature }),
    });

    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.id).toBeDefined();
  });

  it('POST /messages rejects invalid signature', async () => {
    const message = {
      type: 'text',
      from: alice.id,
      to: bob.id,
      payload: { text: 'Fake message' },
      timestamp: Date.now(),
    };

    const res = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, signature: 'a'.repeat(128) }),
    });

    expect(res.status).toBe(401);
  });

  it('GET /agents/:id/inbox returns messages', async () => {
    // Send a message first
    const message = {
      type: 'ping',
      from: alice.id,
      to: bob.id,
      payload: {},
      timestamp: Date.now(),
    };
    const signature = signMessage(message, alice.privateKey);
    
    await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, signature }),
    });

    // Check Bob's inbox
    const res = await fetch(`${BASE_URL}/agents/${bob.id}/inbox`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].from).toBe(alice.id);
  });

  it('POST /messages/:id/ack acknowledges message', async () => {
    // Get a message from inbox
    const inboxRes = await fetch(`${BASE_URL}/agents/${bob.id}/inbox`);
    const inbox = await inboxRes.json();
    const msg = inbox[0];

    const res = await fetch(`${BASE_URL}/messages/${msg.id}/ack`, { method: 'POST' });
    expect(res.status).toBe(200);

    // Verify it's acknowledged (won't appear in unacknowledged inbox)
    const newInboxRes = await fetch(`${BASE_URL}/agents/${bob.id}/inbox`);
    const newInbox = await newInboxRes.json();
    const found = newInbox.find((m: any) => m.id === msg.id);
    expect(found).toBeUndefined();
  });

  it('GET /agents/:id/messages/:otherId returns conversation', async () => {
    const res = await fetch(`${BASE_URL}/agents/${alice.id}/messages/${bob.id}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('Contacts', () => {
  let agent1: { id: string };
  let agent2: { id: string };

  beforeAll(async () => {
    const keys1 = await generateKeys();
    const keys2 = await generateKeys();

    const res1 = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: keys1.publicKey, name: 'Contact Test 1' }),
    });
    agent1 = await res1.json();

    const res2 = await fetch(`${BASE_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: keys2.publicKey, name: 'Contact Test 2' }),
    });
    agent2 = await res2.json();
  });

  it('POST /agents/:id/contacts adds a contact', async () => {
    const res = await fetch(`${BASE_URL}/agents/${agent1.id}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId: agent2.id,
        alias: 'My Friend',
        notes: 'Test contact',
      }),
    });

    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.contactId).toBe(agent2.id);
    expect(data.alias).toBe('My Friend');
  });

  it('GET /agents/:id/contacts returns contacts', async () => {
    const res = await fetch(`${BASE_URL}/agents/${agent1.id}/contacts`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('DELETE /agents/:id/contacts/:contactId removes contact', async () => {
    const res = await fetch(`${BASE_URL}/agents/${agent1.id}/contacts/${agent2.id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);

    // Verify removed
    const getRes = await fetch(`${BASE_URL}/agents/${agent1.id}/contacts`);
    const contacts = await getRes.json();
    const found = contacts.find((c: any) => c.contactId === agent2.id);
    expect(found).toBeUndefined();
  });
});
