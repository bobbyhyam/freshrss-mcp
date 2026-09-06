import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { buildToolFilter, installToolFilter } from 'mcp-tool-allowlist';

import { ALL_TOOLS, ESSENTIAL_TOOLS, READ_TOOLS } from './tools/catalogue.js';
import {
  registerArticleReadTools,
  registerArticleWriteTools,
} from './tools/articles.js';
import {
  registerFeedReadTools,
  registerFeedWriteTools,
} from './tools/feeds.js';

import { FreshRssApi } from './api.js';
import type { Config } from './config.js';
import { ConfirmationStore, createApproval } from 'mcp-approval';
import { registerOpmlReadTools, registerOpmlWriteTools } from './tools/opml.js';
import { registerTagReadTools, registerTagWriteTools } from './tools/tags.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Flow state that has to outlive one served instance — the fork's only change
 * to this file, and it changes nothing for a caller that omits it.
 *
 * Under stdio the process is the flow: one instance serves a whole connection,
 * so the confirmation store and the seal key built below live exactly as long
 * as they should. Over streamable HTTP an instance serves one request, so the
 * two halves of a guarded write are answered by two different instances, and a
 * per-instance store or key would reject the second half every time. The HTTP
 * entry point builds both once per listener and passes them in here.
 */
export interface SharedApprovalState {
  confirmations?: ConfirmationStore;
  /** HMAC key sealing the approval state; see `createApproval`'s `key`. */
  approvalKey?: Uint8Array;
}

export function createServer(
  config: Config,
  shared: SharedApprovalState = {}
): McpServer {
  // Before anything is built: an unusable tool list should fail on the
  // way in, not leave a server running with tools quietly missing.
  const filter = buildToolFilter({
    allowTools: config.allowTools,
    denyTools: config.denyTools,
    catalogue: {
      all: ALL_TOOLS,
      essential: ESSENTIAL_TOOLS,
      ungated: READ_TOOLS,
    },
    names: {
      allow: 'FRESHRSS_ALLOW_TOOLS',
      deny: 'FRESHRSS_DENY_TOOLS',
      server: 'freshrss-mcp',
    },
    gate: {
      closed: config.readOnly,
      variable: 'FRESHRSS_READ_ONLY',
      noun: 'read-only mode',
    },
  });

  const api = new FreshRssApi(config);
  const confirmations = shared.confirmations ?? new ConfirmationStore();
  // One approver per server: it holds the key that seals the request state
  // carried out through the client and back.
  const approval = createApproval({
    server: 'freshrss-mcp',
    elicitation: config.elicitation,
    ...(shared.approvalKey === undefined ? {} : { key: shared.approvalKey }),
  });

  const server = new McpServer({
    name: 'freshrss-mcp',
    version: packageVersion(),
  });

  // Wraps server.registerTool, so it has to sit before the first
  // register call and does not care how they are organised.
  installToolFilter(server, filter);

  registerFeedReadTools(server, api);
  registerArticleReadTools(server, api);
  registerTagReadTools(server, api);
  registerOpmlReadTools(server, api);

  // Read-only mode does not register the write tools at all. Rejecting them at
  // call time would still advertise capabilities the server refuses to provide.
  if (!config.readOnly) {
    registerFeedWriteTools(server, api, confirmations, approval);
    registerArticleWriteTools(server, api, confirmations, approval);
    registerTagWriteTools(server, api, confirmations, approval);
    registerOpmlWriteTools(server, api, confirmations, approval);
  }

  return server;
}
