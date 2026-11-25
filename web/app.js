const state = {
  user: null,
  games: [],
  rooms: [],
  room: null,
  spectating: false,
  socket: null,
  roomId: null,
  view: null,
  actions: [],
  matchId: null,
  seq: 0,
  readyFor: null,
  result: null,
  chatIds: new Set(),
  toastTimer: null,
  lobbyTimer: null,
  rendererModule: null,
  rendererGameId: null,
  rendererPromise: null,
  renderToken: 0,
  verifyEmail: null,
  pendingEmail: null,
  pendingJoinRoomId: null,
  pendingJoinRoomName: '',
  createGameId: null,
  adminUsers: [],
};

const $ = (id) => document.getElementById(id);

function showView(name) {
  for (const id of ['login-view', 'lobby-view', 'room-view', 'profile-view', 'admin-view']) {
    $(id).classList.toggle('hidden', id !== name);
  }
}

function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.remove('hidden');
  node.classList.toggle('error', isError);
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.add('hidden'), 4000);
}

function apiError(data, status) {
  const error = new Error(data?.error || `请求失败 (${status})`);
  error.code = data?.code;
  error.status = status;
  return error;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw apiError({ error: '请先登录' }, 401);
  }
  if (response.status === 403 && data?.code === 'NAME_CHANGE_REQUIRED') {
    if (state.user) state.user.nameChangeRequired = true;
    if (state.roomId) await forceLeaveRoom();
    void showProfile(true);
    throw apiError(data, 403);
  }
  if (!response.ok) throw apiError(data, response.status);
  return data;
}

function icon(name) {
  const node = document.createElement('i');
  node.className = `fa-solid ${name}`;
  return node;
}

function button(label, name, className = '') {
  const node = document.createElement('button');
  if (className) node.className = className;
  node.type = 'button';
  if (name) node.appendChild(icon(name));
  if (label) node.appendChild(document.createTextNode(label));
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(status) {
  return {
    waiting: '等待中',
    starting: '准备中',
    playing: '对局中',
    finished: '已结束',
  }[status] || status;
}

function setUser(user) {
  state.user = user;
  renderChrome();
}

function renderChrome() {
  const user = state.user;
  const loggedIn = !!user;
  $('profile-button').classList.toggle('hidden', !loggedIn);
  $('logout').classList.toggle('hidden', !loggedIn);
  $('admin-button').classList.toggle('hidden', !loggedIn || !user?.isAdmin);
  $('user-badge').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) {
    $('user-badge').replaceChildren();
    $('user-badge').textContent = '';
    return;
  }
  const badge = $('user-badge');
  badge.replaceChildren();
  const avatar = el('span', 'user-chip-avatar');
  if (user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    avatar.appendChild(img);
  } else {
    avatar.textContent = (user.name || '?').slice(0, 1).toUpperCase();
  }
  badge.append(avatar, el('span', '', user.name));
}

function showLogin() {
  state.user = null;
  state.room = null;
  state.roomId = null;
  state.spectating = false;
  state.view = null;
  state.result = null;
  state.readyFor = null;
  state.pendingEmail = null;
  if (state.lobbyTimer) clearInterval(state.lobbyTimer);
  state.lobbyTimer = null;
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
  renderChrome();
  showView('login-view');
  showAuthMode('login');
  $('auth-error').textContent = '';
  $('verify-form').classList.add('hidden');
}

function showAuthMode(mode) {
  const login = mode === 'login';
  $('login-form').classList.toggle('hidden', !login);
  $('register-form').classList.toggle('hidden', login);
  $('verify-form').classList.add('hidden');
  $('auth-login-tab').classList.toggle('active', login);
  $('auth-register-tab').classList.toggle('active', !login);
  $('auth-error').textContent = '';
}

function showVerify(email, debugCode, message) {
  state.verifyEmail = email;
  showView('login-view');
  $('login-form').classList.add('hidden');
  $('register-form').classList.add('hidden');
  $('verify-form').classList.remove('hidden');
  $('verify-email').value = email;
  $('verify-code').value = debugCode || '';
  $('verify-hint').textContent =
    message ||
    (debugCode
      ? `开发模式验证码：${debugCode}（设置 SMTP 后会改为发送到邮箱）`
      : '验证码已发送到邮箱，15 分钟内有效。');
  $('auth-error').textContent = '';
}

