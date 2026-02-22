#!/usr/bin/env node
/**
 * PING MCP Server CLI
 */

import { main } from './index.js';

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
