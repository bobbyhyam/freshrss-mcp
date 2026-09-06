import { randomBytes } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
} from '@modelcontextprotocol/node';
import { ConfirmationStore } from 'mcp-approval';

import { FreshRssApi } from './api.js';
import type { Config } from './config.js';
import { createServer } from './server.js';

/**
 * The second serving entry: the same server over streamable HTTP.
 *
 * It exists because a distroless gateway container cannot spawn a stdio child.
 * stdio stays the default and this file is additive, so an upstream release
 * merges without meeting it. See README, "Fork".
 */

/** Binds every interface: the process is a container with one job. */
export const DEFAULT_HTTP_HOST = '0.0.0.0';
export const DEFAULT_HTTP_PORT = 8080;
/** Where the MCP endpoint and the liveness probe live. */
export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/health';

export interface ServeHttpOptions {
  /** Default {@link DEFAULT_HTTP_HOST}. */
  host?: string;
  /** Default {@link DEFAULT_HTTP_PORT}. `0` binds an ephemeral port. */
  port?: number;
}

export interface HttpHandle {
  /** The port actually bound, which is what `port: 0` is asked for. */
  port: number;
  /** Stops accepting, aborts in-flight exchanges, drops open connections. */
  close(): Promise<void>;
}

/**
 * Serves the MCP endpoint over streamable HTTP and resolves once it is
 * listening.
 *
 * One `createServer(config)` per request. That is not a choice this file
 * makes: `createMcpHandler` calls its factory once per message it serves
 * (`serveModern` in the SDK's `createMcpHandler.ts`, and again per POST on the
 * stateless legacy leg), and the SDK has no session-keyed mode to opt into —
 * `McpServer` itself calls this "the per-request-factory `createMcpHandler`
 * model". The entry re-seeds each fresh instance from the request's own `_meta`
 * envelope: `setNegotiatedProtocolVersion` for the era, and
 * `seedClientIdentityFromEnvelope` for the client info and capabilities, whose
 * doc says in as many words that this keeps those accessors answering "on
 * instances that never see an `initialize` handshake".
 *
 * So what a per-request instance must not hold is anything the server accrues
 * for itself across calls — see {@link SharedServerState} for the two things
 * this server has, both built once here and handed to every instance.
 */
export async function serveHttp(
  config: Config,
  options: ServeHttpOptions = {}
): Promise<HttpHandle> {
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const port = options.port ?? DEFAULT_HTTP_PORT;

  const shared = {
    api: new FreshRssApi(config),
    confirmations: new ConfirmationStore(),
    approvalKey: randomBytes(32),
  };

  const onerror = (error: Error): void => {
    console.error(`freshrss-mcp: ${error.message}`);
  };

  const handler = createMcpHandler(() => createServer(config, shared), {
    onerror,
  });
  const mcp = toNodeHandler(handler, { onerror });

  const server = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      // The path only; a query string is not part of the routing decision, and
      // the base is a placeholder because a Node request URL is always relative.
      let path: string;
      try {
        path = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        // Node's HTTP parser accepts request targets the URL parser refuses:
        // `GET //[ HTTP/1.1` resolves as protocol-relative against the base and
        // `[` is not a host. Thrown from a 'request' listener that is an
        // uncaught exception, so leaving it unguarded hands anyone who can open
        // a socket a one-line way to kill the process.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"bad request target"}\n');
        return;
      }

      if (path === HEALTH_PATH) {
        // Liveness, and only that: it answers as soon as the listener is up and
        // says nothing about FreshRSS. A server that cannot reach FreshRSS is a
        // different failure with a different fix, and a probe that conflated the
        // two would restart this container over someone else's outage.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}\n');
        return;
      }

      if (path === MCP_PATH) {
        // The adapter's duck type declares `method?: string`, and under
        // `exactOptionalPropertyTypes` that is not the same type as Node's own
        // `string | undefined`. Same values, different declaration; the cast is
        // the whole of the difference.
        // The adapter answers its own failures with a 500, but the write of
        // that response is outside its try — a rejection here would be an
        // unhandled one, which Node ends the process for. Same reason as the
        // parse guard above: nothing a request can do may take the listener
        // down.
        void mcp(req as unknown as NodeIncomingMessageLike, res).catch(
          (error: unknown) => {
            onerror(error instanceof Error ? error : new Error(String(error)));
            if (!res.headersSent) res.writeHead(500);
            res.end();
          }
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(`{"error":"not found — the MCP endpoint is ${MCP_PATH}"}\n`);
    }
  );

  await listen(server, host, port);

  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : port,
    async close(): Promise<void> {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Without this the close waits out every keep-alive connection a
        // client left open, which is every client that did not close first.
        server.closeAllConnections();
      });
    },
  };
}

/** `server.listen`, as a promise that rejects on the bind error. */
function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}
