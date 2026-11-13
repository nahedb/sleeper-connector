import { LEAGUE_ID_RE, USERNAME_RE } from "./config.js";

const BASE_URL = "https://api.sleeper.app/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const PLAYERS_TTL_MS = 12 * 60 * 60 * 1000; // Sleeper asks clients to fetch /players at most ~daily.
const SHORT_TTL_MS = 60 * 1000;

export type FetchLike = typeof fetch;

export interface PlayerSummary {
  id: string;
  name: string;
  position: string | null;
  team: string | null;
  status: string | null;
  injury_status: string | null;
  age: number | null;
  years_exp: number | null;
}

export class SleeperError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SleeperError";
  }
}

/** Validate an ID before it is placed into a URL path (prevents path/query injection). */
export function assertId(value: string, label: string): string {
  if (!LEAGUE_ID_RE.test(value)) throw new SleeperError(`Invalid ${label}: expected a numeric ID.`);
  return value;
}

export function assertUserRef(value: string): string {
  if (!USERNAME_RE.test(value) && !LEAGUE_ID_RE.test(value)) {
    throw new SleeperError("Invalid username: only letters, numbers and underscores are allowed.");
  }
  return value;
}

/**
 * Minimal, read-only client for the public Sleeper API (https://docs.sleeper.com).
 * No authentication is used or needed.
 */
export class SleeperClient {
  private cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  private playersPromise?: { expires: number; value: Promise<Map<string, PlayerSummary>> };

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async get<T>(path: string, ttlMs = SHORT_TTL_MS): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && hit.expires > now) return hit.value as Promise<T>;

    const value = this.request<T>(path);
    this.cache.set(path, { expires: now + ttlMs, value });
    value.catch(() => this.cache.delete(path));
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async request<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      headers: { accept: "application/json", "user-agent": "sleeper-mcp-connector" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 429) throw new SleeperError("Sleeper rate limit hit; try again shortly.", 429);
    if (!res.ok) throw new SleeperError(`Sleeper API returned HTTP ${res.status}.`, res.status);
    const text = await res.text();
    // Sleeper returns a literal "null" body for unknown users/leagues.
    const data = text ? JSON.parse(text) : null;
    if (data === null) throw new SleeperError("Not found on Sleeper.", 404);
    return data as T;
  }

  // ---- Endpoints -------------------------------------------------------

  nflState() {
    return this.get<Record<string, unknown>>("/state/nfl");
  }
  user(usernameOrId: string) {
    return this.get<Record<string, any>>(`/user/${encodeURIComponent(assertUserRef(usernameOrId))}`, 10 * 60_000);
  }
  userLeagues(userId: string, season: string) {
    return this.get<any[]>(`/user/${assertId(userId, "user_id")}/leagues/nfl/${assertId(season, "season")}`);
  }
  league(id: string) {
    return this.get<Record<string, any>>(`/league/${assertId(id, "league_id")}`);
  }
  rosters(id: string) {
    return this.get<any[]>(`/league/${assertId(id, "league_id")}/rosters`);
  }
  leagueUsers(id: string) {
    return this.get<any[]>(`/league/${assertId(id, "league_id")}/users`);
  }
  matchups(id: string, week: number) {
    return this.get<any[]>(`/league/${assertId(id, "league_id")}/matchups/${week}`);
  }
  transactions(id: string, round: number) {
    return this.get<any[]>(`/league/${assertId(id, "league_id")}/transactions/${round}`);
  }
  tradedPicks(id: string) {
    return this.get<any[]>(`/league/${assertId(id, "league_id")}/traded_picks`);
  }
  bracket(id: string, which: "winners" | "losers") {
    return this.get<any[]>(`/league/${assertId(id, "league_id")}/${which}_bracket`);
  }
  leagueDrafts(id: string) {
    return this.get<any[]>(`/league/${assertId(id, "league_id")}/drafts`);
  }
  draft(id: string) {
    return this.get<Record<string, any>>(`/draft/${assertId(id, "draft_id")}`);
  }
  draftPicks(id: string) {
    return this.get<any[]>(`/draft/${assertId(id, "draft_id")}/picks`);
  }
  trending(type: "add" | "drop", lookbackHours: number, limit: number) {
    return this.get<{ player_id: string; count: number }[]>(
      `/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`,
      5 * 60_000,
    );
  }

  /** The full player DB is ~5MB; fetch rarely and keep only a compact summary. */
  players(): Promise<Map<string, PlayerSummary>> {
    const now = Date.now();
    if (this.playersPromise && this.playersPromise.expires > now) return this.playersPromise.value;
    const value = this.request<Record<string, any>>("/players/nfl").then((raw) => {
      const map = new Map<string, PlayerSummary>();
      for (const [id, p] of Object.entries(raw)) {
        const name =
          p.full_name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || (p.position === "DEF" ? `${id} D/ST` : id));
        map.set(id, {
          id,
          name,
          position: p.position ?? null,
          team: p.team ?? null,
          status: p.status ?? null,
          injury_status: p.injury_status ?? null,
          age: p.age ?? null,
          years_exp: p.years_exp ?? null,
        });
      }
      return map;
    });
    this.playersPromise = { expires: now + PLAYERS_TTL_MS, value };
    value.catch(() => (this.playersPromise = undefined));
    return value;
  }
}
