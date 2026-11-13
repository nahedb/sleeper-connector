#!/usr/bin/env node
/**
 * Streamable HTTP entry point - for remote connectors (e.g. adding a custom
 * connector URL in Claude). Stateless: each request gets a fresh MCP server.
 *
 * Connector URLs:
 *   /mcp                                     -> league comes from the tool input / env defaults
 *   /mcp/league/{league_id}                  -> that league is the default
 *   /mcp/league/{league_id}/user/{username}  -> that league + user are the defaults
 *
 * Auth is OFF by default: Sleeper data is public and read-only, and Claude's
 * custom connectors use "No sign-in" or OAuth. Set MCP_AUTH_TOKEN to require
 * an `Authorization: Bearer <token>` header (only for clients that can send it).
 *
 * Always on, with or without auth:
 *  - Per-IP rate limit and 1 MB request body cap.
 *  - Rejects unexpected Origin headers, and non-local Host headers on loopback
 *    binds (DNS-rebinding protection).
 *  - Strict validation of league_id / username path segments.
 *  - Never redirects; errors never include stack traces.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LEAGUE_ID_RE, USERNAME_RE, loadConfig, type Config } from "./config.js";
import { SleeperClient } from "./sleeper.js";
import { createServer } from "./tools.js";

const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface HttpOptions {
  host: string;
  port: number;
  authToken?: string;
  allowedOrigins: string[];
  /** Use the left-most X-Forwarded-For address for rate limiting (only behind a trusted proxy). */
  trustProxy: boolean;
  rateLimitPerMin: number;
}

export function readHttpOptions(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT ?? 3000);
  const authToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (authToken && authToken.length < 32) throw new Error("MCP_AUTH_TOKEN must be at least 32 characters.");
  const rateLimitPerMin = Number(env.RATE_LIMIT_PER_MIN ?? 60);
  if (!Number.isInteger(rateLimitPerMin) || rateLimitPerMin < 1) throw new Error("RATE_LIMIT_PER_MIN must be a positive integer.");
  return { host, port, authToken, allowedOrigins, trustProxy: env.TRUST_PROXY === "true", rateLimitPerMin };
}

/** Parse the connector path. Returns null for unknown or invalid paths. */
export function parseMcpPath(pathname: string): Config | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "mcp") return null;
  if (parts.length === 1) return {};
  if (parts[1] !== "league" || (parts.length !== 3 && parts.length !== 5)) return null;
  const leagueId = decode(parts[2]);
  if (!leagueId || !LEAGUE_ID_RE.test(leagueId)) return null;
  if (parts.length === 3) return { defaultLeagueId: leagueId };
  const username = decode(parts[4]);
  if (parts[3] !== "user" || !username || !USERNAME_RE.test(username)) return null;
  return { defaultLeagueId: leagueId, defaultUsername: username };
}

function decode(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
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
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { status: 413 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function startHttpServer(opts: HttpOptions, client = new SleeperClient(), envConfig: Config = loadConfig()) {
  const hits = new Map<string, { count: number; reset: number }>();
  const limited = (ip: string) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { count: 1, reset: now + 60_000 });
      return false;
    }
    return ++h.count > opts.rateLimitPerMin;
  };

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      const pathConfig = parseMcpPath(url.pathname);
      if (!pathConfig) return send(res, 404, { error: "not found" });

      const origin = req.headers.origin;
      if (origin && !opts.allowedOrigins.includes(origin)) return send(res, 403, { error: "origin not allowed" });
      if (LOOPBACK.has(opts.host)) {
        const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
        if (!LOOPBACK.has(hostname)) return send(res, 403, { error: "host not allowed" });
      }
      if (limited(clientIp(req, opts.trustProxy))) return send(res, 429, { error: "rate limited" }, { "retry-after": "60" });
      if (opts.authToken && !checkBearer(req.headers.authorization, opts.authToken)) {
        return send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      }
      if (req.method !== "POST") {
        return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { allow: "POST" });
      }

      const body = await readJson(req);
      // Path segments win over env defaults, so one deployment can serve any league.
      const server = createServer(client, { ...envConfig, ...pathConfig });
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
      console.error(
        `sleeper-mcp listening on http://${opts.host}:${opts.port}/mcp (auth: ${opts.authToken ? "bearer token" : "none"})`,
      );
    });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
