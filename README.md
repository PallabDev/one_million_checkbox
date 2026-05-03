# One Million Checkbox

Realtime collaborative checkbox board built with `Express`, `Socket.IO`, JWT-based authentication, and Redis-backed state sync.

Users sign in through an external auth provider, land on a shared board of 500 checkboxes, and see every change propagate live to all connected clients. Checkbox state is persisted in Redis and mirrored across server instances through Redis pub/sub so the board stays consistent after refreshes and across horizontal scaling.

## Project Overview

This project is a lightweight realtime web app that combines:

- authenticated access before users can interact with the board
- websocket-based checkbox updates with immediate UI feedback
- Redis persistence for current checkbox state
- Redis pub/sub for multi-instance synchronization
- basic per-user rate limiting to reduce spammy toggling

## Tech Stack

- Node.js 22
- Express 5
- Socket.IO 4
- Redis / Valkey via `ioredis`
- JSON Web Tokens with `jsonwebtoken`
- Plain HTML, CSS, and vanilla JavaScript frontend
- Docker Compose for local Redis/Valkey

## Features Implemented

- OAuth-style login redirect flow through an external auth service
- authorization code exchange endpoint at `POST /auth/exchange`
- JWT validation against the auth provider's JWKS endpoint
- realtime checkbox sync over Socket.IO
- Redis-backed checkbox persistence using a hash
- Redis pub/sub channel for cross-instance broadcasts
- per-user socket event rate limiting
- health endpoint at `GET /health`
- simple static frontend for login, auth callback, and board view

## Project Structure

```text
.
|-- docker-compose.yml
|-- index.js
|-- package.json
|-- public/
|   |-- auth.html
|   |-- index.html
|   `-- login.html
|-- redis-connection.js
|-- sample.env
`-- .env.example
```

## How To Run Locally

### 1. Install dependencies

```bash
npm install
```

### 2. Create your local env file

Copy either example file to `.env` and fill in your auth credentials:

```bash
cp .env.example .env
```

If you are on PowerShell:

```powershell
Copy-Item .env.example .env
```

### 3. Start Redis / Valkey

```bash
docker compose up -d
```

### 4. Start the application

```bash
npm start
```

The app runs at:

```text
http://localhost:8000
```

### 5. Optional development mode

```bash
npm run dev
```

## Environment Variables Required

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Port for the Express and Socket.IO server. Default is `8000`. |
| `AUTH_ORIGIN` | Yes | Base URL of the external auth provider. |
| `AUTH_CLIENT_ID` | Yes | Client ID issued by the auth provider. |
| `AUTH_CLIENT_SECRET` | Yes | Client secret used during code exchange. |
| `AUTH_REDIRECT_URI` | Recommended | Callback URL registered with the auth provider. Defaults to `http://<host>/auth` when omitted. |
| `CHECKBOX_COUNT` | No | Number of checkboxes rendered and stored. Default is `500`. |
| `RATE_LIMIT_WINDOW_MS` | No | Minimum delay between checkbox changes from the same user. Default is `3000`. |
| `REDIS_URL` | Optional | Full Redis connection string. If provided, it overrides `REDIS_HOST` and `REDIS_PORT`. |
| `REDIS_HOST` | Required when `REDIS_URL` is not set | Redis host, usually `127.0.0.1` for local Docker. |
| `REDIS_PORT` | Required when `REDIS_URL` is not set | Redis port, usually `6379`. |

## Redis Setup Instructions

This project already includes a local Redis-compatible service in [docker-compose.yml](/d:/Personal%20Project/Hobby%20Projects/one_million_checkbox/docker-compose.yml:1). It uses `valkey/valkey`, which works as a drop-in Redis replacement for this app.

### Local Docker setup

```bash
docker compose up -d
```

Check that it is running:

```bash
docker compose ps
```

Stop it when you are done:

```bash
docker compose down
```

### How Redis is used in this app

