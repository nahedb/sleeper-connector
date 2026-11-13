import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBearer, readHttpOptions, startHttpServer } from "../src/http.js";
import { SleeperClient } from "../src/sleeper.js";
import { LEAGUE_ID, mockFetch } from "./fixtures.js";

const TOKEN = "x".repeat(40);
let server: ReturnType<typeof startHttpServer>;
let base: string;

beforeAll(async () => {
  server = startHttpServer(
    { host: "127.0.0.1", port: 0, authToken: TOKEN, allowedOrigins: [] },
    new SleeperClient(mockFetch()),
    { defaultLeagueId: LEAGUE_ID },
  );
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const rpc = (headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("http server", () => {
  it("rejects missing / wrong token", async () => {
    expect((await rpc()).status).toBe(401);
    expect((await rpc({ authorization: "Bearer wrong" })).status).toBe(401);
  });
  it("rejects foreign Origin", async () => {
    expect((await rpc({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status).toBe(403);
  });
  it("serves tools with valid token", async () => {
    const res = await rpc({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.result.tools.some((t: any) => t.name === "sleeper_get_standings")).toBe(true);
  });
  it("refuses public bind without token, and short tokens", () => {
    expect(() => readHttpOptions({ HOST: "0.0.0.0" })).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => readHttpOptions({ HOST: "0.0.0.0", MCP_AUTH_TOKEN: "short" })).toThrow();
    expect(readHttpOptions({}).host).toBe("127.0.0.1");
  });
  it("checkBearer", () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkBearer(undefined, TOKEN)).toBe(false);
  });
});
