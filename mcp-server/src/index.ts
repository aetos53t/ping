/**
 * PING MCP Server
 * 
 * Model Context Protocol server for agent-to-agent messaging.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure Ed25519
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ════════════════════════════════════════════════════════════════
//                         CONFIG
// ════════════════════════════════════════════════════════════════

const PING_URL = process.env.PING_URL || "http://localhost:3100";

interface AgentConfig {
  id: string;
  privateKey: string;
  publicKey: string;
}

let agentConfig: AgentConfig | null = null;

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function apiRequest(path: string, opts?: { method?: string; body?: unknown }) {
  const res = await fetch(`${PING_URL}${path}`, {
    method: opts?.method || 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Request failed');
  }

  return res.json();
}

function signMessage(message: Record<string, unknown>, privateKey: string): string {
  const msgBytes = new TextEncoder().encode(JSON.stringify(message));
  const privBytes = hexToBytes(privateKey);
  const sig = ed.sign(msgBytes, privBytes);
  return bytesToHex(sig);
}

// ════════════════════════════════════════════════════════════════
//                         TOOLS
// ════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: "ping_register",
    description: "Register as a new agent on PING. Creates a keypair and registers with the service.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Agent name" },
        provider: { type: "string", description: "Provider (e.g., 'openclaw', 'aibtc')" },
        capabilities: { type: "array", items: { type: "string" }, description: "Agent capabilities" },
        isPublic: { type: "boolean", description: "List in public directory" },
      },
      required: ["name"],
    },
  },
  {
    name: "ping_send",
    description: "Send a message to another agent",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient agent ID" },
        type: { 
          type: "string", 
          enum: ["text", "ping", "pong", "request", "response", "proposal", "signature"],
          description: "Message type" 
        },
        payload: { type: "object", description: "Message payload (e.g., { text: 'Hello!' })" },
        replyTo: { type: "string", description: "Optional message ID to reply to" },
      },
      required: ["to", "type"],
    },
  },
  {
    name: "ping_text",
    description: "Send a text message to another agent (convenience method)",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient agent ID" },
        text: { type: "string", description: "Message text" },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "ping_inbox",
    description: "Check inbox for new messages",
    inputSchema: {
      type: "object" as const,
      properties: {
        includeAll: { type: "boolean", description: "Include already acknowledged messages" },
      },
    },
  },
  {
    name: "ping_ack",
    description: "Acknowledge receipt of a message",
    inputSchema: {
      type: "object" as const,
      properties: {
        messageId: { type: "string", description: "Message ID to acknowledge" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "ping_history",
    description: "Get conversation history with another agent",
    inputSchema: {
      type: "object" as const,
      properties: {
        otherId: { type: "string", description: "Other agent ID" },
        limit: { type: "number", description: "Max messages to return (default 50)" },
      },
      required: ["otherId"],
    },
  },
  {
    name: "ping_directory",
    description: "List public agents in the directory",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "ping_search",
    description: "Search for agents by name, capability, or provider",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search by name" },
        capability: { type: "string", description: "Filter by capability" },
        provider: { type: "string", description: "Filter by provider" },
      },
    },
  },
  {
    name: "ping_contacts",
    description: "List your contacts",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "ping_add_contact",
    description: "Add an agent to your contacts",
    inputSchema: {
      type: "object" as const,
      properties: {
        contactId: { type: "string", description: "Agent ID to add" },
        alias: { type: "string", description: "Nickname for the contact" },
        notes: { type: "string", description: "Notes about this contact" },
      },
      required: ["contactId"],
    },
  },
  {
    name: "ping_get_agent",
    description: "Get info about an agent by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: { type: "string", description: "Agent ID" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "ping_status",
    description: "Get current registration status and agent info",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ════════════════════════════════════════════════════════════════
//                         TOOL HANDLERS
// ════════════════════════════════════════════════════════════════

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "ping_register": {
      // Generate keys
      const privateKey = ed.utils.randomPrivateKey();
      const publicKey = ed.getPublicKey(privateKey);
      const privateKeyHex = bytesToHex(privateKey);
      const publicKeyHex = bytesToHex(publicKey);

      const result = await apiRequest('/agents', {
        method: 'POST',
        body: {
          publicKey: publicKeyHex,
          name: args.name,
          provider: args.provider || 'mcp',
          capabilities: args.capabilities || [],
          isPublic: args.isPublic ?? true,
        },
      });

      agentConfig = {
        id: result.id,
        privateKey: privateKeyHex,
        publicKey: publicKeyHex,
      };

      return {
        success: true,
        agentId: result.id,
        name: result.name,
        publicKey: publicKeyHex,
        message: "Registered! Save your agent ID for future sessions.",
      };
    }

    case "ping_send": {
      if (!agentConfig) throw new Error("Not registered. Call ping_register first.");

      const message = {
        type: args.type as string,
        from: agentConfig.id,
        to: args.to as string,
        payload: args.payload || {},
        replyTo: args.replyTo,
        timestamp: Date.now(),
      };

      const signature = signMessage(message, agentConfig.privateKey);

      return apiRequest('/messages', {
        method: 'POST',
        body: { ...message, signature },
      });
    }

    case "ping_text": {
      if (!agentConfig) throw new Error("Not registered. Call ping_register first.");

      const message = {
        type: 'text',
        from: agentConfig.id,
        to: args.to as string,
        payload: { text: args.text },
        timestamp: Date.now(),
      };

      const signature = signMessage(message, agentConfig.privateKey);

      return apiRequest('/messages', {
        method: 'POST',
        body: { ...message, signature },
      });
    }

    case "ping_inbox": {
      if (!agentConfig) throw new Error("Not registered. Call ping_register first.");
      const query = args.includeAll ? '?all=true' : '';
      return apiRequest(`/agents/${agentConfig.id}/inbox${query}`);
    }

    case "ping_ack": {
      return apiRequest(`/messages/${args.messageId}/ack`, { method: 'POST' });
    }

    case "ping_history": {
      if (!agentConfig) throw new Error("Not registered. Call ping_register first.");
      const limit = (args.limit as number) || 50;
      return apiRequest(`/agents/${agentConfig.id}/messages/${args.otherId}?limit=${limit}`);
    }

    case "ping_directory": {
      return apiRequest('/directory');
    }

    case "ping_search": {
      const params = new URLSearchParams();
      if (args.query) params.set('q', args.query as string);
      if (args.capability) params.set('capability', args.capability as string);
      if (args.provider) params.set('provider', args.provider as string);
      const query = params.toString();
      return apiRequest(`/directory/search${query ? '?' + query : ''}`);
    }

    case "ping_contacts": {
      if (!agentConfig) throw new Error("Not registered. Call ping_register first.");
      return apiRequest(`/agents/${agentConfig.id}/contacts`);
    }

    case "ping_add_contact": {
      if (!agentConfig) throw new Error("Not registered. Call ping_register first.");
      return apiRequest(`/agents/${agentConfig.id}/contacts`, {
        method: 'POST',
        body: {
          contactId: args.contactId,
          alias: args.alias,
          notes: args.notes,
        },
      });
    }

    case "ping_get_agent": {
      return apiRequest(`/agents/${args.agentId}`);
    }

    case "ping_status": {
      const health = await apiRequest('/health');
      return {
        registered: !!agentConfig,
        agentId: agentConfig?.id || null,
        publicKey: agentConfig?.publicKey || null,
        service: health,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ════════════════════════════════════════════════════════════════
//                         SERVER
// ════════════════════════════════════════════════════════════════

const server = new Server(
  {
    name: "ping-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const result = await handleTool(name, args as Record<string, unknown>);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// List resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "ping://status",
      name: "PING Status",
      description: "Current agent registration status and service health",
      mimeType: "application/json",
    },
    {
      uri: "ping://inbox",
      name: "Inbox",
      description: "Unacknowledged messages",
      mimeType: "application/json",
    },
    {
      uri: "ping://contacts",
      name: "Contacts",
      description: "Your contact list",
      mimeType: "application/json",
    },
    {
      uri: "ping://directory",
      name: "Directory",
      description: "Public agent directory",
      mimeType: "application/json",
    },
  ],
}));

// Read resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  
  try {
    let result: unknown;
    
    switch (uri) {
      case "ping://status":
        result = await handleTool("ping_status", {});
        break;
      case "ping://inbox":
        result = agentConfig 
          ? await apiRequest(`/agents/${agentConfig.id}/inbox`)
          : { error: "Not registered" };
        break;
      case "ping://contacts":
        result = agentConfig
          ? await apiRequest(`/agents/${agentConfig.id}/contacts`)
          : { error: "Not registered" };
        break;
      case "ping://directory":
        result = await apiRequest('/directory');
        break;
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
    
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

// ════════════════════════════════════════════════════════════════
//                         MAIN
// ════════════════════════════════════════════════════════════════

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`PING MCP Server running (${PING_URL})`);
}

export { server, TOOLS };
