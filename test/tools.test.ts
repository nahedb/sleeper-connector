import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SleeperClient, assertId, assertUserRef } from "../src/sleeper.js";
import { createServer } from "../src/tools.js";
import { LEAGUE_ID, mockFetch } from "./fixtures.js";

async function connect(config = { defaultLeagueId: LEAGUE_ID, defaultUsername: "alice" }, calls: string[] = []) {
  const server = createServer(new SleeperClient(mockFetch(calls)), config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  return { isError: !!res.isError, text, data: res.isError ? undefined : JSON.parse(text) };
}

describe("tools", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect();
  });

  it("lists read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(12);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("standings sorted by record", async () => {
    const { data } = await call(client, "sleeper_get_standings");
    expect(data[0]).toMatchObject({ rank: 1, team: "Bob", wins: 7 });
    expect(data[1]).toMatchObject({ team: "Alpha", points_for: 1000.5 });
  });

  it("roster defaults to configured user and names players", async () => {
    const { data } = await call(client, "sleeper_get_roster");
    expect(data.team).toBe("Alpha");
    expect(data.starters).toEqual(["Quinn Arm (QB, AAA)", "Ron Runner (RB, BBB)"]);
    expect(data.bench).toEqual(["Wes Wideout (WR, CCC)"]);
  });

  it("roster lookup by owner name, and helpful error when missing", async () => {
    expect((await call(client, "sleeper_get_roster", { team: "bob" })).data.team).toBe("Bob");
    const miss = await call(client, "sleeper_get_roster", { team: "nobody" });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain("Alpha (Alice)");
  });

  it("matchups default to current week", async () => {
    const { data } = await call(client, "sleeper_get_matchups");
    expect(data.week).toBe(10);
    expect(data.matchups[0].teams[1].starters[1].player).toBe("(empty)");
  });

  it("transactions resolve names", async () => {
    const { data } = await call(client, "sleeper_get_transactions");
    expect(data.transactions[0].adds[0]).toEqual({ player: "Wes Wideout (WR, CCC)", team: "Alpha" });
  });

  it("available players excludes rostered and teamless players", async () => {
    const { data } = await call(client, "sleeper_get_available_players");
    expect(data.map((p: any) => p.name)).toEqual(["Will Waiver"]);
  });

  it("user leagues", async () => {
    const { data } = await call(client, "sleeper_get_user_leagues");
    expect(data.leagues[0]).toMatchObject({ league_id: LEAGUE_ID, scoring: "PPR" });
  });

  it("search players", async () => {
    const { data } = await call(client, "sleeper_search_players", { query: "wide" });
    expect(data[0].name).toBe("Wes Wideout");
  });

  it("errors clearly without a configured league", async () => {
    const c = await connect({} as any);
    const res = await call(c, "sleeper_get_standings");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("SLEEPER_LEAGUE_ID");
  });

  it("rejects injection attempts in IDs before any request", async () => {
    const calls: string[] = [];
    const c = await connect({} as any, calls);
    const res: any = await c.callTool({ name: "sleeper_get_league", arguments: { league_id: "1/../../user/x" } });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("validation", () => {
  it("assertId / assertUserRef", () => {
    expect(() => assertId("12a", "x")).toThrow();
    expect(() => assertUserRef("a/b")).toThrow();
    expect(assertUserRef("good_name1")).toBe("good_name1");
  });
  it("loadConfig validates env", () => {
    expect(loadConfig({ SLEEPER_LEAGUE_ID: " 123 " })).toEqual({ defaultLeagueId: "123", defaultUsername: undefined });
    expect(() => loadConfig({ SLEEPER_LEAGUE_ID: "abc" })).toThrow();
  });
});
