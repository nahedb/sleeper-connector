# Security

## What this connector can and can't do

- **Read-only.** It only issues `GET` requests to `https://api.sleeper.app/v1`. Sleeper's public API
  has no write endpoints, so the connector cannot change rosters, make trades, or post messages.
- **No credentials to Sleeper.** Sleeper's API needs none. League IDs and usernames are *not*
  secret (anyone with the ID can read the same data), but they are still kept out of this repo.

## Keeping your info out of the public repo

- Put `SLEEPER_LEAGUE_ID`, `SLEEPER_USERNAME` and `MCP_AUTH_TOKEN` in your MCP client config or a
  local `.env` file. `.env*` (except `.env.example`) is git-ignored.
- Tests use synthetic fixtures only — never paste real league data into `test/`.
- CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push / PR.
- Recommended GitHub settings: enable *Secret scanning* + *Push protection*, *Dependabot alerts*,
  and protect the `main` branch (require PR + passing CI).

## HTTP server hardening

- Binds to `127.0.0.1` by default; refuses a non-loopback bind without `MCP_AUTH_TOKEN` (≥32 chars).
- Constant-time bearer token comparison.
- Rejects unexpected `Origin` headers and, on loopback, non-local `Host` headers (DNS rebinding).
- 1 MB request body cap, 120 requests/min per IP, stateless sessions.
- Errors returned to the client never include stack traces.
- Always run it behind HTTPS when exposed to the internet.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) instead of a public issue.
