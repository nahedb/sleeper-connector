import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { LEAGUE_ID_RE, USERNAME_RE } from "./config.js";
import { SleeperClient, SleeperError, type PlayerSummary } from "./sleeper.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  // Only surface safe, expected messages; never stack traces or internals.
  const msg =
    err instanceof SleeperError || err instanceof UserInputError
      ? err.message
      : err instanceof Error && err.name === "TimeoutError"
        ? "Sleeper API timed out."
        : "Unexpected error talking to Sleeper.";
  return { content: [{ type: "text", text: msg }], isError: true };
}

class UserInputError extends Error {}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const leagueIdArg = z
  .string()
  .regex(LEAGUE_ID_RE, "league_id must be numeric")
  .optional()
  .describe("Sleeper league ID (numeric, from the league URL). Omit to use the configured default league.");
const weekArg = z.number().int().min(1).max(18).optional().describe("NFL week (1-18). Omit for the current week.");
const usernameArg = z
  .string()
  .regex(USERNAME_RE, "invalid username")
  .optional()
  .describe("Sleeper username. Omit to use the configured default user.");

function playerName(players: Map<string, PlayerSummary>, id: string) {
  const p = players.get(id);
  return p ? `${p.name} (${p.position ?? "?"}, ${p.team ?? "FA"})` : id;
}