async function showLobby() {
  if (!state.user) {
    showLogin();
    return;
  }
  if (state.user.nameChangeRequired) {
    await showProfile(true);
    return;
  }
  showView('lobby-view');
  renderChrome();
  // Keep a user-channel socket connected even while in the lobby so admin
  // actions (e.g. force-rename) can reach the user immediately.
  connectSocket();
  await loadLobby();
  if (state.lobbyTimer) clearInterval(state.lobbyTimer);
  state.lobbyTimer = setInterval(() => {
    if (!$('lobby-view').classList.contains('hidden')) void loadLobby().catch(() => {});
  }, 5000);
}

async function loadLobby() {
  const [games, rooms] = await Promise.all([api('/api/games'), api('/api/rooms')]);
  state.games = games.games;
  state.rooms = rooms.rooms;
  renderLobby();
}

function renderLobby() {
  const gameList = $('game-list');
  gameList.replaceChildren();
  if (!state.games.length) {
    gameList.appendChild(el('p', 'muted', '游戏进程未连接。'));
  }
  for (const game of state.games) {
    const item = el('div', 'item');
    const main = el('div', 'item-main');
    main.appendChild(el('div', 'item-title', game.name));
    main.appendChild(
      el('div', 'item-sub', `${game.minPlayers}-${game.maxPlayers} 人 · ${game.id} · v${game.version}`),
    );
    item.appendChild(main);
    const actions = el('div', 'row-actions');
    const rules = button('规则', 'fa-book', 'secondary');
    rules.title = '查看规则';
    rules.addEventListener('click', () => openRules(game.id));
    const create = button('创建房间', 'fa-plus');
    create.addEventListener('click', () => openCreateDialog(game.id));
    actions.append(rules, create);
    item.appendChild(actions);
    gameList.appendChild(item);
  }

  const roomList = $('room-list');
  roomList.replaceChildren();
  if (!state.rooms.length) {
    roomList.appendChild(el('p', 'muted', '还没有房间。选一个游戏开一桌吧。'));
  }
  for (const room of state.rooms) {
    const item = el('div', 'item');
    const main = el('div', 'item-main');
    const title = el('div', 'item-title');
    if (room.hasPassword) title.appendChild(icon('fa-lock'));
    title.appendChild(document.createTextNode(room.name));
    main.appendChild(title);
    const readyCount = room.players.filter((player) => player.ready).length;
    main.appendChild(
      el(
        'div',
        'item-sub',
        `${room.gameName} · ${room.players.length}/${room.maxPlayers} 人 · ${statusLabel(room.status)}` +
          ` · 准备 ${readyCount}/${room.players.length} · 观战 ${room.spectatorCount}`,
      ),
    );
    item.appendChild(main);
    const inRoom = room.players.some((player) => player.userId === state.user.id);
    const canWatch = room.status === 'starting' || room.status === 'playing';
    const actions = el('div', 'row-actions');
    if (inRoom) {
      const enter = button('进入', 'fa-door-open', 'secondary');
      enter.addEventListener('click', () => void openRoom(room.id, false));
      actions.appendChild(enter);
    } else if (canWatch) {
      const watch = button('观战', 'fa-eye', 'secondary');
      watch.addEventListener('click', () => void watchRoom(room.id));
      actions.appendChild(watch);
    } else {
      const join = button('加入', room.hasPassword ? 'fa-lock' : 'fa-right-to-bracket');
      join.addEventListener('click', () => requestJoin(room));
      actions.appendChild(join);
    }
    item.appendChild(actions);
    roomList.appendChild(item);
  }
}

function openRules(gameId) {
  const page =
    gameId === 'ice' || gameId === 'ice-chaos'
      ? '/rules/ice.html'
      : gameId === 'reversi'
        ? '/rules/reversi.html'
        : gameId === 'alendo'
          ? '/rules/alendo.html'
          : '/rules/mock-ttt.html';
  $('rules-title').textContent =
    gameId === 'ice-chaos'
      ? '冰她 · 规则'
      : gameId === 'reversi'
        ? '黑白棋 · 规则'
        : gameId === 'alendo'
          ? '阿尔林铎棋 · 规则'
          : '规则';
  $('rules-frame').src = page;
  $('rules-dialog').showModal();
}

function openCreateDialog(gameId) {
  state.createGameId = gameId;
  const game = state.games.find((candidate) => candidate.id === gameId);
  $('create-title').textContent = `创建房间 · ${game?.name || gameId}`;
  $('create-name').value = '';
  $('create-password').value = '';
  $('create-dialog').showModal();
}

function requestJoin(room) {
  if (room.hasPassword) {
    state.pendingJoinRoomId = room.id;
    state.pendingJoinRoomName = room.name;
    $('join-password-title').textContent = `加入「${room.name}」需要 6 位数字密码`;
    $('join-password').value = '';
    $('join-password-dialog').showModal();
    return;
  }
  void joinRoom(room.id);
}

