import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { ConfirmationStore } from 'mcp-approval';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseTransport } from '../src/config.js';
import { createServer, type SharedApprovalState } from '../src/server.js';
import {
  HEALTH_PATH,
  MCP_PATH,
  serveHttp,
  type HttpHandle,
} from '../src/http.js';
import { ALL_TOOLS } from '../src/tools/catalogue.js';
import { stubFreshRss, testConfig, tokenOf } from './harness.js';

/**
 * The fork's own suite: everything else in test/ is upstream's and stays that
 * way. It drives the real listener on an ephemeral port rather than calling the
 * handler directly, because what is being claimed is that a client can reach
 * this server over HTTP — not that a function returns a Response.
 */

let handle: HttpHandle | undefined;

async function serve(): Promise<string> {
  handle = await serveHttp(testConfig(), { host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${handle.port}`;
}

/** A client on one in-process instance built from `shared`. */
async function linked(shared: SharedApprovalState): Promise<Client> {
  const server = createServer(testConfig(), shared);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  vi.restoreAllMocks();
});

describe('parseTransport', () => {
  it('defaults to stdio', () => {
    expect(parseTransport(undefined)).toBe('stdio');
    expect(parseTransport('')).toBe('stdio');
    expect(parseTransport('stdio')).toBe('stdio');
  });

  it('selects http, tolerating case and whitespace', () => {
    expect(parseTransport('http')).toBe('http');
    expect(parseTransport(' HTTP ')).toBe('http');
  });

  it('falls back to stdio on anything else, and says so', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseTransport('htp')).toBe('stdio');
    expect(stderr.mock.calls[0]?.[0]).toContain('FRESHRSS_TRANSPORT');
  });
});

describe('streamable HTTP entry point', () => {
  it('completes initialize and tools/list over HTTP', async () => {
    const base = await serve();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`))
    );

    // The handshake already happened by here; asserting on the server it
    // negotiated with is what proves it was this process and not a stub.
    expect(client.getServerVersion()?.name).toBe('freshrss-mcp');

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...ALL_TOOLS].sort()
    );

    await client.close();
  });

  it('answers the health probe once it is listening', async () => {
    const base = await serve();
    const response = await fetch(`${base}${HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('404s anything that is not the MCP endpoint', async () => {
    const base = await serve();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain(MCP_PATH);
  });

  it('serves two clients through the same listener', async () => {
    // A single instance shared behind the listener is the shape this entry
    // point must not have; two independent handshakes are what that shape
    // cannot survive.
    const base = await serve();
    const clients = await Promise.all(
      ['a', 'b'].map(async (name) => {
        const client = new Client({ name, version: '0.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`))
        );
        return client;
      })
    );

    for (const client of clients) {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(ALL_TOOLS.length);
      await client.close();
    }
  });

  it('carries a confirmation token from one instance to the next', async () => {
    // The reason `createServer` takes shared state at all. Over HTTP the two
    // halves of a guarded write are two requests and therefore two instances,
    // and this is the assertion that the token still crosses between them.
    const stub = stubFreshRss({ '/mark-all-as-read': 'OK' });
    const shared = {
      confirmations: new ConfirmationStore(),
      approvalKey: randomBytes(32),
    };
    const args = { feed_id: 12 };

    const first = await linked(shared);
    const issued = (await first.callTool({
      name: 'mark_all_as_read',
      arguments: args,
    })) as CallToolResult;
    expect(stub.calls).toHaveLength(0);

    const second = await linked(shared);
    const spent = (await second.callTool({
      name: 'mark_all_as_read',
      arguments: { ...args, confirm_token: tokenOf(issued) },
    })) as CallToolResult;
    expect(spent.isError).toBeFalsy();
    expect(stub.readerCalls).toHaveLength(1);

    // The control: an instance holding its own store — which is what every
    // instance does under stdio, and what each one would do over HTTP if the
    // listener did not pass its state in — refuses the same token.
    const stranger = await linked({});
    const rejected = (await stranger.callTool({
      name: 'mark_all_as_read',
      arguments: { ...args, confirm_token: tokenOf(issued) },
    })) as CallToolResult;
    expect(rejected.isError).toBe(true);

    for (const client of [first, second, stranger]) await client.close();
  });

  it('rejects a port already in use rather than resolving', async () => {
    const base = await serve();
    const port = Number(new URL(base).port);
    await expect(
      serveHttp(testConfig(), { host: '127.0.0.1', port })
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
