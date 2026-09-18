# NEON / Your people. Your frequency.

A responsive neon-dark chat app with username/password accounts, real-time public channels, online presence, typing indicators, emoji insertion, message search, and SQLite-backed history. The UI uses local assets, animated orbit artwork, glass-like panels, and mobile navigation.

## Run locally

Requires **Node.js 24.x** and npm. Node's built-in `node:sqlite` may print a stability warning depending on the installed version.

```bash
git clone https://github.com/yaudioos-arch/neon-chat.git
cd neon-chat
git checkout feature/neon-chat
npm install
npm run check
npm run lint
npm test
npm start
```

Open `http://localhost:3000`. Create two accounts in separate browser profiles to test live messaging. Use a username of 3–20 letters, numbers, or underscores and a password of 10–128 characters. Usernames are case-insensitive.

`npm run dev` starts Node's file watcher. This is JavaScript, not TypeScript; `check` performs syntax checks, not static type checking. No bundler or frontend build is needed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listening port |
| `DATABASE_PATH` | `./data/neon.sqlite` | SQLite database file; use a persistent disk in production |
| `NODE_ENV` | unset | Set to `production` to require secure cookies and an HTTPS origin |
| `APP_ORIGIN` | local request origin | Required in production, for example `https://chat.example.com` |

Supply variables through your shell or hosting dashboard. `.env` is not automatically loaded.

```bash
NODE_ENV=production APP_ORIGIN=https://chat.example.com DATABASE_PATH=/persistent/neon.sqlite npm start
```

The example domain is a placeholder, not a deployed app.

## Deploy

Use a host that runs a persistent Node.js 24 process, supports WebSockets, and provides a persistent writable disk. Install with `npm install --omit=dev`, start with `npm start`, and configure HTTPS termination with WebSocket forwarding. Set the environment variables above. `/api/health` is the health-check endpoint.

**GitHub Pages alone cannot run this app** because authentication, Socket.IO, and SQLite require the server. Publishing source to GitHub does not deploy the app. Run one instance with the current SQLite/in-memory presence architecture; multiple instances need shared presence, rate limiting, and a suitable database/Socket.IO adapter.

## Security and privacy

| Area | Behavior |
| --- | --- |
| Passwords | Salted scrypt hashes; plaintext passwords are not stored |
| Sessions | Random tokens in HttpOnly, SameSite=Strict cookies; tokens are hashed in the database and expire after seven days |
| Production | HTTPS origin validation and Secure cookies |
| Input | Username/password/message validation, parameterized SQL, request size limits |
| Browser rendering | Message text is rendered through `textContent`, not HTML |
| Abuse prevention | Basic in-memory authentication/message/join/typing rate limits |
| Visibility | All channels are public to signed-in accounts; messages are **not end-to-end encrypted** |
| History | Messages are stored on disk; each channel loads the latest 100 |

Do not commit database files or secrets. Before opening unrestricted public registration, add moderation/reporting, account recovery, stronger edge abuse controls, backups, and a retention/deletion policy. Proxy deployments currently share the proxy IP authentication limit because forwarded IPs are not trusted automatically. Configure your edge carefully; do not blindly trust client-supplied forwarding headers.

There is no password reset, email verification, private messaging, attachment upload, or admin console in this first version. Message storage is not automatically pruned. Use SQLite-aware backups, or stop the app before copying the database and its associated files. Schema tables are created automatically on first startup; no existing application data is migrated.

## API

| Endpoint / event | Purpose |
| --- | --- |
| `POST /api/auth/register` | Register with JSON username/password |
| `POST /api/auth/login` | Sign in with JSON username/password |
| `GET /api/me` | Current account and available rooms |
| `POST /api/logout` | Revoke session and disconnect its sockets |
| `GET /api/health` | Health check |
| Socket `join` | Join a room by its string identifier; acknowledgement contains history |
| Socket `message` | Send `{ room, body, clientId }`; `clientId` is a UUID used for retry deduplication |
| Socket `presence` | Receive the room's online usernames |
| Socket `typing` | Send typing activity and receive peer indicators |

## Verification

Integration tests cover registration/login validation, session revocation, origin restrictions, unauthenticated sockets, message broadcast and deduplication, room isolation, persistence across restart, rate limiting, and security headers. Run the commands above before merging or deploying. Browser layout and accessibility still need manual smoke testing at phone and desktop widths, including keyboard navigation and reduced-motion settings.

There is currently no committed dependency lockfile; `npm install` resolves transitive dependencies at install time. Generate and review `package-lock.json` and switch CI to `npm ci` before a production release.