async function joinRoom(roomId, password) {
  try {
    const data = await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
    });
    await openRoom(data.room.id);
  } catch (error) {
    toast(error.message, true);
  }
}

async function openRoom(roomId, spectate = false) {
  try {
    const suffix = spectate ? '?spectate=1' : '';
    const data = await api(`/api/rooms/${roomId}${suffix}`);
    state.room = data.room;
    state.roomId = roomId;
    state.spectating = spectate || !!data.room.you?.spectator;
    state.view = null;
    state.actions = [];
    state.result = null;
    state.matchId = data.room.matchId;
    state.readyFor = null;
    if (state.lobbyTimer) clearInterval(state.lobbyTimer);
    state.lobbyTimer = null;
    showView('room-view');
    renderRoom();
    await loadMessages();
    connectSocket();
    subscribeRoom();
  } catch (error) {
    toast(error.message, true);
    await showLobby();
  }
}

async function watchRoom(roomId) {
  await openRoom(roomId, true);
}

function connectSocket() {
  if (state.socket) return;
  // eslint-disable-next-line no-undef
  const socket = io({ transports: ['websocket'] });
  state.socket = socket;

  socket.on('connect', () => {
    if (state.roomId) subscribeRoom();
  });
  socket.on('disconnect', () => {
    if (state.roomId) $('game-status').textContent = '连接断开，正在重连…';
  });
  socket.on('room.state', (room) => {
    if (!state.room || room.id !== state.roomId) return;
    state.room = room;
    renderRoom();
  });
  socket.on('room.players', (players) => {
    if (!state.room) return;
    state.room.players = players;
    renderRoom();
  });
  socket.on('room.spectators', (spectators) => {
    if (!state.room) return;
    state.room.spectators = spectators;
    renderRoom();
  });
  socket.on('chat.message', (message) => {
    if (message.roomId === state.roomId) appendChat(message);
  });
  socket.on('game.view', (payload) => {
    if (!state.room) return;
    if (state.room.matchId && payload.matchId !== state.room.matchId) return;
    state.room.matchId = payload.matchId;
    state.matchId = payload.matchId;
    state.seq = payload.seq;
    state.view = payload.view;
    state.actions = payload.actions || [];
    if (payload.view?.status !== 'finished') state.result = null;
    ensureReady();
    void renderGame();
  });
  socket.on('game.started', () => {
    if (!state.room) return;
    state.result = null;
    state.room.status = 'playing';
    renderRoom();
    $('game-status').textContent = '对局开始';
  });
  socket.on('game.result', (payload) => {
    if (!state.room) return;
    if (state.room.matchId && payload.matchId !== state.room.matchId) return;
    state.room.matchId = payload.matchId;
    state.result = payload.result;
    state.room.status = 'finished';
    renderRoom();
    void renderGame();
  });
  socket.on('game.event', (payload) => {
    const event = payload?.event;
    if (event?.type === 'match_aborted') {
      toast(event.reason || '对局已中止', true);
      state.view = null;
      state.result = null;
      void renderGame();
    }
  });
  socket.on('room.kicked', (payload) => {
    if (payload?.roomId !== state.roomId) return;
    toast(payload.reason || '你已被移出房间', true);
    void forceLeaveRoom();
  });
  socket.on('user.updated', (payload) => {
    if (!payload?.nameChangeRequired) return;
    if (state.user) state.user.nameChangeRequired = true;
    toast('管理员要求你修改用户名', true);
    if (state.roomId) {
      void forceLeaveRoom().then(() => showProfile(true));
    } else {
      void showProfile(true);
    }
  });
  socket.on('error', (payload) => {
    toast(payload?.message || '发生错误', true);
    if (payload?.code === 'E_GAME_CRASH') {
      state.view = null;
      state.result = null;
      state.matchId = null;
      state.readyFor = null;
      void renderGame();
    }
  });
}

function subscribeRoom() {
  if (!state.socket || !state.roomId) return;
  state.socket.emit(
    'room.subscribe',
    { roomId: state.roomId, spectate: state.spectating },
    (result) => {
      if (!result?.ok) toast(result?.error || '无法订阅房间', true);
    },
  );
}

function ensureReady() {
  if (state.spectating || !state.socket || !state.matchId) return;
  if (state.readyFor === state.matchId) return;
  state.readyFor = state.matchId;
  state.socket.emit('game.ready', { matchId: state.matchId });
}