- checkbox state is stored in the Redis hash key `checkbox:state`
- each field in that hash is the checkbox index
- each value is a stringified boolean such as `"true"` or `"false"`
- checkbox updates are published to the `checkbox:change` channel
- every app instance subscribes to that channel and mirrors remote changes locally

## Auth Flow Explanation

1. A visitor lands on `/`, which serves `public/login.html`.
2. The page checks `localStorage` for an `accessToken`.
3. If there is no token, the browser is redirected to `/login`.
4. `GET /login` builds an auth-provider login URL using `AUTH_CLIENT_ID` and the redirect URI, then redirects the user to the external auth app.
5. After a successful login, the auth provider redirects the user back to `/auth?code=...`.
6. `public/auth.html` reads the authorization code and posts it to `POST /auth/exchange`.
7. The server exchanges that code for an access token using `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, and the redirect URI.
8. The frontend stores the returned access token in `localStorage` and sends the user to `/home`.
9. When a checkbox is toggled, the frontend includes that access token in the socket payload.
10. The server validates the token using the auth provider's JWKS endpoint before accepting the change.

## WebSocket Flow Explanation

1. `/home` serves `public/index.html`, which opens a Socket.IO connection.
2. On connect, the server emits `server:checkbox:status` with the current board state.
3. The client renders 500 checkboxes and applies the latest server state.
4. When a user toggles a checkbox, the browser emits `client:checkbox:change` with:

```json
{
  "index": 12,
  "checked": true,
  "accessToken": "..."
}
```

5. The server validates the JWT, applies rate limiting, updates local memory, persists the change in Redis, and emits `server:checkbox:change`.
6. The server also publishes the same change to Redis pub/sub so other app instances can stay in sync.
7. Remote instances receive that pub/sub message and rebroadcast it to their connected clients.
8. The frontend listens for:

- `server:checkbox:status` to hydrate the full board on initial load
- `server:checkbox:change` to update a single checkbox live
- `server:checkbox:user` to show who changed something
- `server:error` to revert rejected changes and show a toast

## Rate Limiting Logic Explanation

Rate limiting is handled in-memory with a `Map` keyed by authenticated user ID.

- after token validation, the server checks the user's last successful change timestamp
- if the same user tries again before `RATE_LIMIT_WINDOW_MS` has elapsed, the server rejects the action
- rejected actions emit `server:error` so the client can revert the checkbox and show a toast message
- by default, each user may make one successful checkbox change every `3000` milliseconds

Current limitation:

- because the rate limit store is in memory, it is enforced per server instance rather than globally across all instances

## API And Events

### HTTP routes

- `GET /` - login shell page that routes users based on token presence
- `GET /login` - redirects the user to the external auth provider
- `GET /auth` - auth callback page
- `POST /auth/exchange` - exchanges auth code for access token
- `GET /home` - checkbox board page
- `GET /health` - health status JSON

### Socket events

- `client:checkbox:change` - emitted by the browser on toggle
- `server:checkbox:status` - full board state sent on connect
- `server:checkbox:change` - single checkbox update broadcast to clients
- `server:checkbox:user` - toast message showing which user changed a checkbox
- `server:error` - emitted when auth fails or rate limiting rejects a change

## Screenshots Or Demo Link

Add one of these before submission:

- deployed demo URL
- short screen recording GIF
- screenshots of the login screen, auth callback, and live checkbox board

If you want to keep screenshots in the repo, a simple convention is:

```text
docs/login.png
docs/board.png
docs/demo.gif
```

Then embed them in the README like this:

```md
![Login screen](docs/login.png)
![Board screen](docs/board.png)
```

## Verification Checklist

- create `.env` from `.env.example`
- start Redis with `docker compose up -d`
- run the app with `npm start`
- confirm `http://localhost:8000/health` returns `{ "health": true }`
- test login redirect and token exchange with valid auth provider credentials
- open two browser tabs and verify checkbox changes sync live

## Known Limitations

- valid auth provider credentials are required for the full login flow
- rate limiting is local to each server instance
- there is no automated test suite yet

## License

ISC
