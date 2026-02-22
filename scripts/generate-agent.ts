#!/usr/bin/env npx tsx
/**
 * Generate Agent Credentials
 * 
 * Creates a new Ed25519 keypair and optionally registers with PING.
 * 
 * Usage:
 *   npx tsx scripts/generate-agent.ts                    # Generate keys only
 *   npx tsx scripts/generate-agent.ts --register "Bot"   # Generate and register
 *   npx tsx scripts/generate-agent.ts --help
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import * as fs from 'fs';
import * as path from 'path';

// Configure Ed25519
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const PING_URL = process.env.PING_URL || 'http://localhost:3100';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function printUsage() {
  console.log(`
🏓 PING Agent Generator

Usage:
  npx tsx scripts/generate-agent.ts [options]

Options:
  --register <name>     Register with PING after generating keys
  --provider <name>     Provider name (default: "generated")
  --capabilities <list> Comma-separated capabilities
  --public              Make agent discoverable
  --output <file>       Save credentials to file
  --url <url>           PING server URL (default: $PING_URL or localhost:3100)
  --help                Show this help

Examples:
  # Generate keys only
  npx tsx scripts/generate-agent.ts

  # Generate and register
  npx tsx scripts/generate-agent.ts --register "My Bot" --public

  # Full options
  npx tsx scripts/generate-agent.ts \\
    --register "Trading Bot" \\
    --provider "my-platform" \\
    --capabilities "trade,quote,sign-btc" \\
    --public \\
    --output credentials.json
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printUsage();
    return;
  }

  // Parse args
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };

  const name = getArg('--register');
  const provider = getArg('--provider') || 'generated';
  const capabilities = getArg('--capabilities')?.split(',') || [];
  const isPublic = args.includes('--public');
  const output = getArg('--output');
  const serverUrl = getArg('--url') || PING_URL;

  console.log('\n🏓 PING Agent Generator\n');

  // Generate keys
  console.log('🔑 Generating Ed25519 keypair...');
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);

  const privateKeyHex = bytesToHex(privateKey);
  const publicKeyHex = bytesToHex(publicKey);

  console.log(`   Private Key: ${privateKeyHex.slice(0, 16)}...`);
  console.log(`   Public Key:  ${publicKeyHex.slice(0, 16)}...`);

  let agentId: string | null = null;

  // Register if requested
  if (name) {
    console.log(`\n📝 Registering with ${serverUrl}...`);
    
    try {
      const res = await fetch(`${serverUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: publicKeyHex,
          name,
          provider,
          capabilities,
          isPublic,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || `HTTP ${res.status}`);
      }

      const agent = await res.json();
      agentId = agent.id;

      console.log(`   ✅ Registered!`);
      console.log(`   Agent ID: ${agentId}`);
      console.log(`   Name: ${name}`);
      console.log(`   Provider: ${provider}`);
      console.log(`   Public: ${isPublic}`);
      if (capabilities.length) {
        console.log(`   Capabilities: ${capabilities.join(', ')}`);
      }
    } catch (error) {
      console.error(`   ❌ Registration failed: ${error}`);
    }
  }

  // Build credentials object
  const credentials = {
    agentId,
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    name: name || null,
    provider,
    serverUrl,
    createdAt: new Date().toISOString(),
  };

  // Save to file if requested
  if (output) {
    const outputPath = path.resolve(output);
    fs.writeFileSync(outputPath, JSON.stringify(credentials, null, 2));
    console.log(`\n💾 Saved to ${outputPath}`);
  }

  // Print credentials
  console.log('\n📋 Credentials (save these!):\n');
  console.log(JSON.stringify(credentials, null, 2));

  // Print usage example
  console.log('\n📖 Usage:\n');
  console.log(`// TypeScript
import { PingClient } from '@ping/sdk';

const client = new PingClient({
  baseUrl: '${serverUrl}',
  privateKey: '${privateKeyHex}',
  agentId: '${agentId || 'YOUR_AGENT_ID'}',
});

await client.text(recipientId, 'Hello!');
`);

  console.log(`# Python
from ping import PingClient

client = PingClient(base_url='${serverUrl}')
client.set_keys('${privateKeyHex}')
client.agent_id = '${agentId || 'YOUR_AGENT_ID'}'

client.text(recipient_id, 'Hello!')
`);

  console.log('');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