function renderRoom() {
  const room = state.room;
  if (!room) return;
  $('room-title').textContent = room.name;
  $('room-status').textContent = state.spectating ? '观战中' : statusLabel(room.status);

  const playerList = $('player-list');
  playerList.replaceChildren();
  const isOwner = room.ownerId === state.user.id;
  for (const player of room.players) {
    const item = el('div', 'item');
    const main = el('div', 'item-main');
    const title = el('div', 'item-title');
    const dot = el('span', `dot${player.connected ? '' : ' off'}`);
    title.append(dot, document.createTextNode(player.name));
    if (player.userId === state.user.id) title.appendChild(el('span', 'tiny-badge', '你'));
    if (player.userId === room.ownerId) title.appendChild(el('span', 'tiny-badge owner-badge', '房主'));
    main.appendChild(title);
    const details = el('div', 'item-sub');
    details.appendChild(document.createTextNode(`座位 ${player.seat + 1}`));
    if (room.status === 'waiting') {
      details.appendChild(
        el('span', `ready-badge${player.ready ? ' is-ready' : ''}`, player.ready ? '已准备' : '未准备'),
      );
    }
    main.appendChild(details);
    item.appendChild(main);
    if (isOwner && room.status === 'waiting' && player.userId !== room.ownerId) {
      const kick = button('', 'fa-user-xmark', 'icon-button danger');
      kick.title = '踢出房间';
      kick.addEventListener('click', () => void kickPlayer(player));
      item.appendChild(kick);
    }
    playerList.appendChild(item);
  }

  const spectatorList = $('spectator-list');
  spectatorList.replaceChildren();
  if (!room.spectators?.length) {
    spectatorList.appendChild(el('p', 'muted', '还没有观战者'));
  } else {
    for (const spectator of room.spectators) {
      const item = el('div', 'item');
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-title', spectator.name));
      item.appendChild(main);
      spectatorList.appendChild(item);
    }
  }

  const canChat = !state.spectating || room.spectatorChat;
  $('chat-form').classList.toggle('hidden', !canChat);
  $('chat-note').classList.toggle('hidden', canChat);
  if (!canChat) {
    $('chat-note').textContent = '这个游戏是隐藏信息对局，观战者只能看牌，不能发言。';
  }
  $('chat-input').placeholder = state.spectating
    ? '观战者发言，所有人可见'
    : '公开聊天，所有人可见';

  const actions = $('room-actions');
  actions.replaceChildren();
  if (state.spectating) {
    const exit = button('退出观战', 'fa-eye-slash', 'secondary');
    exit.addEventListener('click', () => void leaveRoom());
    actions.appendChild(exit);
  } else {
    const me = room.players.find((player) => player.userId === state.user.id);
    if ((room.gameId === 'reversi' || room.gameId === 'alendo') && room.status === 'waiting') {
      renderReversiColorSetting(actions);
    }
    if (room.status === 'waiting') {
      const ready = button(me?.ready ? '取消准备' : '准备', me?.ready ? 'fa-xmark' : 'fa-check');
      ready.addEventListener('click', () => void toggleReady(!me?.ready));
      actions.appendChild(ready);
      if (isOwner) {
        const start = button('开始游戏', 'fa-play');
        start.disabled = room.players.length < room.minPlayers || !room.allReady;
        start.title =
          room.players.length < room.minPlayers
            ? `至少需要 ${room.minPlayers} 人`
            : !room.allReady
              ? '等待所有玩家准备'
              : '';
        start.addEventListener('click', () => void startRoom());
        actions.appendChild(start);
        if (!room.allReady) actions.appendChild(el('p', 'muted small', '所有玩家准备后才能开始'));
      }
    }
    if (room.status === 'finished' && isOwner) {
      const restart = button('重新开始', 'fa-rotate-right');
      restart.addEventListener('click', () => void restartRoom());
      actions.appendChild(restart);
    }
    const leave = button('离开房间', 'fa-right-from-bracket', 'secondary');
    leave.addEventListener('click', () => void leaveRoom());
    actions.appendChild(leave);
  }

  $('game-status').textContent = state.spectating
    ? '观战中；观战者不参与操作。'
    : room.status === 'waiting'
      ? room.allReady
        ? '所有玩家已准备，房主可以开始'
        : '等待所有玩家准备'
      : room.status === 'starting'
        ? '正在启动游戏进程…'
        : room.status === 'finished'
          ? '对局结束，房主可以重新开始'
          : '';
}

