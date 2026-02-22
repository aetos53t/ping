/**
 * PING Multisig Workflow Example
 * 
 * Demonstrates using PING for agent multisig coordination.
 * This is how PING integrates with Quorum (agent-multisig-api).
 */

import { PingClient } from '../sdk/src';

interface SignatureRequest {
  psbt: string;
  description: string;
  digest: string;
  expires: number;
}

interface SignatureResponse {
  signature: string;
  agentId: string;
}

async function main() {
  console.log('🏓 PING Multisig Workflow Example\n');
  console.log('Scenario: 2-of-3 agent multisig signing a transaction\n');

  // Create three agents (treasury multisig)
  const coordinator = new PingClient({ baseUrl: 'http://localhost:3100' });
  const signer1 = new PingClient({ baseUrl: 'http://localhost:3100' });
  const signer2 = new PingClient({ baseUrl: 'http://localhost:3100' });
  const signer3 = new PingClient({ baseUrl: 'http://localhost:3100' });

  // Generate keys and register
  console.log('🔑 Setting up agents...');
  
  await coordinator.generateKeys();
  await coordinator.register({
    name: 'Treasury Coordinator',
    provider: 'quorum',
    capabilities: ['coordinate-multisig'],
    isPublic: true,
  });
  console.log(`  Coordinator: ${coordinator.agentId}`);

  const signers = [
    { client: signer1, name: 'Signer Alpha', online: true },
    { client: signer2, name: 'Signer Beta', online: true },
    { client: signer3, name: 'Signer Gamma', online: false }, // offline
  ];

  for (const s of signers) {
    await s.client.generateKeys();
    await s.client.register({
      name: s.name,
      provider: 'aibtc',
      capabilities: ['sign-btc', 'sign-taproot'],
      isPublic: true,
    });
    console.log(`  ${s.name}: ${s.client.agentId} (${s.online ? 'online' : 'offline'})`);
  }

  // Coordinator creates a signing proposal
  console.log('\n📝 Creating signing proposal...');
  
  const proposal: SignatureRequest = {
    psbt: 'cHNidP8BAHUCAAAAASOMAoRAgaH0pASTw...',
    description: 'Transfer 0.01 BTC to development fund',
    digest: 'a1b2c3d4e5f6...', // The digest to sign
    expires: Date.now() + 3600000, // 1 hour
  };

  // Send proposal to all signers
  console.log('\n📤 Sending proposal to signers...');
  for (const s of signers) {
    const result = await coordinator.send({
      to: s.client.agentId,
      type: 'proposal',
      payload: proposal,
    });
    console.log(`  → ${s.name}: ${result.deliveryMethod}`);
  }

  // Simulate signers receiving and responding
  console.log('\n🔏 Signers processing proposals...');
  
  const signatures: SignatureResponse[] = [];
  
  for (const s of signers) {
    if (!s.online) {
      console.log(`  ${s.name}: OFFLINE (skipped)`);
      continue;
    }

    // Signer checks inbox
    const inbox = await s.client.inbox();
    const proposalMsg = inbox.find(m => m.type === 'proposal');
    
    if (proposalMsg) {
      // Acknowledge receipt
      await s.client.ack(proposalMsg.id);
      
      // Simulate signing (in reality, this would call the signing service)
      const mockSignature = `sig_${s.name.replace(' ', '_').toLowerCase()}_${Date.now()}`;
      
      // Send signature back
      await s.client.send({
        to: coordinator.agentId,
        type: 'signature',
        payload: { signature: mockSignature, agentId: s.client.agentId },
        replyTo: proposalMsg.id,
      });
      
      console.log(`  ${s.name}: ✅ Signed and sent response`);
      signatures.push({ signature: mockSignature, agentId: s.client.agentId });
    }
  }

  // Coordinator collects signatures
  console.log('\n📥 Coordinator collecting signatures...');
  
  const coordInbox = await coordinator.inbox();
  const sigResponses = coordInbox.filter(m => m.type === 'signature');
  
  console.log(`  Received ${sigResponses.length} signature(s)`);
  
  for (const sig of sigResponses) {
    await coordinator.ack(sig.id);
    const payload = sig.payload as SignatureResponse;
    const signerName = signers.find(s => s.client.agentId === payload.agentId)?.name;
    console.log(`  - ${signerName}: ${payload.signature.slice(0, 30)}...`);
  }

  // Check threshold
  const threshold = 2;
  const collected = sigResponses.length;
  
  console.log(`\n📊 Signature collection: ${collected}/${threshold} required`);
  
  if (collected >= threshold) {
    console.log('✅ Threshold met! Transaction can be broadcast.');
    
    // Notify all signers of success
    for (const s of signers) {
      await coordinator.text(
        s.client.agentId,
        `Transaction signed successfully! ${collected} of ${signers.length} signatures collected.`
      );
    }
  } else {
    console.log('⏳ Waiting for more signatures...');
  }

  console.log('\n✅ Workflow complete!');
}

main().catch(console.error);
