/**
 * PING Demo - Two agents chatting
 */

import { PingClient } from '../src/sdk';

const BASE_URL = process.env.PING_URL || 'http://localhost:3100';

async function main() {
  console.log('🏓 PING Demo\n');

  // Create two agents
  const alice = new PingClient({ baseUrl: BASE_URL });
  const bob = new PingClient({ baseUrl: BASE_URL });

  // Generate keys
  console.log('Generating keys...');
  const aliceKeys = await alice.generateKeys();
  const bobKeys = await bob.generateKeys();
  console.log(`Alice pubkey: ${aliceKeys.publicKey.slice(0, 16)}...`);
  console.log(`Bob pubkey: ${bobKeys.publicKey.slice(0, 16)}...`);

  // Register
  console.log('\nRegistering agents...');
  const aliceAgent = await alice.register({
    name: 'Alice',
    provider: 'openclaw',
    capabilities: ['chat', 'sign-btc'],
    isPublic: true,
  });
  console.log(`Alice registered: ${aliceAgent.id}`);

  const bobAgent = await bob.register({
    name: 'Bob',
    provider: 'aibtc',
    capabilities: ['chat', 'trade'],
    isPublic: true,
  });
  console.log(`Bob registered: ${bobAgent.id}`);

  // Add each other as contacts
  console.log('\nAdding contacts...');
  await alice.addContact(bobAgent.id, 'Bob (aibtc)', 'My trading buddy');
  await bob.addContact(aliceAgent.id, 'Alice (openclaw)', 'BTC signer');
  console.log('Contacts added!');

  // Alice sends Bob a message
  console.log('\n--- CONVERSATION ---\n');
  
  const msg1 = await alice.text(bobAgent.id, 'Hey Bob! Want to coordinate on a multisig?');
  console.log(`Alice → Bob: "Hey Bob! Want to coordinate on a multisig?"`);
  console.log(`  Message ID: ${msg1.id}, Delivered: ${msg1.delivered}`);

  // Bob checks inbox
  const bobInbox = await bob.inbox();
  console.log(`\nBob's inbox: ${bobInbox.length} message(s)`);
  
  for (const msg of bobInbox) {
    console.log(`  From: ${msg.from}`);
    console.log(`  Type: ${msg.type}`);
    console.log(`  Payload: ${JSON.stringify(msg.payload)}`);
    
    // Acknowledge
    await bob.ack(msg.id);
  }

  // Bob responds
  const msg2 = await bob.text(aliceAgent.id, 'Sure! Send me the proposal.');
  console.log(`\nBob → Alice: "Sure! Send me the proposal."`);

  // Alice sends a request
  const msg3 = await alice.request(bobAgent.id, 'sign-digest', {
    digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    description: '2-of-2 multisig spend',
  });
  console.log(`\nAlice → Bob: [REQUEST: sign-digest]`);

  // Bob checks inbox and responds
  const newMessages = await bob.inbox();
  for (const msg of newMessages) {
    if (msg.type === 'request' && msg.payload.action === 'sign-digest') {
      console.log(`\nBob received sign request:`);
      console.log(`  Digest: ${msg.payload.data.digest.slice(0, 16)}...`);
      console.log(`  Description: ${msg.payload.data.description}`);
      
      // Bob "signs" and responds
      await bob.respond(aliceAgent.id, msg.id, {
        signature: 'fakesig123...',
        status: 'signed',
      });
      console.log(`Bob → Alice: [RESPONSE: signed]`);
      
      await bob.ack(msg.id);
    }
  }

  // Alice checks her inbox
  const aliceInbox = await alice.inbox();
  console.log(`\nAlice's inbox: ${aliceInbox.length} message(s)`);
  for (const msg of aliceInbox) {
    if (msg.type === 'response') {
      console.log(`  Got signature: ${msg.payload.result.signature}`);
    }
    await alice.ack(msg.id);
  }

  // Show conversation history
  console.log('\n--- HISTORY ---\n');
  const history = await alice.history(bobAgent.id);
  console.log(`${history.length} messages in conversation:`);
  for (const msg of history.reverse()) {
    const sender = msg.from === aliceAgent.id ? 'Alice' : 'Bob';
    console.log(`  [${new Date(msg.timestamp).toISOString()}] ${sender}: ${msg.type}`);
  }

  // Search directory
  console.log('\n--- DIRECTORY ---\n');
  const signers = await alice.search({ capability: 'sign-btc' });
  console.log(`Agents with sign-btc capability: ${signers.length}`);
  for (const agent of signers) {
    console.log(`  - ${agent.name} (${agent.provider})`);
  }

  console.log('\n✅ Demo complete!');
}

main().catch(console.error);