function renderReversiColorSetting(actions) {
  const room = state.room;
  if (!room) return;
  const hostColor = room.settings?.hostColor === 'white' ? 'white' : 'black';
  const myColor = room.ownerId === state.user.id
    ? hostColor
    : (hostColor === 'black' ? 'white' : 'black');
  const box = el('div', 'room-setting');
  box.appendChild(el('span', 'room-setting-label', room.gameId === 'alendo' ? '阿尔林铎棋执子' : '黑白棋执子'));
  if (room.ownerId === state.user.id) {
    const group = el('div', 'segmented');
    for (const color of ['black', 'white']) {
      const choice = button(color === 'black' ? '黑棋' : '白棋', color === 'black' ? 'fa-circle' : 'fa-circle', `segmented-button${hostColor === color ? ' active' : ''}`);
      choice.disabled = room.status !== 'waiting';
      choice.addEventListener('click', () => void setReversiColor(color));
      group.appendChild(choice);
    }
    box.appendChild(group);
  }
  box.appendChild(el('span', 'muted small', `你执${myColor === 'black' ? '黑棋' : '白棋'}`));
  actions.appendChild(box);
}

async function setReversiColor(color) {
  try {
    const data = await api(`/api/rooms/${state.roomId}/settings`, {
      method: 'POST',
      body: JSON.stringify({ settings: { ...(state.room?.settings || {}), hostColor: color } }),
    });
    state.room = data.room;
    renderRoom();
  } catch (error) {
    toast(error.message, true);
  }
}

async function toggleReady(ready) {
  try {
    const data = await api(`/api/rooms/${state.roomId}/ready`, {
      method: 'POST',
      body: JSON.stringify({ ready }),
    });
    state.room = data.room;
    renderRoom();
  } catch (error) {
    toast(error.message, true);
  }
}

async function startRoom() {
  try {
    await api(`/api/rooms/${state.roomId}/start`, { method: 'POST', body: '{}' });
  } catch (error) {
    toast(error.message, true);
  }
}

async function restartRoom() {
  try {
    const data = await api(`/api/rooms/${state.roomId}/restart`, { method: 'POST', body: '{}' });
    state.room = data.room;
    state.view = null;
    state.result = null;
    state.matchId = null;
    state.readyFor = null;
    await loadMessages();
    renderRoom();
    void renderGame();
    toast('已回到准备阶段');
  } catch (error) {
    toast(error.message, true);
  }
}

async function kickPlayer(player) {
  if (!window.confirm(`将 ${player.name} 踢出房间？`)) return;
  try {
    await api(`/api/rooms/${state.roomId}/kick`, {
      method: 'POST',
      body: JSON.stringify({ userId: player.userId }),
    });
    toast('已踢出玩家');
  } catch (error) {
    toast(error.message, true);
  }
}

async function forceLeaveRoom() {
  if (state.socket) {
    state.socket.emit('room.unsubscribe');
    state.socket.close();
    state.socket = null;
  }
  state.room = null;
  state.roomId = null;
  state.spectating = false;
  state.view = null;
  state.result = null;
  state.matchId = null;
  state.readyFor = null;
  await showLobby();
}

async function leaveRoom() {
  if (!state.spectating) {
    try {
      await api(`/api/rooms/${state.roomId}/leave`, { method: 'POST', body: '{}' });
    } catch (error) {
      toast(error.message, true);
    }
  }
  await forceLeaveRoom();
}

async function renderGame() {
  const token = ++state.renderToken;
  const area = $('game-area');
  const room = state.room;
  if (!room) return;

  if (!state.view) {
    area.replaceChildren();
    if (state.result) area.appendChild(el('h3', '', resultText(state.result)));
    area.appendChild(
      el(
        'p',
        'muted',
        room.status === 'waiting'
          ? '所有玩家准备后，房主开始游戏。'
          : room.status === 'finished'
            ? '对局结束。'
            : '等待游戏进程发送视图…',
      ),
    );
    return;
  }

  if (state.rendererGameId !== room.gameId) {
    state.rendererGameId = room.gameId;
    state.rendererModule = null;
    state.rendererPromise = import(`/games/${room.gameId}.js`).catch(() => null);
  }
  if (state.rendererPromise) {
    state.rendererModule = await state.rendererPromise;
    state.rendererPromise = null;
  }
  if (token !== state.renderToken) return;

  area.replaceChildren();
  if (!state.rendererModule || typeof state.rendererModule.render !== 'function') {
    area.appendChild(el('p', 'muted', '这个游戏还没有前端模块，下面是原始视图：'));
    area.appendChild(el('pre', 'muted', JSON.stringify(state.view, null, 2)));
    return;
  }

  state.rendererModule.render(area, {
    view: state.view,
    actions: state.actions,
    myUserId: state.user.id,
    onAction: (action) => {
      if (!state.socket || !state.matchId) return;
      state.socket.emit(
        'game.action',
        {
          matchId: state.matchId,
          seq: state.seq,
          actionId:
            typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          action,
        },
        (result) => {
          if (!result?.ok) toast(result?.error || '动作被拒绝', true);
        },
      );
    },
  });
  if (state.result) area.prepend(el('h3', '', resultText(state.result)));
}

