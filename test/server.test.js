import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as client } from 'socket.io-client';
import { createChatServer } from '../server.js';

async function fixture(t, options = {}) {
  const app = createChatServer({ databasePath: ':memory:', ...options });
  await new Promise(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  let closed = false;
  async function close() { if (!closed) { closed = true; await app.close(); } }
  t.after(close);
  async function request(path, body, cookie, extra = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieHeader: response.headers.get('set-cookie') };
  }
  return { app, base, request, close };
}
async function register(f, username = 'nova') {
  const result = await f.request('/api/auth/register', { username, password: 'a-long-test-password' });
  assert.equal(result.status, 201);
  assert.match(result.cookieHeader, /HttpOnly/);
  assert.match(result.cookieHeader, /SameSite=Strict/);
  return result.cookie;
}
async function connect(t, base, cookie) {
  const socket = client(base, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: base }, reconnection: false, autoConnect: false });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  return socket;
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(name, onEvent); reject(new Error(`Missing ${name}`)); }, 4000);
    function onEvent(value) { clearTimeout(timeout); resolve(value); }
    socket.once(name, onEvent);
  });
}
const emit = (socket, name, body) => socket.timeout(4000).emitWithAck(name, body);
const message = (room, body) => ({ room, body, clientId: randomUUID() });

test('accounts validate, normalize usernames, authenticate and revoke sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/me')).status, 401);
  assert.equal((await f.request('/api/auth/register', { username: 'x', password: 'short' })).status, 400);
  assert.equal((await f.request('/api/auth/register', null)).status, 400);
  const cookie = await register(f, 'Nova');
  assert.equal((await f.request('/api/me', undefined, cookie)).body.user.username, 'nova');
  assert.equal((await f.request('/api/auth/register', { username: 'NOVA', password: 'a-long-test-password' })).status, 409);
  assert.equal((await f.request('/api/auth/login', { username: 'nova', password: 'wrong-password' })).status, 401);
  const login = await f.request('/api/auth/login', { username: 'NOVA', password: 'a-long-test-password' });
  assert.equal(login.status, 200);
  const socket = await connect(t, f.base, login.cookie);
  const disconnected = event(socket, 'disconnect');
  assert.equal((await f.request('/api/logout', {}, login.cookie)).status, 200);
  await disconnected;
  assert.equal((await f.request('/api/me', undefined, login.cookie)).status, 401);
});

test('cross-origin writes and unauthenticated sockets are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/register', { username: 'nova', password: 'a-long-test-password' }, undefined, { Origin: 'https://evil.invalid' })).status, 403);
  await assert.rejects(connect(t, f.base, ''), /sign in/i);
});

test('messages broadcast, deduplicate, validate and stay isolated by room', async t => {
  const f = await fixture(t);
  const cookie = await register(f);
  const otherCookie = await register(f, 'orbit');
  const a = await connect(t, f.base, cookie);
  const b = await connect(t, f.base, otherCookie);
  assert.equal((await emit(a, 'join', 'general')).room, 'general');
  await emit(b, 'join', 'general');
  const received = event(b, 'message');
  const payload = message('general', '<img src=x onerror=alert(1)>');
  const sent = await emit(a, 'message', payload);
  assert.ok(sent.message);
  assert.equal((await received).body, payload.body);
  assert.equal(sent.message.username, 'nova');
  assert.equal((await emit(a, 'message', payload)).message.id, sent.message.id);
  const history = await emit(b, 'join', 'general');
  assert.equal(history.messages.length, 1);
  assert.ok((await emit(a, 'join', 'invalid')).error);
  assert.ok((await emit(a, 'message', message('general', ' '))).error);
  assert.ok((await emit(a, 'message', message('general', 'x'.repeat(2001)))).error);
  assert.ok((await emit(a, 'message', null)).error);
  await emit(b, 'join', 'creative');
  assert.ok((await emit(b, 'message', message('general', 'wrong room'))).error);
  assert.equal((await emit(b, 'join', 'creative')).messages.length, 0);
  const isolated = [];
  b.on('message', item => isolated.push(item));
  await emit(a, 'message', message('general', 'Only the lobby sees this.'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(isolated.length, 0);
});

test('SQLite preserves accounts and messages across a server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neon-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'chat.sqlite');
  const first = await fixture(t, { databasePath });
  const cookie = await register(first);
  const socket = await connect(t, first.base, cookie);
  await emit(socket, 'join', 'general');
  await emit(socket, 'message', message('general', 'Still here tomorrow.'));
  socket.close();
  await first.close();
  const second = await fixture(t, { databasePath });
  assert.equal((await second.request('/api/me', undefined, cookie)).status, 200);
  const reconnected = await connect(t, second.base, cookie);
  assert.equal((await emit(reconnected, 'join', 'general')).messages[0].body, 'Still here tomorrow.');
  reconnected.close();
  await second.close();
});

test('rate limits repeated authentication attempts', async t => {
  const f = await fixture(t);
  let result;
  for (let i = 0; i < 21; i++) result = await f.request('/api/auth/login', { username: 'x', password: 'x' });
  assert.equal(result.status, 429);
});

test('serves the app with security headers and requires HTTPS in production', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await response.text(), /id="auth-form"/);
  assert.equal((await f.request('/api/health')).body.ok, true);
  assert.throws(() => createChatServer({ production: true, origin: 'http://example.invalid', databasePath: ':memory:' }), /HTTPS/);
});
