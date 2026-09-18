import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as client } from 'socket.io-client';
import { createChatServer } from '../server.js';

async function fixture(t, options = {}) {
  const app = createChatServer({ dbPath: ':memory:', ...options });
  await new Promise(resolve => app.http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.http.address().port}`;
  t.after(() => app.close());
  async function request(path, body, cookie, extra = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { app, base, request };
}
async function register(f, username = 'nova') {
  const result = await f.request('/api/register', { username, password: 'a-long-test-password' });
  assert.equal(result.status, 201);
  assert.ok(result.cookie);
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

test('accounts validate, normalize usernames, authenticate and revoke sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/me')).status, 401);
  assert.equal((await f.request('/api/register', { username: 'x', password: 'short' })).status, 400);
  assert.equal((await f.request('/api/register', null)).status, 400);
  const cookie = await register(f, 'Nova');
  assert.equal((await f.request('/api/me', undefined, cookie)).body.user.username, 'nova');
  assert.equal((await f.request('/api/register', { username: 'NOVA', password: 'a-long-test-password' })).status, 409);
  assert.equal((await f.request('/api/login', { username: 'nova', password: 'wrong-password' })).status, 401);
  const login = await f.request('/api/login', { username: 'NOVA', password: 'a-long-test-password' });
  assert.equal(login.status, 200);
  const socket = await connect(t, f.base, login.cookie);
  const disconnected = event(socket, 'disconnect');
  assert.equal((await f.request('/api/logout', {}, login.cookie)).status, 200);
  await disconnected;
  assert.equal((await f.request('/api/me', undefined, login.cookie)).status, 401);
});

test('cross-origin writes and unauthenticated sockets are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/register', { username: 'nova', password: 'a-long-test-password' }, undefined, { Origin: 'https://evil.invalid' })).status, 403);
  await assert.rejects(connect(t, f.base, ''), /Sign in/);
});

test('messages broadcast, deduplicate, persist, and stay isolated by room', async t => {
  const f = await fixture(t);
  const cookie = await register(f);
  const otherCookie = await register(f, 'orbit');
  const a = await connect(t, f.base, cookie);
  const b = await connect(t, f.base, otherCookie);
  assert.equal((await emit(a, 'room:join', { room: 'general' })).ok, true);
  await emit(b, 'room:join', { room: 'general' });
  const received = event(b, 'message:new');
  const payload = { room: 'general', text: '<img src=x onerror=alert(1)>', clientId: 'test-message-1' };
  const sent = await emit(a, 'message:send', payload);
  assert.equal(sent.ok, true);
  assert.equal((await received).text, payload.text);
  assert.equal(sent.message.username, 'nova');
  const retry = await emit(a, 'message:send', payload);
  assert.equal(retry.message.id, sent.message.id);
  const history = await emit(b, 'room:join', { room: 'general' });
  assert.equal(history.messages.length, 1);
  assert.equal((await emit(a, 'room:join', { room: 'invalid' })).ok, false);
  assert.equal((await emit(a, 'message:send', { room: 'general', text: ' ', clientId: 'empty' })).ok, false);
  assert.equal((await emit(a, 'message:send', { room: 'general', text: 'x'.repeat(2001), clientId: 'long' })).ok, false);
  assert.equal((await emit(a, 'message:send', null)).ok, false);
  await emit(b, 'room:join', { room: 'creative' });
  assert.equal((await emit(b, 'message:send', { room: 'general', text: 'wrong room', clientId: 'wrong' })).ok, false);
  assert.equal((await emit(b, 'room:join', { room: 'creative' })).messages.length, 0);
});

test('SQLite preserves accounts and messages across a server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neon-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'chat.sqlite');
  const first = await fixture(t, { dbPath });
  const cookie = await register(first);
  const socket = await connect(t, first.base, cookie);
  await emit(socket, 'room:join', { room: 'general' });
  await emit(socket, 'message:send', { room: 'general', text: 'Still here tomorrow.', clientId: 'persistent-message' });
  socket.close();
  await first.app.close();
  const second = await fixture(t, { dbPath });
  assert.equal((await second.request('/api/me', undefined, cookie)).status, 200);
  const reconnected = await connect(t, second.base, cookie);
  assert.equal((await emit(reconnected, 'room:join', { room: 'general' })).messages[0].text, 'Still here tomorrow.');
});

test('rate limits repeated authentication attempts', async t => {
  const f = await fixture(t);
  let result;
  for (let i = 0; i < 21; i++) result = await f.request('/api/login', { username: 'x', password: 'x' });
  assert.equal(result.status, 429);
});
