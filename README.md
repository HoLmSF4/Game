# Castle & Frontier — multiplayer server

One Node.js process, no dependencies. It serves the game page and runs the lobbies and matches.

## Run it

    node server.js

Then open http://localhost:8080 and click **Multiplayer**. Needs Node 18 or newer.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Port to listen on (most hosts set this for you) |
| `LOBBY_SECS` | 60 | Countdown of each lobby before its match starts |
| `SPAWN_TICKS` | 100 | Time to pick a start position, in tenths of a second (10 s); a player who has not chosen by then watches as a spectator |
| `MAX_GAMES` | 8 | Matches allowed to run at the same time |

## How lobbies work

Three lobbies are always open, each on the next map in the rotation. When a lobby's countdown ends:
it is removed and a new one opens; if nobody joined, nothing else happens; if at least one player
joined, a match starts with up to 15 players and bot realms fill the map up to 30 realms. Matches use exactly the same rules as the campaigns (the rule code is shared), have no time limit and end when one realm holds 70% of the land. A player who disconnects is replaced by a bot.

## Putting it online

1. Deploy this folder to any host that runs Node and supports WebSockets (a VPS, Render, Railway, Fly.io…).
   The host must give you an `https://` address, because game portals only allow secure `wss://` connections.
2. In the portal builds, open `index.html`, find `const MP_SERVER='';` and set it to your server,
   for example `const MP_SERVER='wss://your-server.example.com';`.
3. `GET /health` returns `{ok, online, games}` for uptime checks.

Matches live in memory: restarting the server ends the matches in progress.


## Leaderboard

Scores are computed by the server at the end of each match and kept in `scores.json` next to `server.js`.
Players are identified by the name they typed, so this table is for fun, not for prizes: a real account system
(for example Google Play Games sign-in) is needed before scores or rewards can be trusted.
