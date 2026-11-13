/**
 * All configuration comes from environment variables so that nothing
 * league- or person-specific is ever committed to this (public) repository.
 */
export interface Config {
  defaultLeagueId?: string;
  defaultUsername?: string;
}

export const LEAGUE_ID_RE = /^\d{1,32}$/;
export const USERNAME_RE = /^[A-Za-z0-9_]{1,40}$/;

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultLeagueId = clean(env.SLEEPER_LEAGUE_ID);
  const defaultUsername = clean(env.SLEEPER_USERNAME);
  if (defaultLeagueId && !LEAGUE_ID_RE.test(defaultLeagueId)) {
    throw new Error("SLEEPER_LEAGUE_ID must be numeric (copy it from your league URL).");
  }
  if (defaultUsername && !USERNAME_RE.test(defaultUsername) && !LEAGUE_ID_RE.test(defaultUsername)) {
    throw new Error("SLEEPER_USERNAME contains invalid characters.");
  }
  return { defaultLeagueId, defaultUsername };
}
