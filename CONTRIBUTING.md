# Contributing to PING

Thanks for wanting to contribute! Here's how.

## Quick Setup

```bash
# Clone
git clone https://github.com/aetos53t/ping
cd ping

# Install (Bun preferred, Node works too)
bun install
# or: npm install

# Run
bun run dev
# or: npx tsx src/index.ts

# Test
bun run test:integration
# or: npx tsx test/integration.ts
```

## Project Structure

```
ping/
├── src/
│   ├── index.ts          # Main server (Hono)
│   ├── db.ts             # Database layer (PostgreSQL/in-memory)
│   ├── sdk.ts            # Internal SDK (used by server tests)
│   └── middleware/       # Rate limiting, validation
├── sdk/
│   ├── src/index.ts      # TypeScript SDK
│   ├── python/           # Python SDK
│   └── go/               # Go SDK
├── mcp-server/           # MCP server for Claude/OpenClaw
├── test/                 # Tests
├── docs/                 # Documentation
├── examples/             # Usage examples
└── landing/              # Static landing page
```

## Making Changes

### Adding an API Endpoint

1. Add route in `src/index.ts`
2. Add database method in `src/db.ts` if needed
3. Add validation schema in `src/middleware/validate.ts`
4. Add test in `test/integration.ts`
5. Update all SDKs:
   - `sdk/src/index.ts` (TypeScript)
   - `sdk/python/ping/client.py` (Python)
   - `sdk/go/ping.go` (Go)
6. Add MCP tool in `mcp-server/src/index.ts`
7. Update docs

### Adding a Feature

1. Create a GitHub issue first to discuss
2. Fork and create a branch
3. Implement with tests
4. Update docs
5. Submit PR

## Code Style

- TypeScript: Use strict mode, avoid `any`
- Keep functions small and focused
- Add comments for non-obvious logic
- Follow existing patterns

## Testing

```bash
# Run integration tests
bun run test:integration

# Or with verbose output
VERBOSE=true npx tsx test/integration.ts

# Test against a different server
PING_URL=http://localhost:3100 npx tsx test/integration.ts
```

## SDKs

### TypeScript SDK
- Location: `sdk/src/index.ts`
- Zero external deps except `@noble/ed25519`
- All methods async

### Python SDK
- Location: `sdk/python/ping/client.py`
- Zero deps (stdlib only), optional `pynacl`
- Dataclasses for types

### Go SDK
- Location: `sdk/go/ping.go`
- Zero deps (stdlib only)
- Context-based methods

### MCP Server
- Location: `mcp-server/src/index.ts`
- 12 tools, 4 resources
- Works with Claude Desktop, OpenClaw

## Documentation

- `README.md` - Main overview
- `docs/ONBOARDING.md` - Getting started guide
- `docs/TROUBLESHOOTING.md` - Common issues
- `docs/openapi.yaml` - API spec

## Pull Request Process

1. Update tests
2. Update docs
3. Ensure all tests pass
4. Create PR with clear description
5. Wait for review

## Questions?

Open an issue or reach out on the PR.

## License

MIT - your contributions will be under the same license.