function resultText(result) {
  const winners = Array.isArray(result?.winners) ? result.winners : [];
  if (!winners.length) return '平局';
  if (!state.spectating && winners.includes(state.user.id)) return '你赢了';
  const names = winners
    .map((id) => state.room?.players.find((player) => player.userId === id)?.name || id)
    .join('、');
  return `${names} 获胜`;
}

async function loadMessages() {
  if (!state.roomId) return;
  const suffix = state.spectating ? '?spectate=1' : '';
  const data = await api(`/api/rooms/${state.roomId}/messages${suffix}`);
  const list = $('chat-list');
  list.replaceChildren();
  state.chatIds = new Set();
  for (const message of data.messages) appendChat(message, false);
}

function appendChat(message, scroll = true) {
  if (message.id && state.chatIds.has(message.id)) return;
  if (message.id) state.chatIds.add(message.id);
  const list = $('chat-list');
  const line = el('div', 'chat-line');
  const name = el('b', '', message.role === 'spectator' ? `${message.name} [观战]` : message.name);
  line.append(name, document.createTextNode(`：${message.text}`));
  list.appendChild(line);
  if (scroll) list.scrollTop = list.scrollHeight;
}

async function sendChat(event) {
  event.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.socket) return;
  state.socket.emit('chat.send', { text }, (result) => {
    if (result?.ok) input.value = '';
    else toast(result?.error || '发送失败', true);
  });
}

async function showProfile(forceRename = false) {
  if (!state.user) return showLogin();
  try {
    const [me, stats] = await Promise.all([api('/api/me'), api('/api/stats/me')]);
    setUser(me.user);
    state.profileStats = stats;
    if (me.user.nameChangeRequired) {
      state.user.nameChangeRequired = true;
    }
    showView('profile-view');
    renderProfile();
    if (forceRename || me.user.nameChangeRequired) {
      $('profile-name').focus();
      $('profile-message').textContent = '管理员要求你更换一个新的用户名后才能继续游戏。';
    }
  } catch (error) {
    toast(error.message, true);
  }
}

function renderProfile() {
  const user = state.user;
  if (!user) return;
  $('profile-name').value = user.name;
  $('profile-email').textContent = user.email || '';
  $('profile-id').textContent = `UUID: ${user.id}`;
  $('profile-admin-badge').classList.toggle('hidden', !user.isAdmin);
  $('profile-message').textContent = '';
  $('avatar-status').textContent = '';

  const wrap = $('profile-avatar-wrap');
  wrap.replaceChildren();
  if (user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '头像';
    wrap.appendChild(img);
  } else {
    wrap.appendChild(el('span', '', (user.name || '?').slice(0, 1).toUpperCase()));
  }

  const stats = state.profileStats || { winsByGame: [], wins: 0, total: 0 };
  const list = $('stats-list');
  list.replaceChildren();
  const byId = new Map(state.games.map((game) => [game.id, game.name]));
  if (!stats.winsByGame?.length) {
    list.appendChild(el('p', 'muted', '还没有完成的对局'));
  } else {
    for (const row of stats.winsByGame) {
      const item = el('div', 'item');
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-title', byId.get(row.gameId) || row.gameId));
      main.appendChild(el('div', 'item-sub', `胜 ${row.wins} / 共 ${row.played} 局`));
      item.appendChild(main);
      const badge = el('span', 'win-badge', `${row.wins} 胜`);
      item.appendChild(badge);
      list.appendChild(item);
    }
  }
  $('stats-total').textContent = `总胜场：${stats.wins || 0} · 总对局：${stats.total || 0}`;
}

async function saveName(event) {
  event.preventDefault();
  const wasForced = !!state.user?.nameChangeRequired;
  try {
    const data = await api('/api/me/name', {
      method: 'PATCH',
      body: JSON.stringify({ name: $('profile-name').value }),
    });
    setUser(data.user);
    // The socket caches the display name at connect time; reconnect so chat and
    // room events use the new profile name.
    if (state.socket) {
      state.socket.close();
      state.socket = null;
    }
    $('profile-message').textContent = '用户名已更新';
    toast('用户名已更新');
    if (wasForced) await showLobby();
  } catch (error) {
    $('profile-message').textContent = error.message;
    toast(error.message, true);
  }
}

