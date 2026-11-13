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

Every tool that takes a `league_id` falls back to `SLEEPER_LEAGUE_ID` if you set it.

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

### Option B — Remote (Streamable HTTP): custom connector URL

```bash
cp .env.example .env            # .env is git-ignored
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
HOST=0.0.0.0 PORT=3000 SLEEPER_LEAGUE_ID=... npm run start:http
```

The endpoint is `POST /mcp` (health check: `GET /healthz`). Put it behind HTTPS (a reverse
proxy, Cloudflare Tunnel, Fly.io, Render, etc.) and send `Authorization: Bearer <MCP_AUTH_TOKEN>`.

> **Note:** a client that only supports OAuth for custom connectors can't send a static bearer
> token. In that case run it locally with Option A, or put it behind an auth proxy that does OAuth.

## Example prompts

- "Who's leading my league and who's on the hottest streak?"
- "Show my roster and tell me who to start this week."
- "Which WRs are available on waivers in my league that are trending up?"
- "Summarize every trade made this season."

## Security

See [SECURITY.md](SECURITY.md). In short: never commit `.env`, the HTTP server refuses to bind
publicly without a strong token, and every ID is validated before it touches a URL.

## Development

```bash
npm test         # vitest, uses synthetic fixtures (no network)
npm run typecheck
```

Not affiliated with Sleeper. Uses the public API documented at https://docs.sleeper.com —
please respect their rate limits.

## License

MIT
