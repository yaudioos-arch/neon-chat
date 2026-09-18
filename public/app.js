/* global io */
'use strict';
const $ = (id) => document.getElementById(id);
const state = { mode: 'register', user: null, rooms: [], room: 'general', socket: null, messages: new Map(), ready: false, sending: false, pending: null, joinVersion: 0, typing: new Map() };
let toastTimer;
let typingTimer;
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function avatar(username) {
  const tone = [...username].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
  return element('span', `avatar tone-${tone}`, username.slice(0, 2).toUpperCase());
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an unexpected response. Please retry.'); }
  if (!response.ok) { const error = new Error(data.error || 'Request failed.'); error.status = response.status; throw error; }
  return data;
}
function mode(next) {
  state.mode = next;
  const register = next === 'register';
  $('register-tab').classList.toggle('active', register);
  $('login-tab').classList.toggle('active', !register);
  $('register-tab').setAttribute('aria-pressed', String(register));
  $('login-tab').setAttribute('aria-pressed', String(!register));
  $('auth-title').textContent = register ? 'Welcome to the inner circle.' : 'Back on your frequency.';
  $('auth-subtitle').textContent = register ? 'Pick a username. Find your people. Make some noise.' : 'Your conversations are right where you left them.';
  $('auth-submit').textContent = register ? 'Find my frequency ↗' : 'Step back inside ↗';
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
}
$('register-tab').addEventListener('click', () => mode('register'));
$('login-tab').addEventListener('click', () => mode('login'));
$('password-toggle').addEventListener('click', () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('password-toggle').textContent = show ? 'Hide' : 'Show';
  $('password-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('auth-submit').disabled = true;
  $('register-tab').disabled = true;
  $('login-tab').disabled = true;
  $('auth-error').textContent = '';
  try {
    const data = await api(`/api/auth/${state.mode}`, { username: $('username').value.trim(), password: $('password').value });
    $('password').value = '';
    enter(data);
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; $('register-tab').disabled = false; $('login-tab').disabled = false; }
});
function setReady(ready) {
  state.ready = ready;
  $('message-input').disabled = !ready;
  $('send-button').disabled = !ready || state.sending || !$('message-input').value.trim();
  $('connection-status').textContent = ready ? '● LIVE' : '○ CONNECTING';
  $('connection-status').classList.toggle('offline', !ready);
}
function emitAck(event, data) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('You are offline. Reconnect and try again.'));
    state.socket.timeout(7000).emit(event, data, (error, result) => {
      if (error) return reject(new Error('No response yet. Retry when connected.'));
      if (!result || result.error) return reject(new Error(result?.error || 'Unexpected server response.'));
      resolve(result);
    });
  });
}
function closeMenu() { $('sidebar').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded', 'false'); }
function enter(data) {
  state.user = data.user;
  state.rooms = data.rooms;
  state.room = 'general';
  state.messages.clear();
  state.typing.clear();
  state.pending = null;
  $('message-input').value = '';
  $('message-search').value = '';
  $('character-count').textContent = '0 / 2000';
  $('auth-view').hidden = true;
  $('chat-view').hidden = false;
  $('my-username').textContent = `@${state.user.username}`;
  const ownAvatar = avatar(state.user.username);
  ownAvatar.id = 'my-avatar';
  $('my-avatar').replaceWith(ownAvatar);
  $('room-list').replaceChildren();
  for (const room of state.rooms) {
    const button = element('button', 'room-button');
    button.type = 'button';
    button.dataset.room = room.id;
    button.append(element('span', 'room-icon', room.emoji), element('span', '', room.name), element('span', 'room-arrow', '↗'));
    button.addEventListener('click', () => { if (state.sending) { toast('Wait for your message to finish sending.'); return; } switchRoom(room.id); });
    $('room-list').append(button);
  }
  if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); }
  if (typeof io !== 'function') { toast('The chat client could not load. Refresh to try again.'); return; }
  const socket = io({ autoConnect: false });
  state.socket = socket;
  socket.on('connect', () => switchRoom(state.room));
  socket.on('disconnect', (reason) => {
    setReady(false);
    state.joinVersion++;
    $('people-list').replaceChildren();
    $('online-count').textContent = '0';
    if (reason === 'io server disconnect') showAuth('Your session ended. Please sign in again.');
  });
  socket.on('connect_error', (error) => {
    setReady(false);
    if (error.message === 'Please sign in again.') showAuth(error.message);
    else toast('Connection interrupted. Retrying automatically…');
  });
  socket.on('message', (message) => {
    if (message.room !== state.room) return;
    state.messages.set(message.id, message);
    state.typing.delete(message.username);
    renderTyping();
    renderMessages(message.username === state.user?.username);
  });
  socket.on('presence', ({ room, users }) => { if (room === state.room) renderPeople(users); });
  socket.on('typing', ({ room, username }) => {
    if (room !== state.room) return;
    state.typing.set(username, Date.now() + 3000);
    renderTyping();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(renderTyping, 3100);
  });
  setReady(false);
  socket.connect();
}
async function switchRoom(roomId) {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room) return;
  const previous = state.room;
  const version = ++state.joinVersion;
  state.room = roomId;
  state.messages.clear();
  state.typing.clear();
  $('typing-status').textContent = '';
  $('message-search').value = '';
  $('people-list').replaceChildren();
  $('online-count').textContent = '0';
  if (previous !== roomId) { $('message-input').value = ''; state.pending = null; $('character-count').textContent = '0 / 2000'; }
  for (const button of $('room-list').children) { const active = button.dataset.room === roomId; button.classList.toggle('active', active); button.setAttribute('aria-current', String(active)); }
  $('room-title').textContent = room.name;
  $('room-description').textContent = room.description;
  $('room-symbol').textContent = room.emoji;
  $('intro-symbol').textContent = room.emoji;
  $('intro-name').textContent = room.name;
  $('intro-description').textContent = room.description;
  $('message-input').placeholder = `Message #${room.name}…`;
  closeMenu();
  setReady(false);
  renderMessages(true);
  $('empty-state').textContent = 'Tuning in to your channel…';
  try {
    const result = await emitAck('join', roomId);
    if (version !== state.joinVersion) return;
    for (const message of result.messages) state.messages.set(message.id, message);
    renderMessages(true);
    setReady(true);
  } catch (error) {
    if (version !== state.joinVersion) return;
    $('empty-state').textContent = 'Could not load this channel. Select it again to retry.';
    $('connection-status').textContent = '○ NOT READY';
    toast(error.message);
  }
}
function renderMessages(forceScroll = false) {
  const scroll = $('message-scroll');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const search = $('message-search').value.trim().toLowerCase();
  let messages = [...state.messages.values()].sort((a, b) => a.id - b.id);
  if (messages.length > 100) { messages = messages.slice(-100); state.messages = new Map(messages.map((message) => [message.id, message])); }
  const filtered = messages.filter((message) => `${message.username} ${message.body}`.toLowerCase().includes(search));
  const fragment = document.createDocumentFragment();
  for (const message of filtered) {
    const own = message.username === state.user?.username;
    const article = element('article', `message${own ? ' own' : ''}`);
    const content = element('div', 'message-content');
    const meta = element('div', 'message-meta');
    const time = element('time', '', timeFormat.format(new Date(message.createdAt)));
    time.dateTime = new Date(message.createdAt).toISOString();
    time.title = new Date(message.createdAt).toLocaleString();
    meta.append(element('strong', '', message.username));
    if (own) meta.append(element('span', 'you-badge', 'YOU'));
    meta.append(time);
    content.append(meta, element('p', 'message-body', message.body));
    article.append(avatar(message.username), content);
    fragment.append(article);
  }
  $('messages').replaceChildren(fragment);
  $('empty-state').hidden = filtered.length > 0;
  $('empty-state').textContent = search ? 'No matching messages in the latest 100.' : 'The room is quiet. Be the first to say something ✦';
  if (forceScroll || nearBottom) scroll.scrollTop = scroll.scrollHeight;
}
function renderPeople(users) {
  $('online-count').textContent = String(users.length);
  const fragment = document.createDocumentFragment();
  for (const username of users) {
    const row = element('div', 'person');
    const info = element('div', 'person-info');
    info.append(element('strong', '', username), element('small', '', username === state.user.username ? 'You, being you' : 'On the same frequency'));
    row.append(avatar(username), info, element('span', 'status-dot'));
    fragment.append(row);
  }
  $('people-list').replaceChildren(fragment);
}
function renderTyping() {
  for (const [username, expiry] of state.typing) if (expiry < Date.now()) state.typing.delete(username);
  const names = [...state.typing.keys()];
  $('typing-status').textContent = names.length ? `${names.slice(0, 2).join(' & ')}${names.length > 2 ? ' and others' : ''} ${names.length === 1 ? 'is' : 'are'} typing…` : '';
}
function updateComposer() {
  const input = $('message-input');
  $('character-count').textContent = `${input.value.length} / 2000`;
  $('send-button').disabled = !state.ready || state.sending || !input.value.trim();
}
$('message-input').addEventListener('input', () => { updateComposer(); if (state.ready) state.socket.emit('typing'); });
$('message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); } });
$('message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = $('message-input').value.trim();
  if (!body || !state.ready || state.sending) return;
  if (!window.crypto?.randomUUID) { toast('Use HTTPS or localhost to send messages securely.'); return; }
  if (!state.pending || state.pending.body !== body || state.pending.room !== state.room) state.pending = { room: state.room, body, clientId: crypto.randomUUID() };
  const pending = state.pending;
  const socket = state.socket;
  const draft = $('message-input').value;
  state.sending = true;
  updateComposer();
  try {
    const result = await emitAck('message', pending);
    if (state.socket !== socket || !state.user) return;
    if (result.message.room === state.room) { state.messages.set(result.message.id, result.message); renderMessages(true); }
    if ($('message-input').value === draft) $('message-input').value = '';
    state.pending = null;
  } catch (error) { toast(`${error.message} Your draft is still here.`); }
  finally { state.sending = false; updateComposer(); }
});
$('message-search').addEventListener('input', () => renderMessages());
$('menu-toggle').addEventListener('click', () => { const open = $('sidebar').classList.toggle('open'); $('menu-toggle').setAttribute('aria-expanded', String(open)); });
$('emoji-button').addEventListener('click', () => { $('emoji-picker').hidden = !$('emoji-picker').hidden; $('emoji-button').setAttribute('aria-expanded', String(!$('emoji-picker').hidden)); });
$('emoji-picker').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || !state.ready) return;
  const input = $('message-input');
  const emoji = button.textContent;
  if (input.value.length - (input.selectionEnd - input.selectionStart) + emoji.length <= 2000) input.setRangeText(emoji, input.selectionStart, input.selectionEnd, 'end');
  input.focus();
  updateComposer();
  $('emoji-picker').hidden = true;
  $('emoji-button').setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeMenu(); $('emoji-picker').hidden = true; $('emoji-button').setAttribute('aria-expanded', 'false'); } });
function showAuth(message = '') {
  state.joinVersion++;
  if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); state.socket = null; }
  state.user = null;
  state.messages.clear();
  state.typing.clear();
  state.pending = null;
  clearTimeout(typingTimer);
  setReady(false);
  $('messages').replaceChildren();
  $('people-list').replaceChildren();
  $('message-input').value = '';
  $('typing-status').textContent = '';
  $('chat-view').hidden = true;
  $('auth-view').hidden = false;
  mode('login');
  $('auth-error').textContent = message;
}
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await api('/api/logout', {}); showAuth(); } catch (error) { toast(`Could not sign out: ${error.message}`); }
  finally { $('logout').disabled = false; }
});
(async () => {
  try { enter(await api('/api/me')); }
  catch (error) { if (error.status !== 401) $('auth-error').textContent = error.message; }
})();