export function registerTools(server: McpServer, client: SleeperClient, config: Config) {
  const leagueId = (id?: string) => {
    const resolved = id ?? config.defaultLeagueId;
    if (!resolved) {
      throw new UserInputError(
        "No league_id given and no default configured. Ask the user for their Sleeper league ID (in their league URL) or their Sleeper username (then call sleeper_get_user_leagues), and pass league_id. To make it the default, connect with /mcp/league/{league_id} or set SLEEPER_LEAGUE_ID.",
      );
    }
    return resolved;
  };
  const username = (u?: string) => {
    const resolved = u ?? config.defaultUsername;
    if (!resolved) throw new UserInputError("No username given and none configured. Ask the user for their Sleeper username and pass it, or pass `team`. To make it the default, connect with /mcp/league/{league_id}/user/{username} or set SLEEPER_USERNAME.");
    return resolved;
  };
  const currentWeek = async (week?: number) => {
    if (week) return week;
    const s: any = await client.nflState();
    return Math.max(1, Number(s.display_week ?? s.week ?? 1));
  };

  /** roster_id -> { team name, owner } */
  const teamIndex = async (lid: string) => {
    const [rosters, users] = await Promise.all([client.rosters(lid), client.leagueUsers(lid)]);
    const byUser = new Map(users.map((u: any) => [u.user_id, u]));
    const teams = new Map<number, { roster_id: number; team: string; owner: string | null; owner_id: string | null; roster: any }>();
    for (const r of rosters) {
      const u: any = byUser.get(r.owner_id);
      teams.set(r.roster_id, {
        roster_id: r.roster_id,
        team: u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`,
        owner: u?.display_name ?? null,
        owner_id: r.owner_id ?? null,
        roster: r,
      });
    }
    return teams;
  };

  server.registerTool(
    "sleeper_get_nfl_state",
    {
      title: "NFL state",
      description: "Current NFL season, season type and week according to Sleeper.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    wrap(async () => client.nflState()),
  );

  server.registerTool(
    "sleeper_get_user_leagues",
    {
      title: "User's leagues",
      description: "List the NFL leagues a Sleeper user belongs to for a season, including league IDs.",
      inputSchema: {
        username: usernameArg,
        season: z.string().regex(/^\d{4}$/).optional().describe("Season year, e.g. 2026. Omit for current season."),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ username: u, season }: { username?: string; season?: string }) => {
      const user = await client.user(username(u));
      const state: any = season ? null : await client.nflState();
      const yr = season ?? String(state.league_season ?? state.season);
      const leagues = await client.userLeagues(user.user_id, yr);
      return {
        user: { user_id: user.user_id, username: user.username, display_name: user.display_name },
        season: yr,
        leagues: leagues.map((l) => ({
          league_id: l.league_id,
          name: l.name,
          status: l.status,
          total_rosters: l.total_rosters,
          scoring: l.scoring_settings?.rec === 1 ? "PPR" : l.scoring_settings?.rec === 0.5 ? "Half PPR" : "Standard/custom",
        })),
      };
    }),
  );

  server.registerTool(
    "sleeper_get_league",
    {
      title: "League details",
      description: "League settings: name, season, status, roster positions, scoring settings, playoff setup.",
      inputSchema: { league_id: leagueIdArg },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id }: { league_id?: string }) => {
      const l = await client.league(leagueId(league_id));
      return {
        league_id: l.league_id,
        name: l.name,
        season: l.season,
        status: l.status,
        total_rosters: l.total_rosters,
        roster_positions: l.roster_positions,
        scoring_settings: l.scoring_settings,
        settings: l.settings,
        previous_league_id: l.previous_league_id,
        draft_id: l.draft_id,
      };
    }),
  );

  server.registerTool(
    "sleeper_get_standings",
    {
      title: "Standings",
      description: "League standings: every team with owner, wins/losses/ties, points for/against, sorted by record.",
      inputSchema: { league_id: leagueIdArg },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id }: { league_id?: string }) => {
      const teams = await teamIndex(leagueId(league_id));
      const pts = (s: any, k: string) => Number(s?.[k] ?? 0) + Number(s?.[`${k}_decimal`] ?? 0) / 100;
      return [...teams.values()]
        .map((t) => {
          const s = t.roster.settings ?? {};
          return {
            roster_id: t.roster_id,
            team: t.team,
            owner: t.owner,
            wins: s.wins ?? 0,
            losses: s.losses ?? 0,
            ties: s.ties ?? 0,
            points_for: pts(s, "fpts"),
            points_against: pts(s, "fpts_against"),
          };
        })
        .sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.points_for - a.points_for)
        .map((t, i) => ({ rank: i + 1, ...t }));
    }),
  );

  server.registerTool(
    "sleeper_get_roster",
    {
      title: "Team roster",
      description:
        "A team's roster with player names: starters, bench, IR and taxi. Identify the team by owner username/display name, team name, or roster_id. Omit `team` for the configured default user's team.",
      inputSchema: {
        league_id: leagueIdArg,
        team: z.string().max(80).optional().describe("Owner username/display name, team name, or roster_id."),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id, team }: { league_id?: string; team?: string }) => {
      const lid = leagueId(league_id);
      const [teams, players] = await Promise.all([teamIndex(lid), client.players()]);
      let target;
      if (team) {
        const q = team.trim().toLowerCase();
        target = [...teams.values()].find(
          (t) => String(t.roster_id) === q || t.team.toLowerCase() === q || t.owner?.toLowerCase() === q,
        );
      } else {
        const user = await client.user(username());
        target = [...teams.values()].find((t) => t.owner_id === user.user_id);
      }
      if (!target) {
        throw new UserInputError(
          `Team not found. Teams in this league: ${[...teams.values()].map((t) => `${t.team} (${t.owner})`).join(", ")}`,
        );
      }
      const r = target.roster;
      const named = (ids?: string[] | null) => (ids ?? []).filter((id) => id && id !== "0").map((id) => playerName(players, id));
      const special = new Set([...(r.starters ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]);
      return {
        roster_id: target.roster_id,
        team: target.team,
        owner: target.owner,
        record: `${r.settings?.wins ?? 0}-${r.settings?.losses ?? 0}-${r.settings?.ties ?? 0}`,
        starters: named(r.starters),
        bench: named((r.players ?? []).filter((id: string) => !special.has(id))),
        injured_reserve: named(r.reserve),
        taxi: named(r.taxi),
      };
    }),
  );

  server.registerTool(
    "sleeper_get_matchups",
    {
      title: "Weekly matchups",
      description: "Head-to-head matchups for a week with team names, scores and starters' individual points.",
      inputSchema: { league_id: leagueIdArg, week: weekArg },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id, week }: { league_id?: string; week?: number }) => {
      const lid = leagueId(league_id);
      const wk = await currentWeek(week);
      const [rows, teams, players] = await Promise.all([client.matchups(lid, wk), teamIndex(lid), client.players()]);
      const groups = new Map<number, any[]>();
      for (const m of rows) {
        const key = m.matchup_id ?? -m.roster_id; // null matchup_id = bye / median
        groups.set(key, [...(groups.get(key) ?? []), m]);
      }
      return {
        week: wk,
        matchups: [...groups.entries()].map(([id, side]) => ({
          matchup_id: id > 0 ? id : null,
          teams: side.map((m) => ({
            team: teams.get(m.roster_id)?.team ?? `Roster ${m.roster_id}`,
            points: m.points ?? 0,
            starters: (m.starters ?? [])
              .map((pid: string, i: number) => ({ player: pid === "0" ? "(empty)" : playerName(players, pid), points: m.starters_points?.[i] ?? 0 })),
          })),
        })),
      };
    }),
  );

  server.registerTool(
    "sleeper_get_transactions",
    {
      title: "Transactions",
      description: "Trades, waiver claims and free-agent moves for a week, with player and team names.",
      inputSchema: { league_id: leagueIdArg, week: weekArg },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id, week }: { league_id?: string; week?: number }) => {
      const lid = leagueId(league_id);
      const wk = await currentWeek(week);
      const [txns, teams, players] = await Promise.all([client.transactions(lid, wk), teamIndex(lid), client.players()]);
      const tname = (rid: number) => teams.get(rid)?.team ?? `Roster ${rid}`;
      const moves = (obj: Record<string, number> | null) =>
        Object.entries(obj ?? {}).map(([pid, rid]) => ({ player: playerName(players, pid), team: tname(rid) }));
      return {
        week: wk,
        transactions: txns.map((t) => ({
          type: t.type,
          status: t.status,
          created: t.created ? new Date(t.created).toISOString() : null,
          teams: (t.roster_ids ?? []).map(tname),
          adds: moves(t.adds),
          drops: moves(t.drops),
          waiver_bid: t.settings?.waiver_bid ?? null,
          draft_picks: t.draft_picks ?? [],
        })),
      };
    }),
  );

  server.registerTool(
    "sleeper_get_trending_players",
    {
      title: "Trending players",
      description: "Players most added or dropped across all Sleeper leagues recently.",
      inputSchema: {
        type: z.enum(["add", "drop"]).default("add"),
        lookback_hours: z.number().int().min(1).max(168).default(24),
        limit: z.number().int().min(1).max(50).default(25),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ type, lookback_hours, limit }: { type: "add" | "drop"; lookback_hours: number; limit: number }) => {
      const [trend, players] = await Promise.all([client.trending(type, lookback_hours, limit), client.players()]);
      return trend.map((t) => ({ ...(players.get(t.player_id) ?? { id: t.player_id }), count: t.count }));
    }),
  );

  server.registerTool(
    "sleeper_search_players",
    {
      title: "Search players",
      description: "Look up NFL players by name, optionally filtered by position and team. Returns Sleeper player IDs, status and injury info.",
      inputSchema: {
        query: z.string().min(2).max(60).describe("Part of the player's name."),
        position: z.string().max(4).optional().describe("e.g. QB, RB, WR, TE, K, DEF"),
        team: z.string().max(4).optional().describe("NFL team abbreviation, e.g. KC"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ query, position, team, limit }: { query: string; position?: string; team?: string; limit: number }) => {
      const players = await client.players();
      const q = query.toLowerCase();
      const out: PlayerSummary[] = [];
      for (const p of players.values()) {
        if (!p.name.toLowerCase().includes(q)) continue;
        if (position && p.position?.toUpperCase() !== position.toUpperCase()) continue;
        if (team && p.team?.toUpperCase() !== team.toUpperCase()) continue;
        out.push(p);
      }
      // Prefer players currently on an NFL team.
      out.sort((a, b) => Number(!!b.team) - Number(!!a.team));
      return out.slice(0, limit);
    }),
  );

  server.registerTool(
    "sleeper_get_available_players",
    {
      title: "Available players (waiver wire)",
      description:
        "Players NOT on any roster in the league, ranked by how often they are being added across Sleeper right now. Good for waiver-wire advice.",
      inputSchema: {
        league_id: leagueIdArg,
        position: z.string().max(4).optional().describe("e.g. QB, RB, WR, TE, K, DEF"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id, position, limit }: { league_id?: string; position?: string; limit: number }) => {
      const lid = leagueId(league_id);
      const [rosters, players, trend] = await Promise.all([client.rosters(lid), client.players(), client.trending("add", 48, 200)]);
      const rostered = new Set<string>(rosters.flatMap((r: any) => r.players ?? []));
      const pos = position?.toUpperCase();
      const fits = (p?: PlayerSummary) => !!p && !!p.team && (!pos || p.position === pos);
      const result: (PlayerSummary & { adds_48h: number })[] = [];
      for (const t of trend) {
        const p = players.get(t.player_id);
        if (!rostered.has(t.player_id) && fits(p)) result.push({ ...p!, adds_48h: t.count });
        if (result.length >= limit) break;
      }
      return result;
    }),
  );

  server.registerTool(
    "sleeper_get_playoff_bracket",
    {
      title: "Playoff bracket",
      description: "Winners or losers (consolation) playoff bracket with team names.",
      inputSchema: { league_id: leagueIdArg, bracket: z.enum(["winners", "losers"]).default("winners") },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id, bracket }: { league_id?: string; bracket: "winners" | "losers" }) => {
      const lid = leagueId(league_id);
      const [rows, teams] = await Promise.all([client.bracket(lid, bracket), teamIndex(lid)]);
      const n = (rid: unknown) => (typeof rid === "number" ? teams.get(rid)?.team ?? `Roster ${rid}` : null);
      return rows.map((m: any) => ({ round: m.r, match: m.m, team_1: n(m.t1), team_2: n(m.t2), winner: n(m.w), loser: n(m.l), place: m.p ?? null }));
    }),
  );

  server.registerTool(
    "sleeper_get_drafts",
    {
      title: "League drafts",
      description: "Drafts for the league, and optionally all picks of one draft with player names.",
      inputSchema: {
        league_id: leagueIdArg,
        draft_id: z.string().regex(LEAGUE_ID_RE).optional().describe("If given, return every pick in this draft."),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id, draft_id }: { league_id?: string; draft_id?: string }) => {
      if (draft_id) {
        const [picks, players] = await Promise.all([client.draftPicks(draft_id), client.players()]);
        return picks.map((p: any) => ({
          round: p.round,
          pick: p.pick_no,
          player: playerName(players, p.player_id),
          picked_by: p.picked_by,
          roster_id: p.roster_id,
          is_keeper: p.is_keeper ?? false,
        }));
      }
      const drafts = await client.leagueDrafts(leagueId(league_id));
      return drafts.map((d: any) => ({ draft_id: d.draft_id, season: d.season, type: d.type, status: d.status, start_time: d.start_time }));
    }),
  );

  server.registerTool(
    "sleeper_get_traded_picks",
    {
      title: "Traded draft picks",
      description: "Future draft picks that have changed hands in the league.",
      inputSchema: { league_id: leagueIdArg },
      annotations: READ_ONLY,
    },
    wrap(async ({ league_id }: { league_id?: string }) => {
      const lid = leagueId(league_id);
      const [picks, teams] = await Promise.all([client.tradedPicks(lid), teamIndex(lid)]);
      const n = (rid: number) => teams.get(rid)?.team ?? `Roster ${rid}`;
      return picks.map((p: any) => ({ season: p.season, round: p.round, original_owner: n(p.roster_id), current_owner: n(p.owner_id) }));
    }),
  );
}

export function createServer(client = new SleeperClient(), config: Config = {}) {
  const server = new McpServer({ name: "sleeper", version: "0.1.0" });
  registerTools(server, client, config);
  return server;
}
