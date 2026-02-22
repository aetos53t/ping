/**
 * PING + Quorum Integration Example
 * 
 * Demonstrates using PING for agent coordination with Quorum multisig.
 * 
 * Flow:
 * 1. Treasury agent creates a Bitcoin transaction proposal
 * 2. PING notifies signer agents
 * 3. Signers fetch the PSBT from Quorum API
 * 4. Signers submit signatures back via PING
 * 5. Treasury agent collects signatures and broadcasts
 */

import { PingClient } from '../sdk/src';

const QUORUM_URL = process.env.QUORUM_URL || 'https://agent-multisig-api-production.up.railway.app';
const PING_URL = process.env.PING_URL || 'http://localhost:3100';

interface MultisigConfig {
  multisigId: string;
  threshold: number;
  signers: Array<{
    agentId: string;
    publicKey: string;
    pingId?: string;
  }>;
}

// Example 2-of-3 multisig configuration
const MULTISIG_CONFIG: MultisigConfig = {
  multisigId: 'treasury-001',
  threshold: 2,
  signers: [
    { agentId: 'alpha', publicKey: 'pk1...', pingId: '' },
    { agentId: 'beta', publicKey: 'pk2...', pingId: '' },
    { agentId: 'gamma', publicKey: 'pk3...', pingId: '' },
  ],
};

