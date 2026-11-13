// Synthetic data only - no real league, user or person data.
export const LEAGUE_ID = "100000000000000001";
export const fixtures: Record<string, unknown> = {
  "/state/nfl": { season: "2026", league_season: "2026", week: 10, display_week: 11, season_type: "regular" },
  "/user/alice": { user_id: "111", username: "alice", display_name: "Alice" },
  "/user/carol": { user_id: "333", username: "carol", display_name: "Carol" },
  "/user/111/leagues/nfl/2026": [{ league_id: LEAGUE_ID, name: "Test League", status: "in_season", total_rosters: 2, scoring_settings: { rec: 1 } }],
  [`/league/${LEAGUE_ID}`]: { league_id: LEAGUE_ID, name: "Test League", season: "2026", status: "in_season", total_rosters: 2, roster_positions: ["QB", "RB", "BN"], scoring_settings: { rec: 1 }, settings: {} },
  [`/league/${LEAGUE_ID}/users`]: [
    { user_id: "111", display_name: "Alice", metadata: { team_name: "Alpha" } },
    { user_id: "222", display_name: "Bob", metadata: {} },
  ],
  [`/league/${LEAGUE_ID}/rosters`]: [
    { roster_id: 1, owner_id: "111", starters: ["p1", "p2"], players: ["p1", "p2", "p3"], reserve: [], taxi: null, settings: { wins: 6, losses: 3, ties: 0, fpts: 1000, fpts_decimal: 50 } },
    { roster_id: 2, owner_id: "222", starters: ["p4", "0"], players: ["p4"], reserve: null, taxi: null, co_owners: ["333"], settings: { wins: 7, losses: 2, ties: 0, fpts: 950, fpts_decimal: 0 } },
  ],
  [`/league/${LEAGUE_ID}/matchups/10`]: [
    { roster_id: 1, matchup_id: 1, points: 101.5, starters: ["p1", "p2"], starters_points: [20, 30] },
    { roster_id: 2, matchup_id: 1, points: 99, starters: ["p4", "0"], starters_points: [25, 0] },
  ],
  [`/league/${LEAGUE_ID}/transactions/10`]: [
    { type: "waiver", status: "complete", created: 0, roster_ids: [1], adds: { p3: 1 }, drops: null, settings: { waiver_bid: 12 } },
    { type: "trade", status: "complete", created: 0, roster_ids: [1, 2], adds: null, drops: null, draft_picks: [{ season: "2027", round: 1, roster_id: 2, previous_owner_id: 2, owner_id: 1 }] },
  ],
  "/players/nfl/trending/add?lookback_hours=48&limit=200": [
    { player_id: "p1", count: 900 },
    { player_id: "p5", count: 500 },
    { player_id: "p6", count: 400 },
  ],
  "/players/nfl": {
    p1: { full_name: "Quinn Arm", position: "QB", team: "AAA" },
    p2: { full_name: "Ron Runner", position: "RB", team: "BBB", injury_status: "Questionable" },
    p3: { full_name: "Wes Wideout", position: "WR", team: "CCC" },
    p4: { full_name: "Tim Tight", position: "TE", team: "AAA" },
    p5: { full_name: "Will Waiver", position: "WR", team: "BBB" },
    p6: { full_name: "Retired Guy", position: "WR", team: null },
  },
};

export function mockFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = String(input).replace("https://api.sleeper.app/v1", "");
    calls.push(path);
    if (!(path in fixtures)) return new Response("null", { status: 200 });
    return new Response(JSON.stringify(fixtures[path]), { status: 200 });
  }) as typeof fetch;
}