async function uploadAvatar(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    toast('头像必须是 PNG/JPEG/WebP', true);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('头像文件不能超过 5MB', true);
    return;
  }
  $('avatar-status').textContent = '处理中…';
  try {
    const dataUrl = await resizeAvatar(file);
    const data = await api('/api/me/avatar', {
      method: 'PATCH',
      body: JSON.stringify({ dataUrl }),
    });
    setUser(data.user);
    renderProfile();
    $('avatar-status').textContent = '头像已更新';
  } catch (error) {
    $('avatar-status').textContent = error.message;
    toast(error.message, true);
  }
}

function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        try {
          const size = 128;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法创建头像画布');
          const scale = Math.max(size / image.width, size / image.height);
          const width = image.width * scale;
          const height = image.height * scale;
          ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
          resolve(canvas.toDataURL('image/webp', 0.86));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => reject(new Error('无法读取图片，请换一张 PNG/JPEG/WebP'));
      image.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('无法读取图片文件'));
    reader.readAsDataURL(file);
  });
}

async function requestEmailChange(event) {
  event.preventDefault();
  const email = $('email-new').value.trim();
  const password = $('email-password').value;
  try {
    const data = await api('/api/me/email/change', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    state.pendingEmail = email;
    $('email-verify-form').classList.remove('hidden');
    $('email-verify-hint').textContent = data.debugCode
      ? `开发模式验证码：${data.debugCode}`
      : `验证码已发送到 ${email}`;
    $('email-code').value = data.debugCode || '';
    $('email-password').value = '';
  } catch (error) {
    toast(error.message, true);
  }
}

async function verifyEmailChange(event) {
  event.preventDefault();
  if (!state.pendingEmail) return;
  try {
    const data = await api('/api/me/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email: state.pendingEmail, code: $('email-code').value }),
    });
    setUser(data.user);
    state.pendingEmail = null;
    $('email-verify-form').classList.add('hidden');
    renderProfile();
    toast('邮箱已更新');
  } catch (error) {
    toast(error.message, true);
  }
}

async function showAdmin(search = '') {
  if (!state.user?.isAdmin) return;
  try {
    const data = await api(`/api/admin/users?search=${encodeURIComponent(search)}`);
    state.adminUsers = data.users;
    showView('admin-view');
    renderAdmin();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderAdmin() {
  const list = $('admin-user-list');
  list.replaceChildren();
  for (const user of state.adminUsers) {
    const item = el('div', 'item');
    const main = el('div', 'item-main');
    const title = el('div', 'item-title');
    title.appendChild(document.createTextNode(user.name));
    if (user.isAdmin) title.appendChild(el('span', 'tiny-badge owner-badge', '管理员'));
    if (user.disabled) title.appendChild(el('span', 'tiny-badge danger-badge', '已封禁'));
    if (user.nameChangeRequired) title.appendChild(el('span', 'tiny-badge', '待改名'));
    main.appendChild(title);
    main.appendChild(el('div', 'item-sub', `${user.email} · 胜场 ${user.wins || 0}`));
    item.appendChild(main);
    const actions = el('div', 'row-actions');
    if (user.id !== state.user.id) {
      const ban = button(user.disabled ? '解封' : '封禁', user.disabled ? 'fa-unlock' : 'fa-ban', 'secondary');
      ban.addEventListener('click', () => void toggleBan(user));
      actions.appendChild(ban);
      const rename = button('要求改名', 'fa-pen', 'secondary');
      rename.disabled = !!user.nameChangeRequired;
      rename.addEventListener('click', () => void forceRename(user));
      actions.appendChild(rename);
    }
    item.appendChild(actions);
    list.appendChild(item);
  }
  if (!state.adminUsers.length) list.appendChild(el('p', 'muted', '没有用户'));
}

async function toggleBan(user) {
  const disabled = !user.disabled;
  let reason = '';
  if (disabled) {
    reason = window.prompt('封禁原因（可选）', '') || '';
  }
  try {
    await api(`/api/admin/users/${user.id}/ban`, {
      method: 'POST',
      body: JSON.stringify({ disabled, reason }),
    });
    toast(disabled ? '用户已封禁' : '用户已解封');
    await showAdmin($('admin-search').value);
  } catch (error) {
    toast(error.message, true);
  }
}

async function forceRename(user) {
  if (!window.confirm(`要求 ${user.name} 改名？`)) return;
  try {
    await api(`/api/admin/users/${user.id}/force-rename`, { method: 'POST', body: '{}' });
    state.adminUsers = state.adminUsers.map((candidate) =>
      candidate.id === user.id ? { ...candidate, nameChangeRequired: true } : candidate,
    );
    renderAdmin();
    toast('已要求该用户改名');
  } catch (error) {
    toast(error.message, true);
  }
}

// ── auth ───────────────────────────────────────────────────────────────────
$('auth-login-tab').addEventListener('click', () => showAuthMode('login'));
$('auth-register-tab').addEventListener('click', () => showAuthMode('register'));

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('auth-error').textContent = '';
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value }),
    });
    setUser(data.user);
    await showLobby();
  } catch (error) {
    if (error.code === 'EMAIL_UNVERIFIED') {
      showVerify($('login-email').value.trim(), null, '请先完成邮箱验证。');
    } else {
      $('auth-error').textContent = error.message;
    }
  }
});

