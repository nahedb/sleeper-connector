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

- **No auth by default** for the remote mode, because everything it exposes is already public on
  Sleeper and it is read-only. Claude custom connectors use "No sign-in" or OAuth.
- Optional `MCP_AUTH_TOKEN` (≥32 chars) requires `Authorization: Bearer <token>`, checked in
  constant time.
- Always on, with or without auth: per-IP rate limit (`RATE_LIMIT_PER_MIN`, default 60), 1 MB
  request body cap, stateless sessions, strict validation of league ID / username path segments.
- Rejects unexpected `Origin` headers and, on loopback binds, non-local `Host` headers
  (DNS rebinding).
- Binds to `127.0.0.1` unless `HOST` is set. Never redirects. Errors never include stack traces.
- Deploy behind HTTPS only. Set `TRUST_PROXY=true` only behind a proxy you control.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) instead of a public issue.
