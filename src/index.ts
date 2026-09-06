#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig, parseTransport } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.insecureTls) {
    console.error(
      'freshrss-mcp: FRESHRSS_INSECURE_TLS=true — TLS certificate validation is disabled for the FreshRSS connection'
    );
  }
  if (config.readOnly) {
    console.error(
      'freshrss-mcp: FRESHRSS_READ_ONLY=true — write tools are not registered'
    );
  }
  // Printed only when it is off, like the read-only line above. ELICITATION is
  // unprefixed, so one `export ELICITATION=false` reaches every MCP server in
  // the environment — this line is what makes that visible in the log of each
  // one it actually reached.
  if (!config.elicitation) {
    console.error(
      'freshrss-mcp: ELICITATION=false — guarded tools fall back to the two-call token'
    );
  }

  // Built before anything is served, so a rejected tool filter still ends
  // the process rather than surfacing as a failed handshake once a client
  // has already connected.
  let pending: McpServer | undefined;
  try {
    pending = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash: print the
    // sentence on its own rather than behind "fatal error:".
    if (error instanceof ToolFilterError) {
      console.error(`freshrss-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  // Fork addition. The branch sits here rather than higher up so that a bad
  // tool list still ends the process before either transport binds anything,
  // and the import is dynamic so an `npx` stdio run never loads the HTTP
  // module or the Node adapter behind it.
  if (parseTransport(process.env.FRESHRSS_TRANSPORT) === 'http') {
    const { serveHttp, DEFAULT_HTTP_HOST, MCP_PATH } =
      await import('./http.js');
    const handle = await serveHttp(config);
    console.error(
      `freshrss-mcp: FRESHRSS_TRANSPORT=http — listening on ${DEFAULT_HTTP_HOST}:${handle.port}${MCP_PATH}`
    );
    // `pending` is discarded: over HTTP an instance serves one request and the
    // handler builds its own from the same factory.
    pending = undefined;
    console.error(
      config.url
        ? `freshrss-mcp: targeting ${config.url}`
        : 'freshrss-mcp: started without configuration — tools are listed but every call will fail'
    );
    return;
  }

  // stdout belongs to the protocol; everything human-readable goes to stderr.
  // `serveStdio` owns the era decision for the connection: the opening
  // exchange selects 2025-11-25 or 2026-07-28 and pins one instance from
  // this factory for its lifetime. A hand-wired `StdioServerTransport`
  // serves only the 2025 era, which is why a negotiating client’s
  // `server/discover` probe was answered with "Method not found".
  //
  // The instance built above serves the first connection; a second call — a
  // modern probe followed by the real connection — builds a fresh one, which
  // is safe because `createServer` only registers tools.
  serveStdio(() => {
    const server = pending ?? createServer(config);
    pending = undefined;
    return server;
  });
  console.error(
    config.url
      ? `freshrss-mcp: connected, targeting ${config.url}`
      : 'freshrss-mcp: connected without configuration — tools are listed but every call will fail'
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error('freshrss-mcp: fatal error:', error);
  process.exit(1);
});
