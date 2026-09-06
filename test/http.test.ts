import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { ConfirmationStore } from 'mcp-approval';
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseTransport } from '../src/config.js';
import { createServer, type SharedServerState } from '../src/server.js';
import {
  HEALTH_PATH,
  MCP_PATH,
  serveHttp,
  type HttpHandle,
} from '../src/http.js';
import { ALL_TOOLS } from '../src/tools/catalogue.js';
import {
  stubFreshRss,
  testConfig,
  tokenOf,
  type FetchStub,
  type Routes,
} from './harness.js';

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

/**
 * `stubFreshRss`, with the listener under test exempted.
 *
 * The upstream stub replaces the global fetch and fails any path it has no
 * route for — which over HTTP would be the MCP client's own requests to
 * 127.0.0.1. They go to the real fetch instead; everything else is FreshRSS
 * and is stubbed exactly as it is everywhere else in this suite.
 */
function stubFreshRssBesideTheListener(routes: Routes = {}): FetchStub {
  const real = globalThis.fetch.bind(globalThis);
  const stub = stubFreshRss(routes);
  const stubbed = stub.spy.getMockImplementation() as typeof fetch;
  stub.spy.mockImplementation(((input: Parameters<typeof fetch>[0], init) =>
    String(input).startsWith('http://127.0.0.1:')
      ? real(input, init)
      : stubbed(input, init)) as typeof fetch);
  return stub;
}

/** Writes a raw request the HTTP clients here cannot express, returns the status line. */
function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(raw));
    let received = '';
    socket.on('data', (chunk) => (received += String(chunk)));
    socket.on('error', reject);
    socket.on('close', () => resolve(received.split('\r\n')[0] ?? ''));
  });
}

/** A client on one in-process instance built from `shared`. */
async function linked(shared: SharedServerState): Promise<Client> {
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

  it('logs in to FreshRSS once across requests, not once per request', async () => {
    // `AuthSession` caches the GoogleLogin token to save a login per call. It
    // lives on the api client, so an api client built per instance would be an
    // api client built per request, and the saving would be gone.
    const stub = stubFreshRssBesideTheListener({
      '/subscription/list': '{}',
      '/unread-count': '{}',
    });
    const base = await serve();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`))
    );

    await client.callTool({ name: 'list_feeds', arguments: {} });
    await client.callTool({ name: 'list_feeds', arguments: {} });
    await client.close();

    expect(stub.readerCalls.length).toBeGreaterThan(1);
    expect(
      stub.calls.filter((call) => call.url.includes('/accounts/ClientLogin'))
    ).toHaveLength(1);
  });

  it('completes an elicitation round trip across two requests', async () => {
    // The 2026-07-28 era has no server→client request channel: the server
    // answers `input_required`, the SDK client fulfils it from its own
    // handler, and retries the call on a fresh request id — a second HTTP
    // request, served by a second instance — echoing the sealed request state.
    // Verifying that echo needs the key from the first instance, which is what
    // the listener's shared state provides.
    const stub = stubFreshRssBesideTheListener({ '/mark-all-as-read': 'OK' });
    const base = await serve();
    const prompts: string[] = [];
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      // `mode: 'auto'` because the SDK client's default is `'legacy'`: without
      // it this client negotiates 2025-11-25 and takes the branch the next
      // test covers.
      {
        capabilities: { elicitation: {} },
        versionNegotiation: { mode: 'auto' },
      }
    );
    client.setRequestHandler('elicitation/create', (request) => {
      prompts.push((request.params as { message?: string }).message ?? '');
      return { action: 'accept', content: { confirm: true } };
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`))
    );

    const result = (await client.callTool({
      name: 'mark_all_as_read',
      arguments: { feed_id: 12 },
    })) as CallToolResult;

    // Asked once, and the call went through on the answer rather than handing
    // back a token the model would have had to quote.
    expect(prompts).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    expect(stub.readerCalls).toHaveLength(1);
    await client.close();
  });

  it('falls back to the two-call token for a 2025-era client', async () => {
    // The other half of the elicitation story, and the reason it is not a
    // regression. A client that negotiates 2025-11-25 is served by the
    // entry's stateless legacy leg, where an instance lives for one POST and
    // cannot be asked anything — `canAsk` reads capabilities off the modern
    // envelope, which 2025 traffic does not carry. mcp-approval answers that
    // with the two-call token rather than acting unannounced, and the token
    // crosses requests because the store is the listener's.
    const stub = stubFreshRssBesideTheListener({ '/mark-all-as-read': 'OK' });
    const base = await serve();
    const prompts: string[] = [];
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      { capabilities: { elicitation: {} } }
    );
    client.setRequestHandler('elicitation/create', () => {
      prompts.push('asked');
      return { action: 'accept', content: { confirm: true } };
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`))
    );

    const args = { feed_id: 12 };
    const issued = (await client.callTool({
      name: 'mark_all_as_read',
      arguments: args,
    })) as CallToolResult;
    expect(prompts).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);

    const done = (await client.callTool({
      name: 'mark_all_as_read',
      arguments: { ...args, confirm_token: tokenOf(issued) },
    })) as CallToolResult;
    expect(done.isError).toBeFalsy();
    expect(stub.readerCalls).toHaveLength(1);
    await client.close();
  });

  it('answers a request target the URL parser rejects with 400', async () => {
    // `GET //[` parses in Node's HTTP layer and throws in `new URL`. Unguarded
    // that is an uncaught exception in the request listener, which ends the
    // process — so the assertion that matters is the second one.
    const base = await serve();
    const status = await rawRequest(
      Number(new URL(base).port),
      'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'
    );
    expect(status).toContain('400');

    const after = await fetch(`${base}${HEALTH_PATH}`);
    expect(after.status).toBe(200);
  });

  it('rejects a port already in use rather than resolving', async () => {
    const base = await serve();
    const port = Number(new URL(base).port);
    await expect(
      serveHttp(testConfig(), { host: '127.0.0.1', port })
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
