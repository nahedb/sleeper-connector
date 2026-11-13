#!/usr/bin/env node
/**
 * Streamable HTTP entry point - for remote connectors (e.g. adding a custom
 * connector URL in Claude). Stateless: each request gets a fresh MCP server.
 *
 * Security:
 *  - Binds to 127.0.0.1 by default.
 *  - Refuses to start on a non-loopback host unless MCP_AUTH_TOKEN is set.
 *  - Bearer-token check uses a constant-time comparison.
 *  - Rejects unexpected Origin / Host headers (DNS-rebinding protection).
 *  - Caps request body size and applies a simple per-IP rate limit.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { SleeperClient } from "./sleeper.js";
import { createServer } from "./tools.js";

const MAX_BODY_BYTES = 1_000_000;
const RATE_LIMIT_PER_MIN = 120;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface HttpOptions {
  host: string;
  port: number;
  authToken?: string;
  allowedOrigins: string[];
}

export function readHttpOptions(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT ?? 3000);
  const authToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!LOOPBACK.has(host) && !authToken) {
    throw new Error(`Refusing to listen on ${host} without MCP_AUTH_TOKEN. Generate one with: openssl rand -hex 32`);
  }
  if (authToken && authToken.length < 32) throw new Error("MCP_AUTH_TOKEN must be at least 32 characters.");
  return { host, port, authToken, allowedOrigins };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function checkBearer(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return !!m && timingSafeEqual(digest(m[1].trim()), digest(token));
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
}

export function startHttpServer(opts: HttpOptions, client = new SleeperClient(), config = loadConfig()) {
  const hits = new Map<string, { count: number; reset: number }>();
  const limited = (ip: string) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { count: 1, reset: now + 60_000 });
      return false;
    }
    return ++h.count > RATE_LIMIT_PER_MIN;
  };

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });

      const origin = req.headers.origin;
      if (origin && !opts.allowedOrigins.includes(origin)) return send(res, 403, { error: "origin not allowed" });
      if (LOOPBACK.has(opts.host)) {
        const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
        if (!LOOPBACK.has(hostname)) return send(res, 403, { error: "host not allowed" });
      }
      if (opts.authToken && !checkBearer(req.headers.authorization, opts.authToken)) {
        return send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      }
      if (limited(req.socket.remoteAddress ?? "unknown")) return send(res, 429, { error: "rate limited" });
      if (req.method !== "POST") {
        return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { allow: "POST" });
      }

      const body = await readJson(req);
      const server = createServer(client, config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      if (!res.headersSent) send(res, e?.status ?? 500, { error: e?.status ? e.message : "internal error" });
    }
  });
  httpServer.listen(opts.port, opts.host);
  return httpServer;
}

// Run when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const opts = readHttpOptions();
    startHttpServer(opts).on("listening", () => {
      console.error(`sleeper-mcp listening on http://${opts.host}:${opts.port}/mcp${opts.authToken ? " (auth required)" : ""}`);
    });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
