#!/usr/bin/env npx tsx
/**
 * PING Integration Test Suite
 * 
 * Run with: npx tsx test/integration.ts
 * 
 * Tests full flows:
 * - Agent registration
 * - Message sending/receiving
 * - Contact management
 * - Directory search
 * - Signature verification
 * - Error handling
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure Ed25519
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const BASE_URL = process.env.PING_URL || 'http://localhost:3100';
const VERBOSE = process.env.VERBOSE === 'true';

// ════════════════════════════════════════════════════════════════
//                         UTILITIES
// ════════════════════════════════════════════════════════════════

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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
  const sig = ed.sign(msgBytes, hexToBytes(privateKeyHex));
  return bytesToHex(sig);
}

async function request(path: string, opts?: { method?: string; body?: unknown }) {
  const url = `${BASE_URL}${path}`;
  if (VERBOSE) console.log(`  → ${opts?.method || 'GET'} ${path}`);
  
  const res = await fetch(url, {
    method: opts?.method || 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  
  const data = await res.json();
  
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${data.error || res.statusText}`);
  }
  
  return data;
}

// ════════════════════════════════════════════════════════════════
//                         TEST FRAMEWORK
// ════════════════════════════════════════════════════════════════

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: err, duration: Date.now() - start });
    console.log(`  ❌ ${name}: ${err}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: any, expected: any, message?: string) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertExists(value: any, message?: string) {
  if (value === null || value === undefined) {
    throw new Error(message || 'Expected value to exist');
  }
}

// ════════════════════════════════════════════════════════════════
//                         TEST STATE
// ════════════════════════════════════════════════════════════════

let alice: { id: string; privateKey: string; publicKey: string };
let bob: { id: string; privateKey: string; publicKey: string };
let lastMessageId: string;

// ════════════════════════════════════════════════════════════════
//                         TESTS
// ════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('\n🏓 PING Integration Tests\n');
  console.log(`Target: ${BASE_URL}\n`);

  // ────────────────────────────────────────────────────────────────
  //                         HEALTH
  // ────────────────────────────────────────────────────────────────

  console.log('Health Checks:');

  await test('GET / returns service info', async () => {
    const data = await request('/');
    assertEqual(data.name, 'PING');
    assertExists(data.version);
    assertExists(data.stats);
  });

  await test('GET /health returns ok', async () => {
    const data = await request('/health');
    assertEqual(data.status, 'ok');
  });

  // ────────────────────────────────────────────────────────────────
  //                         AGENTS
  // ────────────────────────────────────────────────────────────────

  console.log('\nAgent Registration:');

  await test('Register agent with valid publicKey', async () => {
    const keys = await generateKeys();
    const data = await request('/agents', {
      method: 'POST',
      body: {
        publicKey: keys.publicKey,
        name: 'Alice Test',
        provider: 'integration-test',
        capabilities: ['chat', 'sign'],
        isPublic: true,
      },
    });
    assertExists(data.id);
    assertEqual(data.name, 'Alice Test');
    alice = { id: data.id, ...keys };
  });

  await test('Register second agent', async () => {
    const keys = await generateKeys();
    const data = await request('/agents', {
      method: 'POST',
      body: {
        publicKey: keys.publicKey,
        name: 'Bob Test',
        provider: 'integration-test',
        capabilities: ['chat'],
        isPublic: true,
      },
    });
    assertExists(data.id);
    bob = { id: data.id, ...keys };
  });

  await test('Reject duplicate publicKey', async () => {
    try {
      await request('/agents', {
        method: 'POST',
        body: {
          publicKey: alice.publicKey,
          name: 'Duplicate',
        },
      });
      throw new Error('Should have rejected');
    } catch (e) {
      assert(String(e).includes('409') || String(e).includes('already exists'), 'Expected 409 conflict');
    }
  });

  await test('Reject invalid publicKey format', async () => {
    try {
      await request('/agents', {
        method: 'POST',
        body: {
          publicKey: 'invalid-key',
          name: 'Bad Key',
        },
      });
      throw new Error('Should have rejected');
    } catch (e) {
      assert(String(e).includes('400') || String(e).includes('Invalid'), 'Expected 400 bad request');
    }
  });

  await test('Get agent by ID', async () => {
    const data = await request(`/agents/${alice.id}`);
    assertEqual(data.id, alice.id);
    assertEqual(data.name, 'Alice Test');
  });

  await test('Return 404 for unknown agent', async () => {
    try {
      await request('/agents/00000000-0000-0000-0000-000000000000');
      throw new Error('Should have returned 404');
    } catch (e) {
      assert(String(e).includes('404') || String(e).includes('not found'), 'Expected 404');
    }
  });

  // ────────────────────────────────────────────────────────────────
  //                         DIRECTORY
  // ────────────────────────────────────────────────────────────────

  console.log('\nDirectory:');

  await test('List public agents', async () => {
    const data = await request('/directory');
    assert(Array.isArray(data), 'Expected array');
    const alice_found = data.find((a: any) => a.id === alice.id);
    assertExists(alice_found, 'Alice should be in directory');
  });

  await test('Search by capability', async () => {
    const data = await request('/directory/search?capability=sign');
    assert(Array.isArray(data), 'Expected array');
    // Alice has 'sign', Bob doesn't
    const hasSign = data.every((a: any) => a.capabilities?.includes('sign'));
    assert(hasSign, 'All results should have sign capability');
  });

  await test('Search by provider', async () => {
    const data = await request('/directory/search?provider=integration-test');
    assert(Array.isArray(data), 'Expected array');
    assert(data.length >= 2, 'Should find at least Alice and Bob');
  });

  // ────────────────────────────────────────────────────────────────
  //                         MESSAGES
  // ────────────────────────────────────────────────────────────────

  console.log('\nMessaging:');

  await test('Send message with valid signature', async () => {
    const message = {
      type: 'text',
      from: alice.id,
      to: bob.id,
      payload: { text: 'Hello Bob!' },
      timestamp: Date.now(),
    };
    const signature = signMessage(message, alice.privateKey);

    const data = await request('/messages', {
      method: 'POST',
      body: { ...message, signature },
    });
    assertExists(data.id);
    lastMessageId = data.id;
  });

  await test('Reject message with invalid signature', async () => {
    const message = {
      type: 'text',
      from: alice.id,
      to: bob.id,
      payload: { text: 'Fake message' },
      timestamp: Date.now(),
    };
    // Sign with wrong key
    const badSig = 'a'.repeat(128);

    try {
      await request('/messages', {
        method: 'POST',
        body: { ...message, signature: badSig },
      });
      throw new Error('Should have rejected');
    } catch (e) {
      assert(String(e).includes('401') || String(e).includes('signature'), 'Expected 401 invalid signature');
    }
  });

  await test('Reject message to unknown recipient', async () => {
    const message = {
      type: 'text',
      from: alice.id,
      to: '00000000-0000-0000-0000-000000000000',
      payload: { text: 'Hello?' },
      timestamp: Date.now(),
    };
    const signature = signMessage(message, alice.privateKey);

    try {
      await request('/messages', {
        method: 'POST',
        body: { ...message, signature },
      });
      throw new Error('Should have rejected');
    } catch (e) {
      assert(String(e).includes('404') || String(e).includes('not found'), 'Expected 404');
    }
  });

  await test('Get inbox shows messages', async () => {
    const data = await request(`/agents/${bob.id}/inbox`);
    assert(Array.isArray(data), 'Expected array');
    assert(data.length > 0, 'Bob should have messages');
    const msg = data.find((m: any) => m.id === lastMessageId);
    assertExists(msg, 'Should find the message we sent');
    assertEqual(msg.from, alice.id);
  });

  await test('Acknowledge message', async () => {
    await request(`/messages/${lastMessageId}/ack`, { method: 'POST' });
    
    // Check it's no longer in unacked inbox
    const inbox = await request(`/agents/${bob.id}/inbox`);
    const msg = inbox.find((m: any) => m.id === lastMessageId);
    assert(!msg, 'Acknowledged message should not be in inbox');
  });

  await test('Get all messages including acknowledged', async () => {
    const data = await request(`/agents/${bob.id}/inbox?all=true`);
    const msg = data.find((m: any) => m.id === lastMessageId);
    assertExists(msg, 'Should find acknowledged message with all=true');
  });

  await test('Get conversation history', async () => {
    // Send a reply from Bob
    const message = {
      type: 'text',
      from: bob.id,
      to: alice.id,
      payload: { text: 'Hey Alice!' },
      replyTo: lastMessageId,
      timestamp: Date.now(),
    };
    const signature = signMessage(message, bob.privateKey);
    await request('/messages', { method: 'POST', body: { ...message, signature } });

    // Get conversation
    const history = await request(`/agents/${alice.id}/messages/${bob.id}?limit=10`);
    assert(Array.isArray(history), 'Expected array');
    assert(history.length >= 2, 'Should have at least 2 messages');
  });

  // ────────────────────────────────────────────────────────────────
  //                         CONTACTS
  // ────────────────────────────────────────────────────────────────

  console.log('\nContacts:');

  await test('Add contact', async () => {
    await request(`/agents/${alice.id}/contacts`, {
      method: 'POST',
      body: {
        contactId: bob.id,
        alias: 'Bobby',
        notes: 'Test contact',
      },
    });
  });

  await test('Reject duplicate contact', async () => {
    try {
      await request(`/agents/${alice.id}/contacts`, {
        method: 'POST',
        body: { contactId: bob.id },
      });
      throw new Error('Should have rejected');
    } catch (e) {
      assert(String(e).includes('409') || String(e).includes('Already'), 'Expected 409 conflict');
    }
  });

  await test('List contacts', async () => {
    const data = await request(`/agents/${alice.id}/contacts`);
    assert(Array.isArray(data), 'Expected array');
    const contact = data.find((c: any) => c.contactId === bob.id);
    assertExists(contact, 'Should find Bob in contacts');
    assertEqual(contact.alias, 'Bobby');
  });

  await test('Remove contact', async () => {
    await request(`/agents/${alice.id}/contacts/${bob.id}`, { method: 'DELETE' });
    
    const contacts = await request(`/agents/${alice.id}/contacts`);
    const contact = contacts.find((c: any) => c.contactId === bob.id);
    assert(!contact, 'Bob should be removed from contacts');
  });

  // ────────────────────────────────────────────────────────────────
  //                         EDGE CASES
  // ────────────────────────────────────────────────────────────────

  console.log('\nEdge Cases:');

  await test('Handle empty payload', async () => {
    const message = {
      type: 'ping',
      from: alice.id,
      to: bob.id,
      payload: {},
      timestamp: Date.now(),
    };
    const signature = signMessage(message, alice.privateKey);
    const data = await request('/messages', { method: 'POST', body: { ...message, signature } });
    assertExists(data.id);
  });

  await test('Handle large payload', async () => {
    const message = {
      type: 'custom',
      from: alice.id,
      to: bob.id,
      payload: {
        data: 'x'.repeat(10000),
        nested: { deep: { value: 123 } },
      },
      timestamp: Date.now(),
    };
    const signature = signMessage(message, alice.privateKey);
    const data = await request('/messages', { method: 'POST', body: { ...message, signature } });
    assertExists(data.id);
  });

  await test('Handle special characters in name', async () => {
    const keys = await generateKeys();
    const data = await request('/agents', {
      method: 'POST',
      body: {
        publicKey: keys.publicKey,
        name: 'Test Agent 🤖 <script>alert(1)</script>',
        isPublic: false,
      },
    });
    assertExists(data.id);
    // Cleanup
    await request(`/agents/${data.id}`, { method: 'DELETE' });
  });

  // ────────────────────────────────────────────────────────────────
  //                         CLEANUP
  // ────────────────────────────────────────────────────────────────

  console.log('\nCleanup:');

  await test('Delete test agents', async () => {
    await request(`/agents/${alice.id}`, { method: 'DELETE' });
    await request(`/agents/${bob.id}`, { method: 'DELETE' });
  });

  // ────────────────────────────────────────────────────────────────
  //                         SUMMARY
  // ────────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(50));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`Results: ${passed} passed, ${failed} failed (${totalTime}ms)`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  console.log('\n✅ All tests passed!\n');
}

runTests().catch(err => {
  console.error('\n💥 Test suite crashed:', err);
  process.exit(1);
});