$('register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('auth-error').textContent = '';
  const password = $('register-password').value;
  if (password !== $('register-password2').value) {
    $('auth-error').textContent = '两次密码不一致';
    return;
  }
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: $('register-email').value,
        name: $('register-name').value,
        password,
      }),
    });
    showVerify(data.email, data.debugCode);
  } catch (error) {
    $('auth-error').textContent = error.message;
  }
});

$('verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ email: $('verify-email').value, code: $('verify-code').value }),
    });
    setUser(data.user);
    await showLobby();
  } catch (error) {
    $('auth-error').textContent = error.message;
  }
});

$('resend-verification').addEventListener('click', async () => {
  try {
    const data = await api('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email: $('verify-email').value }),
    });
    showVerify(
      $('verify-email').value,
      data.debugCode,
      data.debugCode ? `开发模式验证码：${data.debugCode}` : '验证码已重新发送。',
    );
  } catch (error) {
    $('auth-error').textContent = error.message;
  }
});

$('verify-back').addEventListener('click', () => showAuthMode('login'));
$('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  showLogin();
});

// ── lobby / profile / admin ────────────────────────────────────────────────
$('refresh-lobby').addEventListener('click', () => void loadLobby().catch((error) => toast(error.message, true)));
$('profile-button').addEventListener('click', () => void showProfile());
$('admin-button').addEventListener('click', () => void showAdmin());
$('profile-back').addEventListener('click', () => {
  if (state.roomId) void openRoom(state.roomId, state.spectating);
  else void showLobby();
});
$('admin-back').addEventListener('click', () => {
  if (state.roomId) void openRoom(state.roomId, state.spectating);
  else void showLobby();
});
$('profile-name-form').addEventListener('submit', saveName);
$('avatar-upload').addEventListener('click', () => $('avatar-input').click());
$('avatar-input').addEventListener('change', () => void uploadAvatar($('avatar-input').files?.[0]));
$('email-change-form').addEventListener('submit', requestEmailChange);
$('email-verify-form').addEventListener('submit', verifyEmailChange);
$('admin-search-button').addEventListener('click', () => void showAdmin($('admin-search').value));
$('admin-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void showAdmin($('admin-search').value);
  }
});

// ── room ───────────────────────────────────────────────────────────────────
$('back-lobby').addEventListener('click', () => void leaveRoom());
$('chat-form').addEventListener('submit', (event) => void sendChat(event));

$('create-room-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('create-password').value.trim();
  if (password && !/^\d{6}$/.test(password)) {
    toast('房间密码必须是 6 位数字', true);
    return;
  }
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        gameId: state.createGameId,
        name: $('create-name').value.trim() || undefined,
        password: password || undefined,
      }),
    });
    $('create-dialog').close();
    await openRoom(data.room.id);
  } catch (error) {
    toast(error.message, true);
  }
});

$('create-close').addEventListener('click', () => $('create-dialog').close());
$('create-cancel').addEventListener('click', () => $('create-dialog').close());
$('rules-close').addEventListener('click', () => $('rules-dialog').close());
$('join-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const roomId = state.pendingJoinRoomId;
  if (!roomId) return;
  $('join-password-dialog').close();
  await joinRoom(roomId, $('join-password').value.trim());
});
$('join-password-close').addEventListener('click', () => $('join-password-dialog').close());
$('join-password-cancel').addEventListener('click', () => $('join-password-dialog').close());

// ── boot ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    const data = await api('/api/me');
    setUser(data.user);
    if (data.user.nameChangeRequired) await showProfile(true);
    else await showLobby();
  } catch {
    showLogin();
  }
})();
