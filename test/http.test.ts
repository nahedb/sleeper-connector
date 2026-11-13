import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBearer, parseMcpPath, readHttpOptions, startHttpServer, type HttpOptions } from "../src/http.js";
import { SleeperClient } from "../src/sleeper.js";
import { LEAGUE_ID, mockFetch } from "./fixtures.js";

const TOKEN = "x".repeat(40);
const servers: ReturnType<typeof startHttpServer>[] = [];

async function start(overrides: Partial<HttpOptions> = {}) {
  const opts: HttpOptions = { host: "127.0.0.1", port: 0, allowedOrigins: [], trustProxy: false, rateLimitPerMin: 1000, ...overrides };
  const s = startHttpServer(opts, new SleeperClient(mockFetch()), {});
  servers.push(s);
  await new Promise((r) => s.once("listening", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterAll(() => servers.forEach((s) => s.close()));

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const callTool = (name: string, args = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

describe("parseMcpPath", () => {
  it("accepts the supported URL shapes", () => {
    expect(parseMcpPath("/mcp")).toEqual({});
    expect(parseMcpPath("/mcp/")).toEqual({});
    expect(parseMcpPath(`/mcp/league/${LEAGUE_ID}`)).toEqual({ defaultLeagueId: LEAGUE_ID });
    expect(parseMcpPath(`/mcp/league/${LEAGUE_ID}/user/alice`)).toEqual({ defaultLeagueId: LEAGUE_ID, defaultUsername: "alice" });
  });
  it("rejects anything else", () => {
    for (const p of ["/", "/mcpx", "/mcp/league", "/mcp/league/abc", "/mcp/league/1/user", "/mcp/league/1/user/a%2Fb",
      "/mcp/league/1/team/alice", "/mcp/league/1/user/alice/extra", "/mcp/league/%E0%A4%A"]) {
      expect(parseMcpPath(p), p).toBeNull();
    }
  });
});

describe("http server - no auth (default)", () => {
  let base: string;
  beforeAll(async () => {
    base = await start();
  });

  it("serves tools on /mcp without any token", async () => {
    const res = await post(`${base}/mcp`, listTools);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.result.tools.some((t: any) => t.name === "sleeper_get_standings")).toBe(true);
  });

  it("uses the league from the URL path", async () => {
    const res = await post(`${base}/mcp/league/${LEAGUE_ID}`, callTool("sleeper_get_standings"));
    const body: any = await res.json();
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0].text)[0].team).toBe("Bob");
  });

  it("uses league + user from the URL path", async () => {
    const res = await post(`${base}/mcp/league/${LEAGUE_ID}/user/alice`, callTool("sleeper_get_roster"));
    const body: any = await res.json();
    expect(JSON.parse(body.result.content[0].text).team).toBe("Alpha");
  });

  it("plain /mcp tells Claude to ask for the league", async () => {
    const body: any = await (await post(`${base}/mcp`, callTool("sleeper_get_standings"))).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Ask the user");
  });

  it("404s invalid paths and never redirects", async () => {
    expect((await post(`${base}/mcp/league/not-a-number`, listTools)).status).toBe(404);
    expect((await post(`${base}/mcp/league/1/user/bad%2Fname`, listTools)).status).toBe(404);
  });

  it("rejects foreign Origin, GET, oversized and malformed bodies", async () => {
    expect((await post(`${base}/mcp`, listTools, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await post(`${base}/mcp`, { pad: "x".repeat(1_100_000) })).status).toBe(413);
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });
});

describe("http server - rate limit", () => {
  it("returns 429 past the per-IP limit", async () => {
    const base = await start({ rateLimitPerMin: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await post(`${base}/mcp`, listTools)).status);
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe("http server - optional bearer token", () => {
  let base: string;
  beforeAll(async () => {
    base = await start({ authToken: TOKEN });
  });
  it("rejects missing / wrong token", async () => {
    expect((await post(`${base}/mcp`, listTools)).status).toBe(401);
    expect((await post(`${base}/mcp`, listTools, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(`${base}/mcp`, listTools, { authorization: TOKEN })).status).toBe(401);
  });
  it("accepts a full 'Bearer <token>' header on league paths too", async () => {
    expect((await post(`${base}/mcp/league/${LEAGUE_ID}`, listTools, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });
});

describe("readHttpOptions", () => {
  it("defaults: loopback, no auth, rate limit on", () => {
    const o = readHttpOptions({});
    expect(o).toMatchObject({ host: "127.0.0.1", authToken: undefined, rateLimitPerMin: 60, trustProxy: false });
  });
  it("allows a public bind without a token (data is public)", () => {
    expect(readHttpOptions({ HOST: "0.0.0.0" }).authToken).toBeUndefined();
  });
  it("rejects short tokens and bad rate limits", () => {
    expect(() => readHttpOptions({ MCP_AUTH_TOKEN: "short" })).toThrow();
    expect(() => readHttpOptions({ RATE_LIMIT_PER_MIN: "0" })).toThrow();
  });
  it("checkBearer", () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkBearer(undefined, TOKEN)).toBe(false);
  });
});