async function main() {
  console.log('🏓 PING + Quorum Integration\n');
  console.log(`PING: ${PING_URL}`);
  console.log(`Quorum: ${QUORUM_URL}\n`);

  // ═══════════════════════════════════════════════════════════════
  //                   SETUP: Register all agents on PING
  // ═══════════════════════════════════════════════════════════════

  console.log('📝 Setting up agents...\n');

  // Treasury coordinator
  const treasury = new PingClient({ baseUrl: PING_URL });
  await treasury.generateKeys();
  const treasuryAgent = await treasury.register({
    name: 'Treasury Coordinator',
    provider: 'quorum',
    capabilities: ['coordinate-multisig', 'sign-btc'],
    isPublic: true,
  });
  console.log(`  Treasury: ${treasuryAgent.id}`);

  // Signer agents
  const signerClients: PingClient[] = [];
  for (let i = 0; i < MULTISIG_CONFIG.signers.length; i++) {
    const signer = MULTISIG_CONFIG.signers[i];
    const client = new PingClient({ baseUrl: PING_URL });
    await client.generateKeys();
    const agent = await client.register({
      name: `Signer ${signer.agentId}`,
      provider: 'aibtc',
      capabilities: ['sign-btc', 'sign-taproot'],
      isPublic: true,
    });
    signer.pingId = agent.id;
    signerClients.push(client);
    console.log(`  Signer ${signer.agentId}: ${agent.id}`);
  }

  // Add signers as contacts
  for (const signer of MULTISIG_CONFIG.signers) {
    await treasury.addContact(
      signer.pingId!,
      `Signer ${signer.agentId}`,
      `Multisig ${MULTISIG_CONFIG.multisigId}`
    );
  }
  console.log('\n  Contacts added to treasury\n');

  // ═══════════════════════════════════════════════════════════════
  //                   STEP 1: Create Proposal
  // ═══════════════════════════════════════════════════════════════

  console.log('💰 Creating transaction proposal...\n');

  // In reality, this would call Quorum API to create a PSBT
  const proposal = {
    id: `prop-${Date.now()}`,
    multisigId: MULTISIG_CONFIG.multisigId,
    description: 'Transfer 0.01 BTC to development fund',
    psbt: 'cHNidP8BAHUCAAAAASOMAoRAgaH0pASTw...', // Base64 PSBT
    threshold: MULTISIG_CONFIG.threshold,
    signers: MULTISIG_CONFIG.signers.map(s => s.agentId),
    expiresAt: Date.now() + 3600000, // 1 hour
    createdAt: Date.now(),
  };

  console.log(`  Proposal ID: ${proposal.id}`);
  console.log(`  Description: ${proposal.description}`);
  console.log(`  Threshold: ${proposal.threshold}/${proposal.signers.length}`);

  // ═══════════════════════════════════════════════════════════════
  //                   STEP 2: Notify Signers via PING
  // ═══════════════════════════════════════════════════════════════

  console.log('\n📤 Notifying signers...\n');

  for (const signer of MULTISIG_CONFIG.signers) {
    const result = await treasury.send({
      to: signer.pingId!,
      type: 'proposal',
      payload: {
        action: 'sign-psbt',
        proposalId: proposal.id,
        multisigId: proposal.multisigId,
        description: proposal.description,
        psbtUrl: `${QUORUM_URL}/proposals/${proposal.id}/psbt`,
        expiresAt: proposal.expiresAt,
      },
    });
    console.log(`  → Signer ${signer.agentId}: ${result.deliveryMethod}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                   STEP 3: Signers Process and Sign
  // ═══════════════════════════════════════════════════════════════

  console.log('\n🔏 Signers processing proposals...\n');

  const signatures: Array<{ agentId: string; signature: string }> = [];

  for (let i = 0; i < signerClients.length; i++) {
    const client = signerClients[i];
    const signer = MULTISIG_CONFIG.signers[i];

    // Check inbox
    const inbox = await client.inbox();
    const proposalMsg = inbox.find(m => m.type === 'proposal');

    if (!proposalMsg) {
      console.log(`  Signer ${signer.agentId}: No proposal found`);
      continue;
    }

    // Acknowledge receipt
    await client.ack(proposalMsg.id);

    // In reality, signer would:
    // 1. Fetch PSBT from Quorum API
    // 2. Verify transaction details
    // 3. Sign with their key
    // 4. Submit signature to Quorum API

    const mockSignature = `sig_${signer.agentId}_${Date.now().toString(36)}`;
    signatures.push({ agentId: signer.agentId, signature: mockSignature });

    // Send signature back via PING
    await client.send({
      to: treasury.agentId,
      type: 'signature',
      payload: {
        proposalId: proposal.id,
        signature: mockSignature,
        signerAgentId: signer.agentId,
      },
      replyTo: proposalMsg.id,
    });

    console.log(`  Signer ${signer.agentId}: ✅ Signed`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                   STEP 4: Collect Signatures
  // ═══════════════════════════════════════════════════════════════

  console.log('\n📥 Treasury collecting signatures...\n');

  const coordInbox = await treasury.inbox();
  const sigMessages = coordInbox.filter(m => m.type === 'signature');

  console.log(`  Received ${sigMessages.length} signature(s)`);

  for (const msg of sigMessages) {
    await treasury.ack(msg.id);
    const payload = msg.payload as { signerAgentId: string; signature: string };
    console.log(`  - ${payload.signerAgentId}: ${payload.signature.slice(0, 20)}...`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                   STEP 5: Threshold Check
  // ═══════════════════════════════════════════════════════════════

  const collected = sigMessages.length;
  const threshold = MULTISIG_CONFIG.threshold;

  console.log(`\n📊 Threshold: ${collected}/${threshold}`);

  if (collected >= threshold) {
    console.log('\n✅ Threshold met!');
    console.log('   Would now:');
    console.log('   1. Submit signatures to Quorum API');
    console.log('   2. Quorum combines and broadcasts');
    console.log('   3. Treasury notifies all signers of success');

    // Notify all signers
    for (const signer of MULTISIG_CONFIG.signers) {
      await treasury.text(
        signer.pingId!,
        `🎉 Transaction ${proposal.id} signed and broadcast! ${collected}/${MULTISIG_CONFIG.signers.length} signatures collected.`
      );
    }
  } else {
    console.log('\n⏳ Waiting for more signatures...');
    console.log(`   Need ${threshold - collected} more`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                   SUMMARY
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '═'.repeat(50));
  console.log('Integration Summary:');
  console.log('═'.repeat(50));
  console.log(`
  PING provides:
  ✓ Agent discovery (directory, search)
  ✓ Contact management  
  ✓ Message delivery (WebSocket, webhook, polling)
  ✓ Signature verification (Ed25519)
  ✓ Conversation threading (replyTo)

  Quorum provides:
  ✓ Multisig wallet creation
  ✓ PSBT generation
  ✓ Signature collection
  ✓ Transaction broadcast

  Together:
  ✓ Agents find each other via PING directory
  ✓ Proposals sent via PING messages
  ✓ PSBT details fetched from Quorum API
  ✓ Signatures sent back via PING
  ✓ Quorum combines and broadcasts
  `);

  console.log('Done! 🏓');
}

main().catch(console.error);
