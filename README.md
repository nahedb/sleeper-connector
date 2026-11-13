# Sleeper MCP Connector

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) connector that lets Claude
(or any MCP client) look at **any** [Sleeper](https://sleeper.com) fantasy football league:
standings, rosters, matchups, transactions, waiver-wire options, drafts and more.

- No API key — Sleeper's API is public and read-only.
- Nothing league-specific in the code. Your league ID / username live only in your local config.
- Can't change anything in your league (no write endpoints exist or are used).

## Tools

| Tool | What it does |
| --- | --- |
| `sleeper_get_nfl_state` | Current season & week |
| `sleeper_get_user_leagues` | Leagues for a username (find your league ID here) |
| `sleeper_get_league` | Settings, scoring, roster slots |
| `sleeper_get_standings` | W-L-T, points for/against, ranked |
| `sleeper_get_roster` | A team's starters / bench / IR / taxi with player names |
| `sleeper_get_matchups` | Weekly head-to-heads with per-starter points |
| `sleeper_get_transactions` | Trades, waivers, FA moves for a week |
| `sleeper_get_available_players` | Unrostered players in *your* league, ranked by Sleeper-wide add trend |
| `sleeper_get_trending_players` | Most added / dropped players across Sleeper |
| `sleeper_search_players` | Find players by name / position / team |
| `sleeper_get_playoff_bracket` | Winners or consolation bracket |
| `sleeper_get_drafts` | League drafts and draft picks |
| `sleeper_get_traded_picks` | Future picks that changed hands |

Every tool that takes a `league_id` falls back to the league in the connector URL, then to `SLEEPER_LEAGUE_ID`.

## Setup

```bash
git clone https://github.com/<you>/sleeper-connector.git
cd sleeper-connector
npm ci && npm run build
```

Find your league ID in the URL: `https://sleeper.com/leagues/<LEAGUE_ID>/team`.

### Option A — Local (stdio): Claude Desktop / Claude Code

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sleeper": {
      "command": "node",
      "args": ["/absolute/path/to/sleeper-connector/dist/index.js"],
      "env": {
        "SLEEPER_LEAGUE_ID": "your-league-id",
        "SLEEPER_USERNAME": "your-sleeper-username"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add sleeper \
  -e SLEEPER_LEAGUE_ID=your-league-id \
  -e SLEEPER_USERNAME=your-sleeper-username \
  -- node /absolute/path/to/sleeper-connector/dist/index.js
```

### Option B — Remote connector in the Claude app (Streamable HTTP, no sign-in)

Host the HTTP server somewhere public (see *Deploying* below), then add it as a custom connector.

**Connector URL format** — pick one:

| URL | Behaviour |
| --- | --- |
| `https://your-host/mcp` | Works for any league. Claude asks for your league ID or username in chat. |
| `https://your-host/mcp/league/<LEAGUE_ID>` | That league is the default. |
| `https://your-host/mcp/league/<LEAGUE_ID>/user/<USERNAME>` | League and "my team" are both defaults. |

Example: `https://sleeper-mcp.example.com/mcp/league/123456789012345678/user/my_sleeper_name`

League IDs and usernames aren't secret (the same data is public on Sleeper), so it's fine for them
to be in the URL. One deployment can serve any number of people and leagues.

**Adding it in Claude:**

1. Open **Settings → Connectors** and choose **Add custom connector**.
2. Give it a name (e.g. "Sleeper") and paste your connector URL from the table above.
3. Leave the OAuth / advanced fields empty — this connector uses **No sign-in**.
4. Save, then enable the connector in a chat and ask "show my league standings".

**Deploying:**

```bash
npm ci && npm run build
HOST=0.0.0.0 PORT=3000 TRUST_PROXY=true npm run start:http
```

- **HTTPS only.** Put it behind a TLS-terminating host or proxy (Fly.io, Render, Railway,
  Cloudflare Tunnel, Caddy, nginx...). Claude must reach it over `https://`.
- **Publicly reachable over IPv4** (the hostname needs an A record, not only AAAA).
- **No redirects** on the connector URL: use the final `https://` hostname and path exactly
  (no HTTP→HTTPS hop, no `www` or trailing-slash rewrites). The server itself never redirects.
- Set `TRUST_PROXY=true` only when behind a single proxy that appends the client address to
  `X-Forwarded-For`, so the per-IP rate limit sees real client addresses. The server uses the
  right-most entry (the one your proxy added), so clients can't spoof their way past the limit.
- Health check: `GET /healthz`. MCP endpoint: `POST` to any of the URLs above.

**Optional bearer token.** Set `MCP_AUTH_TOKEN` (≥32 chars, e.g. `openssl rand -hex 32`) to require
`Authorization: Bearer <token>` on every request. This is for clients that can send custom headers
(Claude Code, scripts). Most Claude app custom connectors can't send a static header, so leave it
unset for those.

**Local test:**

```bash
npm run start:http
curl -s -X POST http://127.0.0.1:3000/mcp/league/<LEAGUE_ID> \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sleeper_get_standings","arguments":{}}}'
```

## Example prompts

- "Who's leading my league and who's on the hottest streak?"
- "Show my roster and tell me who to start this week."
- "Which WRs are available on waivers in my league that are trending up?"
- "Summarize every trade made this season."

## Security

See [SECURITY.md](SECURITY.md). In short: it's read-only, never commit `.env`, the HTTP server is
rate-limited and size-capped even without auth, and every ID is validated before it touches a URL.

## Development

```bash
npm test         # vitest, uses synthetic fixtures (no network)
npm run typecheck
```

Not affiliated with Sleeper. Uses the public API documented at https://docs.sleeper.com —
please respect their rate limits.

## License

MIT
