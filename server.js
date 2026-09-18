import express from 'express';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const deriveKey = promisify(scrypt);
const ROOT = dirname(fileURLToPath(import.meta.url));
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const ROOMS = [
  { id: 'general', name: 'the-lobby', description: 'Good people. Great conversations. Zero noise.', emoji: '✳' },
  { id: 'creative', name: 'creative-chaos', description: 'Share the idea you cannot stop thinking about.', emoji: '✦' },
  { id: 'night', name: 'night-owls', description: 'A little corner for your after-hours thoughts.', emoji: '☾' }
];
const validRoom = (room) => ROOMS.some((item) => item.id === room);
const digest = (token) => createHash('sha256').update(token).digest('hex');
function cookieToken(header = '') {
  const value = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('neon_session='))?.slice(13);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}

export function createChatServer({ databasePath = process.env.DATABASE_PATH || './data/neon.sqlite', production = process.env.NODE_ENV === 'production', origin = process.env.APP_ORIGIN } = {}) {
  if (production && (!origin || new URL(origin).protocol !== 'https:')) throw new Error('Production requires an HTTPS APP_ORIGIN.');
  if (origin) origin = new URL(origin).origin;
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, room TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at INTEGER NOT NULL, client_id TEXT NOT NULL, UNIQUE(user_id, client_id));
    CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room, id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
  const app = express();
  app.disable('x-powered-by');
  const httpServer = createServer(app);
  function permitted(req) {
    return !req.headers.origin || req.headers.origin === (origin || `http://${req.headers.host}`);
  }
  const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024, allowRequest: (req, callback) => callback(null, permitted(req)) });
  const limits = new Map();
  function allow(key, max, duration) {
    const now = Date.now();
    let bucket = limits.get(key);
    if (!bucket || bucket.until <= now) {
      if (limits.size >= 10000 && !bucket) return false;
      bucket = { count: 0, until: now + duration };
      limits.set(key, bucket);
    }
    return ++bucket.count <= max;
  }
  const cleanup = setInterval(() => {
    for (const [key, bucket] of limits) if (bucket.until <= Date.now()) limits.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }, 60000);
  cleanup.unref();
  function session(req) {
    const token = cookieToken(req.headers.cookie);
    if (!token) return null;
    return db.prepare('SELECT users.id, users.username, sessions.token_hash, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').get(digest(token), Date.now()) || null;
  }
  function setCookie(res, token, maxAge) {
    res.setHeader('Set-Cookie', `neon_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production ? '; Secure' : ''}`);
  }
  function publicUser(user) { return { id: user.id, username: user.username }; }
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (!permitted(req)) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/me', (req, res) => {
    const user = session(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    res.json({ user: publicUser(user), rooms: ROOMS });
  });
  app.post('/api/auth/:mode', async (req, res, next) => {
    try {
      const mode = req.params.mode;
      if (!['register', 'login'].includes(mode)) return res.status(404).json({ error: 'Unknown action.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON is required.' });
      if (!allow(`auth:${req.ip}`, 20, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username) || typeof password !== 'string' || password.length < 10 || password.length > 128) {
        return res.status(400).json({ error: 'Use a 3–20 character username (letters, numbers, underscores) and a 10–128 character password.' });
      }
      const canonical = username.toLowerCase();
      if (!allow(`account:${canonical}`, 20, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts for this account. Try again later.' });
      let user = db.prepare('SELECT * FROM users WHERE username = ?').get(canonical);
      const salt = mode === 'login' && user ? user.salt : randomBytes(16).toString('hex');
      const key = await deriveKey(password, salt, 64);
      if (mode === 'register') {
        if (user || db.prepare('SELECT id FROM users WHERE username = ?').get(canonical)) return res.status(409).json({ error: 'That username is already taken.' });
        const result = db.prepare('INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)').run(canonical, salt, key.toString('hex'));
        user = { id: Number(result.lastInsertRowid), username: canonical };
      } else if (!user || !timingSafeEqual(Buffer.from(user.password_hash, 'hex'), key)) {
        return res.status(401).json({ error: 'Incorrect username or password.' });
      }
      const previous = session(req);
      if (previous) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(previous.token_hash);
        io.in(`session:${previous.token_hash}`).disconnectSockets(true);
      }
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), user.id, Date.now() + SESSION_MS);
      setCookie(res, token, SESSION_MS / 1000);
      res.status(mode === 'register' ? 201 : 200).json({ user: publicUser(user), rooms: ROOMS });
    } catch (error) { next(error); }
  });
  app.post('/api/logout', (req, res) => {
    const user = session(req);
    if (user) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(user.token_hash);
      io.in(`session:${user.token_hash}`).disconnectSockets(true);
    }
    setCookie(res, '', 0);
    res.json({ ok: true });
  });
  const messageSelect = 'SELECT messages.id, messages.room, messages.body, messages.created_at AS createdAt, messages.client_id AS clientId, users.username FROM messages JOIN users ON users.id = messages.user_id';
  function history(room) {
    return db.prepare(`${messageSelect} WHERE room = ? ORDER BY messages.id DESC LIMIT 100`).all(room).reverse();
  }
  function presence(room) {
    if (!validRoom(room)) return;
    const names = [...new Set([...io.sockets.sockets.values()].filter((socket) => socket.data.room === room).map((socket) => socket.data.user.username))].sort();
    io.to(`chat:${room}`).emit('presence', { room, users: names });
  }
  io.use((socket, next) => {
    const user = session(socket.request);
    if (!user) return next(new Error('Please sign in again.'));
    socket.data.user = user;
    next();
  });
  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`session:${user.token_hash}`);
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(1, user.expires_at - Date.now()));
    expiry.unref();
    socket.use((packet, next) => {
      if (!session(socket.request)) { socket.disconnect(true); return; }
      next();
    });
    socket.on('join', (room, callback) => {
      const reply = typeof callback === 'function' ? callback : () => {};
      try {
        if (!allow(`join:${user.id}`, 30, 60000)) return reply({ error: 'Slow down switching channels.' });
        if (!validRoom(room)) return reply({ error: 'Unknown channel.' });
        const old = socket.data.room;
        if (old) socket.leave(`chat:${old}`);
        socket.data.room = room;
        socket.join(`chat:${room}`);
        reply({ room, messages: history(room) });
        if (old !== room) presence(old);
        presence(room);
      } catch (error) { console.error('Join failed:', error.message); reply({ error: 'Could not load this channel.' }); }
    });
    socket.on('message', (payload, callback) => {
      const reply = typeof callback === 'function' ? callback : () => {};
      try {
        if (!allow(`message:${user.id}`, 20, 10000)) return reply({ error: 'Take a breath. Try again in a few seconds.' });
        const { room, body, clientId } = payload || {};
        if (!validRoom(room) || room !== socket.data.room || typeof body !== 'string' || !body.trim() || body.length > 2000 || typeof clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(clientId)) return reply({ error: 'Invalid message. Use 1–2000 characters in your current channel.' });
        const existing = db.prepare(`${messageSelect} WHERE messages.user_id = ? AND messages.client_id = ?`).get(user.id, clientId);
        if (existing) return reply({ message: existing });
        const result = db.prepare('INSERT INTO messages (room, user_id, body, created_at, client_id) VALUES (?, ?, ?, ?, ?)').run(room, user.id, body.trim(), Date.now(), clientId);
        const message = db.prepare(`${messageSelect} WHERE messages.id = ?`).get(Number(result.lastInsertRowid));
        io.to(`chat:${room}`).emit('message', message);
        reply({ message });
      } catch (error) { console.error('Message failed:', error.message); reply({ error: 'Message could not be saved. Please retry.' }); }
    });
    socket.on('typing', () => {
      if (validRoom(socket.data.room) && allow(`typing:${user.id}`, 2, 2000)) socket.to(`chat:${socket.data.room}`).emit('typing', { room: socket.data.room, username: user.username });
    });
    socket.on('disconnect', () => { clearTimeout(expiry); presence(socket.data.room); });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use(express.static(resolve(ROOT, 'public')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    console.error('Request failed:', error.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return {
    app, httpServer, io,
    async close() {
      clearInterval(cleanup);
      await new Promise((done) => io.close(done));
      if (httpServer.listening) await new Promise((done) => httpServer.close(done));
      db.close();
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const chat = createChatServer();
  chat.httpServer.listen(port, '0.0.0.0', () => console.log(`Neon Chat is listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { chat.close().then(() => process.exit(0)).catch(() => process.exit(1)); });
}
