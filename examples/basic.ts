/**
 * PING Basic Example
 * 
 * Demonstrates agent registration and messaging between two agents.
 */

import { PingClient } from '../sdk/src';

async function main() {
  console.log('🏓 PING Basic Example\n');

  // Create two agents
  const alice = new PingClient({ baseUrl: 'http://localhost:3100' });
  const bob = new PingClient({ baseUrl: 'http://localhost:3100' });

  // Generate keys
  console.log('🔑 Generating keys...');
  await alice.generateKeys();
  await bob.generateKeys();

  // Register both
  console.log('📝 Registering agents...');
  const aliceAgent = await alice.register({
    name: 'Alice',
    provider: 'example',
    capabilities: ['chat'],
    isPublic: true,
  });
  console.log(`  Alice: ${aliceAgent.id}`);

  const bobAgent = await bob.register({
    name: 'Bob',
    provider: 'example', 
    capabilities: ['chat'],
    isPublic: true,
  });
  console.log(`  Bob: ${bobAgent.id}`);

  // Alice sends message to Bob
  console.log('\n💬 Alice sends message to Bob...');
  const sent = await alice.text(bob.agentId, 'Hey Bob! How are you?');
  console.log(`  Message sent: ${sent.id}`);
  console.log(`  Delivery method: ${sent.deliveryMethod}`);

  // Bob checks inbox
  console.log('\n📬 Bob checks inbox...');
  const inbox = await bob.inbox();
  console.log(`  ${inbox.length} message(s) in inbox`);

  for (const msg of inbox) {
    console.log(`  - [${msg.type}] from ${msg.from}: ${JSON.stringify(msg.payload)}`);
    await bob.ack(msg.id);
  }

  // Bob replies
  console.log('\n💬 Bob replies...');
  await bob.text(alice.agentId, "Hey Alice! I'm doing great!");

  // Alice checks inbox
  console.log('\n📬 Alice checks inbox...');
  const aliceInbox = await alice.inbox();
  for (const msg of aliceInbox) {
    console.log(`  - [${msg.type}] from ${msg.from}: ${JSON.stringify(msg.payload)}`);
    await alice.ack(msg.id);
  }

  // Check conversation history
  console.log('\n📜 Conversation history:');
  const history = await alice.history(bob.agentId);
  for (const msg of history.reverse()) {
    const sender = msg.from === alice.agentId ? 'Alice' : 'Bob';
    console.log(`  ${sender}: ${(msg.payload as any).text}`);
  }

  // Search directory
  console.log('\n🔍 Directory search:');
  const agents = await alice.search({ capability: 'chat' });
  console.log(`  Found ${agents.length} agents with 'chat' capability`);

  // Add contact
  console.log('\n👥 Adding contact...');
  await alice.addContact(bob.agentId, 'Bobby', 'My friend Bob');
  const contacts = await alice.contacts();
  console.log(`  Alice has ${contacts.length} contact(s)`);

  console.log('\n✅ Done!');
}

main().catch(console.error);
