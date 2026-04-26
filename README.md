# One Million Checkbox

A simple real-time checkbox board built with `Express` and `Socket.IO`.

Users open the page, toggle checkboxes, and see updates broadcast instantly to every connected client. Right now the app is intentionally lightweight and keeps checkbox state in server memory.

## Features

- Real-time checkbox sync with `Socket.IO`
- Simple in-memory checkbox state
- Per-socket rate limiting to reduce spam
- Small static frontend served by `Express`
- Health check endpoint at `/health`

## Tech Stack

- Node.js
- Express
- Socket.IO
- Plain HTML, CSS, and JavaScript

## Project Structure

```text
.
|-- index.js
|-- public/
|   `-- index.html
|-- package.json
`-- README.md
```

## How It Works

- The server starts an `Express` app and attaches a `Socket.IO` server.
- When a user connects, the server sends the current checkbox state.
- When a checkbox changes, the server validates the action and broadcasts the update to all connected clients.
- If a user clicks too fast, the server sends back an error event and the client shows a bottom toast message.

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Run the server

```bash
node index.js
```

The app will start on:

```text
http://localhost:8000
```

## API / Realtime Events

### HTTP

- `GET /health` - returns basic health status

### Socket Events

- `server:checkbox:status` - sends the full checkbox state on connect
- `client:checkbox:change` - sent by the client when a checkbox is toggled
- `server:checkbox:change` - broadcast to all clients when a checkbox changes
- `server:error` - sent when an action is rejected, such as hitting the rate limit

## Current Infrastructure Note

There is currently no Redis in this project.

That is intentional for now because the server shape is only `1 vCPU` and `2 GB RAM`, and I am not scaling it yet. The app currently runs with in-memory state, which keeps the setup simpler for the current workload.

If user load gets high, I will definitely scale it and introduce the right shared infrastructure, such as Redis, to support multiple instances and more reliable shared state.

## Limitations Right Now

- Checkbox state is stored in memory, so restarting the server resets it
- This is currently designed for a single server instance
- No Redis or distributed pub/sub layer yet
- No formal test suite yet

## Future Improvements

- Add Redis for shared state and pub/sub
- Support horizontal scaling
- Persist checkbox state
- Add better observability and monitoring
- Add tests

## License

ISC
