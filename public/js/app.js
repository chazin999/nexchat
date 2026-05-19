// ─── STATE ───────────────────────────────────────────────
let currentUser = null;
let socket = null;
let activeChat = null;
let friendsList = [];
let groupsList = [];
let typingTimer = null;
let currentFilter = 'all';
let contextMenuMsg = null;
let replyToMsg = null;

const DEFAULT_AVATAR = (name) =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(name||'U')}&background=4F46E5&color=fff&size=128&bold=true`;

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupAuthTabs();
  setupModalCloses();
  loadTheme();
  loadWallpaper();
  await checkSession();
});

async function checkSession() {
  // Google OAuth error
  const _gp = new URLSearchParams(window.location.search);
  if (_gp.get("google_error")) {
    const _el = document.getElementById("login-error");
    if (_el) { _el.textContent = "Falha no login com Google. Tente novamente."; _el.classList.remove("hidden"); }
    window.history.replaceState({}, "", "/");
  }
  try {
    const res = await fetch('/api/me');
    if (res.ok) { const data = await res.json(); currentUser = data.user; showApp(); }
  } catch {}
}

// ─── AUTH ─────────────────────────────────────────────────
function setupAuthTabs() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      const form = document.getElementById(tab.dataset.tab + '-form');
      if (form) form.classList.add('active');
    });
  });

  const _get = id => document.getElementById(id);
  const _on = (id, ev, fn) => { const el = _get(id); if (el) el.addEventListener(ev, fn); };

  _on('login-btn', 'click', doLogin);
  _on('register-btn', 'click', doRegister);
  _on('login-password', 'keydown', e => { if (e.key === 'Enter') doLogin(); });
  _on('reg-password', 'keydown', e => { if (e.key === 'Enter') doRegister(); });
  _on('forgot-link', 'click', e => { e.preventDefault(); showAuthPanel('forgot'); });
  _on('back-to-login-btn', 'click', () => showAuthPanel('login'));
  _on('forgot-btn', 'click', doForgotPassword);
  _on('forgot-email', 'keydown', e => { if (e.key === 'Enter') doForgotPassword(); });
}

function showAuthPanel(panel) {
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  const formEl = document.getElementById(panel + '-form');
  if (formEl) formEl.classList.add('active');
  const tabEl = document.querySelector(`.auth-tab[data-tab="${panel}"]`);
  if (tabEl) tabEl.classList.add('active');
}

async function doForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('forgot-error');
  const successEl = document.getElementById('forgot-success');
  errEl.classList.add('hidden'); successEl.classList.add('hidden');
  if (!email) return showError(errEl, 'Digite seu email');
  const btn = document.getElementById('forgot-btn');
  btn.textContent = 'Enviando...'; btn.disabled = true;
  try {
    const endpoint = targetEmail ? '/api/forgot-password-to-email' : '/api/forgot-password';
    const body = targetEmail 
      ? { email: document.getElementById('forgot-email').value, targetEmail }
      : { email: document.getElementById('forgot-email').value };
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (!res.ok) return showError(errEl, data.error);
    successEl.textContent = data.message;
    successEl.classList.remove('hidden');
    btn.textContent = 'Link enviado!';
  } catch { showError(errEl, 'Erro de conexão'); btn.textContent = 'Enviar link de recuperação'; btn.disabled = false; }
}

// ─── RESET PASSWORD PAGE ──────────────────────────────────
async function initResetPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) { showResetError('Link inválido.'); return; }
  // Validate token
  try {
    const res = await fetch(`/api/reset-token/${token}`);
    const data = await res.json();
    if (!data.valid) { showResetError('Este link é inválido ou já expirou. Solicite um novo.'); return; }
  } catch { showResetError('Erro ao validar link.'); return; }
  document.getElementById('reset-btn').addEventListener('click', () => doResetPassword(token));
  document.getElementById('reset-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') doResetPassword(token); });
}

function showResetError(msg) {
  const errEl = document.getElementById('reset-error');
  if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  const btn = document.getElementById('reset-btn');
  if (btn) btn.disabled = true;
}

async function doResetPassword(token) {
  const password = document.getElementById('reset-password').value;
  const confirm = document.getElementById('reset-confirm').value;
  const errEl = document.getElementById('reset-error');
  const successEl = document.getElementById('reset-success');
  errEl.classList.add('hidden'); successEl.classList.add('hidden');
  if (!password || !confirm) return showError(errEl, 'Preencha os dois campos');
  if (password.length < 6) return showError(errEl, 'Senha mínima de 6 caracteres');
  if (password !== confirm) return showError(errEl, 'As senhas não coincidem');
  const btn = document.getElementById('reset-btn');
  btn.textContent = 'Salvando...'; btn.disabled = true;
  try {
    const res = await fetch('/api/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) });
    const data = await res.json();
    if (!res.ok) { showError(errEl, data.error); btn.textContent = 'Redefinir Senha'; btn.disabled = false; return; }
    successEl.textContent = data.message;
    successEl.classList.remove('hidden');
    btn.textContent = 'Senha redefinida!';
    setTimeout(() => { window.location.href = '/'; }, 2500);
  } catch { showError(errEl, 'Erro de conexão'); btn.textContent = 'Redefinir Senha'; btn.disabled = false; }
}

// Init reset page if on reset URL
if (typeof window !== 'undefined' && window.location.pathname.includes('reset-password')) {
  document.addEventListener('DOMContentLoaded', initResetPage);
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  if (!email || !password) return showError(errEl, 'Preencha todos os campos');
  const btn = document.getElementById('login-btn');
  btn.textContent = 'Entrando...'; btn.disabled = true;
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) return showError(errEl, data.error);
    currentUser = data.user; showApp();
  } catch { showError(errEl, 'Erro de conexão'); }
  finally { btn.textContent = 'Entrar'; btn.disabled = false; }
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl = document.getElementById('reg-error');
  errEl.classList.add('hidden');
  if (!name || !email || !password) return showError(errEl, 'Preencha todos os campos');
  if (password.length < 6) return showError(errEl, 'Senha mínima de 6 caracteres');
  const btn = document.getElementById('register-btn');
  btn.textContent = 'Criando...'; btn.disabled = true;
  try {
    const res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) });
    const data = await res.json();
    if (!res.ok) return showError(errEl, data.error);
    currentUser = data.user; showApp();
  } catch { showError(errEl, 'Erro de conexão'); }
  finally { btn.textContent = 'Criar Conta Grátis'; btn.disabled = false; }
}

function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }

// ─── APP INIT ─────────────────────────────────────────────
function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  initSocket();
  renderSidebarHeader();
  loadFriends();
  loadGroups().then(handlePendingGroupJoin);
  loadFriendRequests();
  setupSidebarEvents();
  setupProfileModal();
  setupAddFriendModal();
  setupRequestsModal();
  setupNewGroupModal();
  setupChatInput();
  setupEmojiPicker();
  setupThemeToggle();
  setupWallpaperModal();
  setupSecurityModal();
  setupRecoveryMethodModal();
  setupRecoveryEmailsModal();
  setupOTPResetModal();
  setupGroupModerationModal();
  updateRecoveryMethodModal();
  setupContextMenu();
  setupBackBtn();
  setupMemberPopupClose();
}

function renderSidebarHeader() {
  const img = document.getElementById('my-avatar');
  img.src = currentUser.avatar || DEFAULT_AVATAR(currentUser.name);
  img.onerror = () => { img.src = DEFAULT_AVATAR(currentUser.name); };
  document.getElementById('my-status-dot').className = 'status-dot ' + (currentUser.status || 'online');
}

// ─── SOCKET ───────────────────────────────────────────────
function initSocket() {
  socket = io({ reconnectionDelay: 1000, reconnectionAttempts: 10 });
  socket.on('connect', () => { socket.emit('auth', { userId: currentUser.id }); });

  socket.on('message', (msg) => {
    if (activeChat && msg.chatId === activeChatId()) {
      appendMessage(msg);
      scrollToBottom();
      socket.emit('message_read', { chatId: msg.chatId, messageIds: [msg.id] });
    } else {
      const preview = msg.text.length > 50 ? msg.text.substring(0, 50) + '...' : msg.text;
      showToast('💬 ' + msg.fromName + ': ' + preview);
    }
    updateChatListPreview(msg);
  });

  socket.on('typing', ({ userId, name, chatId, isTyping }) => {
    if (activeChat && chatId === activeChatId() && userId !== currentUser.id) {
      const el = document.getElementById('typing-indicator');
      document.getElementById('typing-name').textContent = name;
      if (isTyping) el.classList.remove('hidden'); else el.classList.add('hidden');
    }
  });

  socket.on('user_status', ({ userId, status }) => {
    if (activeChat && activeChat.type === 'friend' && activeChat.data.id === userId) updateChatStatus(status);
    updateFriendStatus(userId, status);
    refreshChatList();
  });

  socket.on('user_updated', (data) => {
    const friend = friendsList.find(f => f.id === data.userId);
    if (friend) { friend.name = data.name; friend.bio = data.bio; friend.avatar = data.avatar; friend.status = data.status; refreshChatList(); }
    if (activeChat && activeChat.type === 'friend' && activeChat.data.id === data.userId) {
      activeChat.data = Object.assign({}, activeChat.data, data);
      document.getElementById('chat-avatar').src = data.avatar || DEFAULT_AVATAR(data.name);
      document.getElementById('chat-name').textContent = getDisplayName(activeChat.data);
    }
  });

socket.on('friend_request', (req) => {
    showToast('👥 ' + req.fromName + ' quer ser seu amigo! Clique no 🔔 para aceitar.');
    const badge = document.getElementById('req-badge');
    if (badge) {
      const current = parseInt(badge.textContent) || 0;
      badge.textContent = current + 1;
      badge.classList.remove('hidden');
    }
    loadFriendRequests();
  });

socket.on('pending_requests', ({ count }) => {
    const badge = document.getElementById('req-badge');
    if (badge) { badge.textContent = count; badge.classList.remove('hidden'); }
    loadFriendRequests();
  });

  socket.on('friend_accepted', (data) => {
    showToast('✅ ' + data.name + ' aceitou sua solicitação!');
    loadFriends();
  });

  socket.on('group_created', (group) => {
    if (!groupsList.find(g => g.id === group.id)) loadGroups();
  });

  socket.on('group_updated', (group) => {
    const idx = groupsList.findIndex(g => g.id === group.id);
    if (idx !== -1) {
      groupsList[idx] = { ...groupsList[idx], ...group };
      if (activeChat && activeChat.type === 'group' && activeChat.data.id === group.id) {
        activeChat.data = { ...activeChat.data, ...group };
        document.getElementById('chat-name').textContent = group.name;
        if (group.avatar) document.getElementById('chat-avatar').src = group.avatar;
        document.getElementById('chat-subtitle').textContent = (group.members ? group.members.length : 0) + ' membros';
      }
      refreshChatList();
    } else { loadGroups(); }
  });

  socket.on('messages_read', ({ chatId, readBy }) => {
    if (activeChat && chatId === activeChatId() && readBy !== currentUser.id) {
      document.querySelectorAll('.check-icon').forEach(el => el.classList.add('read'));
    }
  });

  socket.on('reaction_updated', ({ chatId, msgId, reactions }) => {
    if (activeChat && chatId === activeChatId()) {
      const msgEl = document.querySelector('[data-msg-id="' + msgId + '"]');
      if (msgEl) updateReactionsDisplay(msgEl, reactions, msgId, chatId);
    }
  });

  socket.on('message_deleted', ({ chatId, msgId }) => {
    if (activeChat && chatId === activeChatId()) {
      const el = document.querySelector('[data-msg-id="' + msgId + '"]');
      if (el) {
        const group = el.closest('.message-group');
        el.style.opacity = '0'; el.style.transform = 'scale(0.9)'; el.style.transition = 'all .2s';
        setTimeout(() => { if (group) group.remove(); }, 200);
      }
    }
  });
}

function activeChatId() {
  if (!activeChat) return null;
  if (activeChat.type === 'group') return 'group_' + activeChat.data.id;
  return [currentUser.id, activeChat.data.id].sort().join('_');
}

function getDisplayName(data) {
  if (!data) return '';
  if (data.displayName) return data.displayName;
  const custom = (currentUser.customNames || {})[data.id];
  return custom || data.name;
}

// ─── FRIENDS ──────────────────────────────────────────────
async function loadFriends() {
  try {
    const res = await fetch('/api/friends');
    const data = await res.json();
    friendsList = data.friends || [];
    refreshChatList();
  } catch {}
}

async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    const data = await res.json();
    groupsList = data.groups || [];
    refreshChatList();
  } catch {}
}

async function loadFriendRequests() {
  try {
    const res = await fetch('/api/friends/requests');
    if (!res.ok) return;
    const data = await res.json();
    const requests = data.requests || [];
    const badge = document.getElementById('req-badge');
    if (badge) {
      if (requests.length > 0) { badge.textContent = requests.length; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    renderRequestsList(requests);
  } catch(e) { console.error('[requests] erro:', e); }
}

// ─── CHAT LIST ────────────────────────────────────────────
function setupSidebarEvents() {
  document.querySelectorAll('.chat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      refreshChatList();
    });
  });
  document.getElementById('search-input').addEventListener('input', () => refreshChatList());
}

function refreshChatList() {
  const query = document.getElementById('search-input').value.toLowerCase();
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  let items = [];
  if (currentFilter !== 'groups') {
    friendsList.forEach(f => {
      const displayName = getDisplayName(f);
      if (!query || displayName.toLowerCase().includes(query) || f.name.toLowerCase().includes(query))
        items.push({ type: 'friend', data: f, time: (f.lastMessage && f.lastMessage.timestamp) || f.createdAt || 0 });
    });
  }
  if (currentFilter !== 'friends') {
    groupsList.forEach(g => {
      if (!query || g.name.toLowerCase().includes(query))
        items.push({ type: 'group', data: g, time: (g.lastMessage && g.lastMessage.timestamp) || g.createdAt || 0 });
    });
  }
  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">💬</div><p>Nenhuma conversa</p><span>Adicione amigos para começar</span></div>';
    return;
  }
  items.forEach(item => list.appendChild(createChatItem(item.type, item.data)));
}

function createChatItem(type, data) {
  const div = document.createElement('div');
  div.className = 'chat-item';
  if (activeChat && activeChat.data && activeChat.data.id === data.id && activeChat.type === type) div.classList.add('active');
  const avatar = data.avatar || DEFAULT_AVATAR(data.name);
  const status = type === 'friend' ? (data.status || 'offline') : '';
  const lastMsg = data.lastMessage;
  const timeStr = lastMsg ? formatTime(lastMsg.timestamp) : '';
  const preview = lastMsg ? (type === 'group' ? ((lastMsg.senderName || '') + ': ' + lastMsg.text) : lastMsg.text) : 'Clique para conversar';
  const unread = data.unread > 0 ? '<span class="chat-item-badge">' + data.unread + '</span>' : '';
  const groupTag = type === 'group' ? '<span class="group-tag">👥</span>' : '';
  const displayName = type === 'friend' ? getDisplayName(data) : data.name;
  div.innerHTML = '<div class="chat-item-avatar"><img src="' + avatar + '" alt="" class="avatar avatar-md" onerror="this.src=\'' + DEFAULT_AVATAR(data.name) + '\'" />' + (type === 'friend' ? '<div class="status-dot ' + status + '"></div>' : '') + '</div><div class="chat-item-info"><div class="chat-item-header"><span class="chat-item-name">' + escHtml(displayName) + groupTag + '</span><span class="chat-item-time">' + timeStr + '</span></div><div class="chat-item-preview"><span class="chat-item-last-msg">' + escHtml((preview || '').substring(0, 60)) + '</span>' + unread + '</div></div>';
  div.addEventListener('click', () => openChat(type, data));
  return div;
}

function updateFriendStatus(userId, status) {
  const f = friendsList.find(f => f.id === userId);
  if (f) f.status = status;
}

function updateChatListPreview(msg) {
  const chatId = msg.chatId;
  if (chatId.startsWith('group_')) {
    const g = groupsList.find(g => g.id === chatId.replace('group_', ''));
    if (g) g.lastMessage = { text: msg.text, timestamp: msg.timestamp, senderName: msg.senderName };
  } else {
    const otherId = msg.from === currentUser.id ? msg.to : msg.from;
    const f = friendsList.find(f => f.id === otherId);
    if (f) {
      f.lastMessage = { text: msg.text, timestamp: msg.timestamp };
      if (msg.to === currentUser.id && (!activeChat || activeChatId() !== chatId)) f.unread = (f.unread || 0) + 1;
    }
  }
  refreshChatList();
}

// ─── OPEN CHAT ────────────────────────────────────────────
async function openChat(type, data) {
  activeChat = { type, data };
  document.getElementById('app').classList.remove('chat-open');
  setTimeout(() => document.getElementById('app').classList.add('chat-open'), 10);
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('messages-container').classList.remove('hidden');
  document.getElementById('message-input-area').classList.remove('hidden');
  document.getElementById('typing-indicator').classList.add('hidden');
  document.getElementById('no-chat-selected').style.display = 'none';
  document.getElementById('msg-search-bar').classList.add('hidden');

  const displayName = type === 'friend' ? getDisplayName(data) : data.name;
  const avatarImg = document.getElementById('chat-avatar');
  avatarImg.src = data.avatar || DEFAULT_AVATAR(data.name);
  avatarImg.onerror = () => { avatarImg.src = DEFAULT_AVATAR(data.name); };
  document.getElementById('chat-name').textContent = displayName;

  const statusDot = document.getElementById('chat-status-dot');
  const subtitleEl = document.getElementById('chat-subtitle');
  if (type === 'friend') {
    const st = data.status || 'offline';
    statusDot.className = 'status-dot ' + st;
    statusDot.style.display = '';
    subtitleEl.textContent = statusLabels[st] || st;
  } else {
    statusDot.style.display = 'none';
    const memberCount = data.members ? data.members.length : (data.memberDetails ? data.memberDetails.length : 0);
    subtitleEl.textContent = memberCount + ' membros';
  }

  refreshChatList();
  if (type === 'friend') {
    const f = friendsList.find(f => f.id === data.id);
    if (f) f.unread = 0;
  }

  document.getElementById('chat-header-avatar-wrap').onclick = () => {
    if (type === 'friend') openContactModal(data);
    else openGroupModal(data);
  };
  document.getElementById('view-profile-btn').onclick = () => {
    if (type === 'friend') openContactModal(data);
    else openGroupModal(data);
  };

  applyPendingWallpaper();
  setTimeout(() => document.getElementById('msg-input').focus(), 150);
  await loadMessages();
}

var statusLabels = { online: 'online', busy: 'ocupado', away: 'ausente', offline: 'offline' };

function updateChatStatus(status) {
  document.getElementById('chat-status-dot').className = 'status-dot ' + status;
  document.getElementById('chat-subtitle').textContent = statusLabels[status] || status;
}

async function loadMessages() {
  const chatId = activeChatId();
  try {
    const res = await fetch('/api/messages/' + chatId);
    const data = await res.json();
    renderMessages(data.messages || []);
    scrollToBottom();
  } catch {}
}

// ─── RENDER MESSAGES ──────────────────────────────────────
function renderMessages(messages) {
  const list = document.getElementById('messages-list');
  list.innerHTML = '';
  if (messages.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:13px;padding:48px 0;line-height:1.7">Nenhuma mensagem ainda.<br>Diga olá! 👋</div>';
    return;
  }
  let lastDate = null; let lastFrom = null;
  messages.forEach(function(msg) {
    const msgDate = new Date(msg.timestamp).toLocaleDateString('pt-BR');
    if (msgDate !== lastDate) {
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = '<span>' + formatDateLabel(msg.timestamp) + '</span>';
      list.appendChild(sep);
      lastDate = msgDate; lastFrom = null;
    }
    const isOut = msg.from === currentUser.id;
    const showAvatar = !isOut && (lastFrom !== msg.from);
    list.appendChild(buildMessageEl(msg, isOut, showAvatar));
    lastFrom = msg.from;
  });
}

function buildMessageEl(msg, isOut, showAvatar) {
  const group = document.createElement('div');
  group.className = 'message-group ' + (isOut ? 'out' : 'in');

  const withAvatar = document.createElement('div');
  withAvatar.className = 'message-with-avatar';

  if (!isOut) {
    const av = document.createElement('img');
    av.className = 'avatar avatar-sm msg-avatar';
    av.src = msg.fromAvatar || DEFAULT_AVATAR(msg.fromName || 'U');
    av.onerror = () => { av.src = DEFAULT_AVATAR(msg.fromName || 'U'); };
    av.style.visibility = showAvatar ? 'visible' : 'hidden';
    withAvatar.appendChild(av);
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.dataset.msgId = msg.id;

  // In groups: show sender name + avatar for incoming messages
  if (!isOut && activeChat && activeChat.type === 'group' && showAvatar) {
    const senderRow = document.createElement('div');
    senderRow.className = 'msg-sender-with-avatar';
    const senderAv = document.createElement('img');
    senderAv.className = 'msg-avatar-inline';
    senderAv.src = msg.fromAvatar || DEFAULT_AVATAR(msg.fromName || 'U');
    senderAv.onerror = () => { senderAv.src = DEFAULT_AVATAR(msg.fromName || 'U'); };
    const senderName = document.createElement('span');
    senderName.className = 'msg-sender-name';
    senderName.textContent = msg.fromName || 'Usuário';
    senderRow.appendChild(senderAv);
    senderRow.appendChild(senderName);
    bubble.appendChild(senderRow);
  }

  if (msg.replyTo) {
    const rp = document.createElement('div');
    rp.className = 'reply-preview';
    rp.textContent = '↩ ' + (msg.replyTo.fromName || '') + ': ' + (msg.replyTo.text || '').substring(0, 60);
    bubble.appendChild(rp);
  }

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = msg.text;
  bubble.appendChild(textEl);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';
  footer.innerHTML = '<span class="msg-time">' + formatTime(msg.timestamp) + '</span>';
  if (isOut) {
    footer.innerHTML += '<span class="msg-status"><svg class="check-icon ' + (msg.read ? 'read' : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></span>';
  }
  bubble.appendChild(footer);

  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    updateReactionsDisplay(bubble, msg.reactions, msg.id, msg.chatId);
  }

  bubble.addEventListener('contextmenu', function(e) { e.preventDefault(); showContextMenu(e, msg, isOut); });
  bubble.addEventListener('touchstart', makeLongPress(function(e) { showContextMenu(e, msg, isOut); }), { passive: true });

  withAvatar.appendChild(bubble);
  group.appendChild(withAvatar);
  return group;
}

function updateReactionsDisplay(bubbleEl, reactions, msgId, chatId) {
  var reactEl = bubbleEl.querySelector('.msg-reactions');
  if (!reactEl) { reactEl = document.createElement('div'); reactEl.className = 'msg-reactions'; bubbleEl.appendChild(reactEl); }
  reactEl.innerHTML = '';
  Object.entries(reactions).forEach(function([emoji, users]) {
    if (!users.length) return;
    const badge = document.createElement('span');
    badge.className = 'reaction-badge' + (users.includes(currentUser.id) ? ' mine' : '');
    badge.innerHTML = emoji + '<span class="reaction-count">' + users.length + '</span>';
    badge.addEventListener('click', () => sendReaction(chatId || activeChatId(), msgId, emoji));
    reactEl.appendChild(badge);
  });
}

function appendMessage(msg) {
  const list = document.getElementById('messages-list');
  const empty = list.querySelector('div[style*="text-align:center"]');
  if (empty) empty.remove();
  const isOut = msg.from === currentUser.id;
  const el = buildMessageEl(msg, isOut, true);
  list.appendChild(el);
}

function scrollToBottom() {
  const c = document.getElementById('messages-container');
  setTimeout(() => { c.scrollTop = c.scrollHeight; }, 60);
}

// ─── SEND MESSAGE ─────────────────────────────────────────
function setupChatInput() {
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  sendBtn.addEventListener('click', sendMessage);
  // Fix: use input event for auto-resize and Enter to send
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', function() {
    // Auto-resize textarea
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    if (!activeChat || !socket) return;
    socket.emit('typing', { chatId: activeChatId(), isTyping: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', { chatId: activeChatId(), isTyping: false }), 1500);
  });
  document.getElementById('search-msgs-btn').addEventListener('click', function() {
    const bar = document.getElementById('msg-search-bar');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) document.getElementById('msg-search-input').focus();
  });
  document.getElementById('close-msg-search').addEventListener('click', function() {
    document.getElementById('msg-search-bar').classList.add('hidden'); clearMsgSearch();
  });
  document.getElementById('msg-search-input').addEventListener('input', function(e) { searchMessages(e.target.value); });
}

function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !activeChat || !socket) return;
  const chatId = activeChatId();
  const to = activeChat.data.id;
  const msgData = { to, text, chatId, type: 'text' };
  if (replyToMsg) { msgData.replyTo = { id: replyToMsg.id, text: replyToMsg.text, fromName: replyToMsg.fromName }; }
  socket.emit('send_message', msgData);
  if (activeChat.type === 'friend') {
    const f = friendsList.find(f => f.id === activeChat.data.id);
    if (f) f.lastMessage = { text: text, timestamp: new Date().toISOString() };
  } else {
    const g = groupsList.find(g => g.id === activeChat.data.id);
    if (g) g.lastMessage = { text: text, timestamp: new Date().toISOString(), senderName: currentUser.name };
  }
  refreshChatList();
  input.value = '';
  input.style.height = 'auto';
  clearReply();
  socket.emit('typing', { chatId: activeChatId(), isTyping: false });
}

function clearReply() {
  replyToMsg = null;
  const el = document.getElementById('reply-banner'); if (el) el.remove();
}

function setReply(msg) {
  replyToMsg = msg;
  var banner = document.getElementById('reply-banner');
  if (!banner) {
    banner = document.createElement('div'); banner.id = 'reply-banner';
    banner.style.cssText = 'padding:8px 16px;background:var(--bg-tertiary);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-secondary)';
    document.getElementById('message-input-area').before(banner);
  }
  banner.innerHTML = '<span>↩ Respondendo a <strong>' + escHtml(msg.fromName) + '</strong>: ' + escHtml(msg.text.substring(0, 60)) + '</span><button onclick="clearReply()" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px">×</button>';
  document.getElementById('msg-input').focus();
}

function searchMessages(query) {
  const list = document.getElementById('messages-list');
  list.querySelectorAll('.msg-text').forEach(el => { el.style.background = ''; el.style.borderRadius = ''; });
  if (!query.trim()) return;
  list.querySelectorAll('.msg-text').forEach(el => {
    if (el.textContent.toLowerCase().includes(query.toLowerCase())) {
      el.style.background = 'rgba(251,191,36,.3)'; el.style.borderRadius = '4px';
    }
  });
}
function clearMsgSearch() { document.getElementById('msg-search-input').value = ''; searchMessages(''); }

// ─── EMOJI PICKER ─────────────────────────────────────────
var EMOJIS = {
  'Frequentes': ['😀','😂','😍','🥰','😎','🤔','😅','😭','🔥','❤️','👍','👏','🎉','✨','💯','🙏','😊','😘','🥺','😏'],
  'Rostos': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🙂','🤗','🤩','🤔','😐','😏','😒','😔','😕','😖','😞','😟','😤','😢','😭','😡'],
  'Gestos': ['👋','🤚','🖐','✋','👌','✌️','🤞','👈','👉','👆','👇','👍','👎','✊','👊','👏','🙌','🙏','💪','💅'],
  'Natureza': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🌸','🌺','🌻','🌹','🌷','🍀','🌿','🍃','🌊','🌈','⭐','🌙','☀️','❄️','🔥'],
  'Comida': ['🍎','🍊','🍋','🍇','🍓','🍒','🍑','🥭','🍍','🥥','🥑','🥦','🍕','🍔','🌮','🌯','🍜','🍝','🍣','🍱','🍩','🎂','🍰','🍫','🍬','☕','🍵','🥤','🍺'],
  'Símbolos': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💞','💓','💗','💖','💘','💝','✅','❎','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪']
};

function setupEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  Object.entries(EMOJIS).forEach(function([cat, emojis]) {
    const title = document.createElement('div'); title.className = 'emoji-category-title'; title.textContent = cat; picker.appendChild(title);
    const grid = document.createElement('div'); grid.className = 'emoji-grid';
    emojis.forEach(function(emoji) {
      const btn = document.createElement('button'); btn.className = 'emoji-btn-item'; btn.textContent = emoji;
      btn.addEventListener('click', function() {
        const input = document.getElementById('msg-input');
        const pos = input.selectionStart;
        input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
        input.setSelectionRange(pos + emoji.length, pos + emoji.length);
        input.focus();
      });
      grid.appendChild(btn);
    });
    picker.appendChild(grid);
  });
  document.getElementById('emoji-toggle-btn').addEventListener('click', function(e) { e.stopPropagation(); picker.classList.toggle('hidden'); });
  document.addEventListener('click', function(e) { if (!picker.contains(e.target) && e.target.id !== 'emoji-toggle-btn') picker.classList.add('hidden'); });
}

// ─── CONTEXT MENU ─────────────────────────────────────────
function setupContextMenu() {
  const menu = document.getElementById('context-menu');
  const reactPicker = document.getElementById('reaction-picker');
  document.addEventListener('click', function(e) {
    if (!menu.contains(e.target)) menu.classList.add('hidden');
    if (!reactPicker.contains(e.target)) reactPicker.classList.add('hidden');
  });
  document.getElementById('ctx-react').addEventListener('click', function(e) {
    e.stopPropagation(); menu.classList.add('hidden');
    const rect = menu._triggerRect;
    reactPicker.style.left = Math.min(rect.x, window.innerWidth - 280) + 'px';
    reactPicker.style.top = (rect.y - 70) + 'px';
    reactPicker.classList.remove('hidden');
  });
  document.getElementById('ctx-reply').addEventListener('click', function() {
    if (contextMenuMsg) setReply(contextMenuMsg); menu.classList.add('hidden');
  });
  document.getElementById('ctx-copy').addEventListener('click', function() {
    if (contextMenuMsg) navigator.clipboard.writeText(contextMenuMsg.text).then(() => showToast('📋 Copiado!'));
    menu.classList.add('hidden');
  });
  document.getElementById('ctx-delete').addEventListener('click', async function() {
    if (!contextMenuMsg) return; menu.classList.add('hidden');
    await fetch('/api/messages/' + activeChatId() + '/' + contextMenuMsg.id, { method: 'DELETE' });
    const el = document.querySelector('[data-msg-id="' + contextMenuMsg.id + '"]');
    if (el) { const grp = el.closest('.message-group'); if (grp) grp.remove(); }
  });
  document.querySelectorAll('.react-opt').forEach(function(opt) {
    opt.addEventListener('click', function(e) {
      e.stopPropagation();
      if (contextMenuMsg) sendReaction(activeChatId(), contextMenuMsg.id, opt.dataset.emoji);
      reactPicker.classList.add('hidden');
    });
  });
}

function showContextMenu(e, msg, isOut) {
  contextMenuMsg = msg;
  const menu = document.getElementById('context-menu');
  document.getElementById('ctx-delete').classList.toggle('hidden', !isOut);
  const x = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
  const y = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
  menu._triggerRect = { x, y };
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 180) + 'px';
  menu.classList.remove('hidden');
  if (e.stopPropagation) e.stopPropagation();
}

function makeLongPress(cb) {
  var timer;
  return function(e) {
    timer = setTimeout(function() { cb(e); }, 600);
    var cancel = function() { clearTimeout(timer); };
    document.addEventListener('touchend', cancel, { once: true });
    document.addEventListener('touchmove', cancel, { once: true });
  };
}

async function sendReaction(chatId, msgId, emoji) {
  try {
    await fetch('/api/messages/' + chatId + '/' + msgId + '/react', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji })
    });
  } catch {}
}

// ─── ADD FRIEND MODAL ─────────────────────────────────────
function setupAddFriendModal() {
  document.getElementById('add-friend-btn').addEventListener('click', function() {
    document.getElementById('my-friend-code').textContent = currentUser.friendCode;
    document.getElementById('add-friend-modal').classList.remove('hidden');
  });
  document.getElementById('copy-code-btn').addEventListener('click', function() {
    navigator.clipboard.writeText(currentUser.friendCode).then(() => showToast('✅ Código copiado!'));
  });
  const input = document.getElementById('friend-code-input');
  input.addEventListener('input', function() {
    var val = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (val.length > 4) val = val.substring(0, 4) + '-' + val.substring(4, 8);
    input.value = val;
  });
  document.getElementById('send-friend-req-btn').addEventListener('click', async function() {
    const code = input.value.trim();
    const msgEl = document.getElementById('add-friend-msg');
    msgEl.classList.add('hidden');
    if (!code) return showError(msgEl, 'Digite um código');
    const btn = document.getElementById('send-friend-req-btn');
    btn.textContent = 'Enviando...'; btn.disabled = true;
    try {
      const res = await fetch('/api/friends/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friendCode: code }) });
      const data = await res.json();
      if (!res.ok) return showError(msgEl, data.error);
      msgEl.className = 'auth-success'; msgEl.textContent = '✅ Solicitação enviada!'; msgEl.classList.remove('hidden');
      input.value = '';
    } catch { showError(msgEl, 'Erro ao enviar'); }
    finally { btn.textContent = 'Enviar Solicitação'; btn.disabled = false; }
  });
}

// ─── REQUESTS MODAL ───────────────────────────────────────
function setupRequestsModal() {
  document.getElementById('requests-btn').addEventListener('click', function() {
    document.getElementById('requests-modal').classList.remove('hidden');
    loadFriendRequests();
  });
}

function renderRequestsList(requests) {
  const list = document.getElementById('requests-list'); if (!list) return;
  if (requests.length === 0) { list.innerHTML = '<div class="empty-state-sm">Nenhuma solicitação pendente</div>'; return; }
  list.innerHTML = '';
  requests.forEach(function(req) {
    const div = document.createElement('div'); div.className = 'request-item';
    div.innerHTML = '<img src="' + (req.fromAvatar || DEFAULT_AVATAR(req.fromName)) + '" class="avatar avatar-sm" onerror="this.src=\'' + DEFAULT_AVATAR(req.fromName) + '\'" /><div class="request-info"><strong>' + escHtml(req.fromName) + '</strong><span>' + req.fromCode + '</span></div><div class="request-actions"><button class="btn-accept">✓ Aceitar</button><button class="btn-reject">✕ Recusar</button></div>';
    div.querySelector('.btn-accept').addEventListener('click', function() { acceptRequest(req.id); });
    div.querySelector('.btn-reject').addEventListener('click', function() { rejectRequest(req.id); });
    list.appendChild(div);
  });
}

async function acceptRequest(requestId) {
  await fetch('/api/friends/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
  showToast('✅ Amigo adicionado!'); loadFriends(); loadFriendRequests();
}
async function rejectRequest(requestId) {
  await fetch('/api/friends/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
  loadFriendRequests();
}

// ─── NEW GROUP MODAL ──────────────────────────────────────
function setupNewGroupModal() {
  document.getElementById('new-group-btn').addEventListener('click', function() {
    renderFriendsChecklist();
    document.getElementById('new-group-modal').classList.remove('hidden');
  });
  document.getElementById('create-group-btn').addEventListener('click', async function() {
    const name = document.getElementById('group-name-input').value.trim();
    const desc = document.getElementById('group-desc-input').value.trim();
    const msgEl = document.getElementById('group-msg'); msgEl.classList.add('hidden');
    if (!name) return showError(msgEl, 'Digite um nome para o grupo');
    const checked = Array.from(document.querySelectorAll('.friend-check-item.selected')).map(el => el.dataset.id);
    const btn = document.getElementById('create-group-btn');
    btn.textContent = 'Criando...'; btn.disabled = true;
    try {
      const res = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: desc, memberIds: checked }) });
      const data = await res.json();
      if (!res.ok) return showError(msgEl, data.error || 'Erro');
      showToast('✅ Grupo criado!');
      closeModal('new-group-modal');
      document.getElementById('group-name-input').value = '';
      document.getElementById('group-desc-input').value = '';
      loadGroups();
      socket.emit('join_group', { groupId: data.group.id });
      openChat('group', data.group);
    } catch { showError(msgEl, 'Erro ao criar grupo'); }
    finally { btn.textContent = 'Criar Grupo'; btn.disabled = false; }
  });
}

function renderFriendsChecklist() {
  const container = document.getElementById('friends-to-add'); container.innerHTML = '';
  if (friendsList.length === 0) { container.innerHTML = '<div class="empty-state-sm">Adicione amigos primeiro</div>'; return; }
  friendsList.forEach(function(f) {
    const div = document.createElement('div'); div.className = 'friend-check-item'; div.dataset.id = f.id;
    div.innerHTML = '<img src="' + (f.avatar || DEFAULT_AVATAR(f.name)) + '" class="avatar avatar-sm" onerror="this.src=\'' + DEFAULT_AVATAR(f.name) + '\'" /><span class="friend-check-name">' + escHtml(getDisplayName(f)) + '</span>';
    div.addEventListener('click', function() { div.classList.toggle('selected'); });
    container.appendChild(div);
  });
}

// ─── PROFILE MODAL ────────────────────────────────────────
function setupProfileModal() {
  document.getElementById('open-profile').addEventListener('click', openProfileModal);
  document.getElementById('change-avatar-btn').addEventListener('click', function() { document.getElementById('avatar-file-input').click(); });
  document.getElementById('avatar-file-input').addEventListener('change', async function(e) {
    const file = e.target.files[0]; if (!file) return;
    const formData = new FormData(); formData.append('avatar', file);
    try {
      const res = await fetch('/api/avatar', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.avatar) {
        currentUser.avatar = data.avatar;
        document.getElementById('profile-avatar-img').src = data.avatar;
        document.getElementById('my-avatar').src = data.avatar;
        showToast('✅ Foto atualizada!');
      }
    } catch { showToast('Erro ao enviar foto'); }
  });
  document.getElementById('save-profile-btn').addEventListener('click', async function() {
    const name = document.getElementById('profile-name-input').value.trim();
    const bio = document.getElementById('profile-bio-input').value.trim();
    const status = document.getElementById('profile-status-select').value;
    const msgEl = document.getElementById('profile-msg');
    try {
      const res = await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, bio, status }) });
      const data = await res.json();
      if (res.ok) {
        currentUser = Object.assign({}, currentUser, data.user);
        renderSidebarHeader();
        msgEl.textContent = '✅ Perfil atualizado!'; msgEl.className = 'auth-success'; msgEl.classList.remove('hidden');
        setTimeout(function() { msgEl.classList.add('hidden'); }, 2500);
      }
    } catch { showToast('Erro ao salvar'); }
  });
  document.getElementById('copy-profile-code').addEventListener('click', function() {
    navigator.clipboard.writeText(currentUser.friendCode).then(() => showToast('✅ Código copiado!'));
  });
  document.getElementById('logout-btn').addEventListener('click', async function() {
    await fetch('/api/logout', { method: 'POST' }); location.reload();
  });
}

function openProfileModal() {
  document.getElementById('profile-avatar-img').src = currentUser.avatar || DEFAULT_AVATAR(currentUser.name);
  document.getElementById('profile-friend-code').textContent = currentUser.friendCode;
  document.getElementById('profile-name-input').value = currentUser.name;
  document.getElementById('profile-bio-input').value = currentUser.bio || '';
  document.getElementById('profile-status-select').value = currentUser.status || 'online';
  document.getElementById('profile-msg').classList.add('hidden');
  document.getElementById('profile-modal').classList.remove('hidden');
}

// ─── CONTACT MODAL ────────────────────────────────────────
function openContactModal(data) {
  const avatar = data.avatar || DEFAULT_AVATAR(data.name);
  const contactAvatar = document.getElementById('contact-avatar');
  contactAvatar.src = avatar;
  contactAvatar.onerror = function() { contactAvatar.src = DEFAULT_AVATAR(data.name); };
  const customName = (currentUser.customNames || {})[data.id];
  document.getElementById('contact-display-name').textContent = customName || data.name;
  const realRow = document.getElementById('contact-real-name-row');
  if (customName && customName !== data.name) {
    document.getElementById('contact-real-name-label').textContent = '(nome original: ' + data.name + ')';
    realRow.classList.remove('hidden');
  } else { realRow.classList.add('hidden'); }
  document.getElementById('contact-bio').textContent = data.bio || 'Sem biografia';
  document.getElementById('contact-code').textContent = data.friendCode || '---';
  document.getElementById('contact-custom-name-input').value = customName || '';
  const status = data.status || 'offline';
  document.getElementById('contact-status-dot').className = 'status-dot ' + status;
  document.getElementById('contact-status-text').textContent = statusLabels[status] || status;
  document.getElementById('msg-contact-btn').onclick = function() { closeModal('contact-modal'); openChat('friend', data); };
  // Save custom name
  document.getElementById('save-contact-name-btn').onclick = async function() {
    const newName = document.getElementById('contact-custom-name-input').value.trim();
    const res = await fetch('/api/contacts/' + data.id + '/name', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customName: newName }) });
    const result = await res.json();
    if (result.success) {
      currentUser.customNames = result.customNames;
      // Update in friends list
      const f = friendsList.find(f => f.id === data.id);
      if (f) { f.displayName = newName || f.name; }
      document.getElementById('contact-display-name').textContent = newName || data.name;
      if (newName && newName !== data.name) {
        document.getElementById('contact-real-name-label').textContent = '(nome original: ' + data.name + ')';
        realRow.classList.remove('hidden');
      } else { realRow.classList.add('hidden'); }
      if (activeChat && activeChat.type === 'friend' && activeChat.data.id === data.id) {
        document.getElementById('chat-name').textContent = newName || data.name;
      }
      refreshChatList();
      showToast('✅ Nome salvo!');
    }
  };
  const rmBtn = document.getElementById('remove-friend-btn');
  rmBtn.classList.remove('hidden');
  rmBtn.onclick = async function() {
    if (!confirm('Remover ' + (customName || data.name) + ' dos amigos?')) return;
    await fetch('/api/friends/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friendId: data.id }) });
    closeModal('contact-modal');
    activeChat = null;
    document.getElementById('chat-header').classList.add('hidden');
    document.getElementById('messages-container').classList.add('hidden');
    document.getElementById('message-input-area').classList.add('hidden');
    document.getElementById('no-chat-selected').style.display = '';
    document.getElementById('app').classList.remove('chat-open');
    loadFriends(); showToast('Amigo removido');
  };
  document.getElementById('contact-modal').classList.remove('hidden');
}

// ─── GROUP MODAL ──────────────────────────────────────────
async function openGroupModal(groupData) {
  // Refresh group data from server
  try {
    const res = await fetch('/api/groups/' + groupData.id);
    if (res.ok) { const d = await res.json(); groupData = d.group; }
  } catch {}

  const isAdmin = (groupData.admins || []).includes(currentUser.id);
  const isOwner = groupData.createdBy === currentUser.id;
  const canEdit = isAdmin || groupData.allowAllEdit;
  const members = groupData.memberDetails || [];
  const memberCount = (groupData.members || []).length;

  document.getElementById('group-modal-title').textContent = 'Informações do Grupo';
  const body = document.getElementById('group-modal-body');
  body.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'group-info-header';
  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'group-info-avatar-wrap';
  const avatarImg = document.createElement('img');
  avatarImg.className = 'avatar avatar-xl';
  avatarImg.src = groupData.avatar || DEFAULT_AVATAR(groupData.name);
  avatarImg.onerror = () => { avatarImg.src = DEFAULT_AVATAR(groupData.name); };
  avatarWrap.appendChild(avatarImg);
  if (canEdit) {
    const editAv = document.createElement('button');
    editAv.className = 'avatar-edit-btn';
    editAv.title = 'Mudar foto do grupo';
    editAv.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    editAv.addEventListener('click', function() {
      const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*';
      fi.addEventListener('change', async function(e) {
        const file = e.target.files[0]; if (!file) return;
        const formData = new FormData(); formData.append('avatar', file);
        const res = await fetch('/api/groups/' + groupData.id + '/avatar', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.avatar) {
          avatarImg.src = data.avatar;
          groupData.avatar = data.avatar;
          // update in list
          const g = groupsList.find(x => x.id === groupData.id);
          if (g) g.avatar = data.avatar;
          if (activeChat && activeChat.type === 'group' && activeChat.data.id === groupData.id) {
            document.getElementById('chat-avatar').src = data.avatar;
          }
          refreshChatList();
          showToast('✅ Foto do grupo atualizada!');
        }
      });
      fi.click();
    });
    avatarWrap.appendChild(editAv);
  }
  header.appendChild(avatarWrap);
  const nameEl = document.createElement('div');
  nameEl.className = 'group-info-name';
  nameEl.textContent = groupData.name;
  header.appendChild(nameEl);
  if (groupData.description) {
    const descEl = document.createElement('div');
    descEl.className = 'group-info-desc';
    descEl.textContent = groupData.description;
    header.appendChild(descEl);
  }
  const metaRow = document.createElement('div');
  metaRow.className = 'group-info-meta';
  metaRow.innerHTML = '<span class="group-info-badge">👥 ' + memberCount + ' membros</span>';
  const createdDate = new Date(groupData.createdAt).toLocaleDateString('pt-BR');
  metaRow.innerHTML += '<span>Criado em ' + createdDate + '</span>';
  header.appendChild(metaRow);
  body.appendChild(header);

  // Edit section (for admins / allowAllEdit)
  if (canEdit) {
    const editSection = document.createElement('div');
    editSection.className = 'group-edit-section';
    editSection.innerHTML = '<div class="section-title">Editar Grupo</div>';
    const nameInput = document.createElement('input');
    nameInput.className = 'group-edit-input'; nameInput.placeholder = 'Nome do grupo'; nameInput.value = groupData.name;
    const descInput = document.createElement('input');
    descInput.className = 'group-edit-input'; descInput.placeholder = 'Descrição...'; descInput.value = groupData.description || '';
    editSection.appendChild(nameInput);
    editSection.appendChild(descInput);
    if (isAdmin) {
      const settingsRow = document.createElement('div');
      settingsRow.className = 'group-settings-row';
      settingsRow.innerHTML = '<span class="group-settings-label">Todos podem editar</span>';
      const toggle = document.createElement('label');
      toggle.className = 'toggle-switch';
      toggle.innerHTML = '<input type="checkbox" id="allow-all-edit-toggle" ' + (groupData.allowAllEdit ? 'checked' : '') + ' /><span class="toggle-slider"></span>';
      settingsRow.appendChild(toggle);
      editSection.appendChild(settingsRow);
    }
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary btn-sm';
    saveBtn.textContent = 'Salvar alterações';
    saveBtn.addEventListener('click', async function() {
      const payload = { name: nameInput.value.trim(), description: descInput.value.trim() };
      if (isAdmin) {
        const toggle = document.getElementById('allow-all-edit-toggle');
        if (toggle) payload.allowAllEdit = toggle.checked;
      }
      if (!payload.name) return showToast('Nome obrigatório');
      const res = await fetch('/api/groups/' + groupData.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (res.ok) {
        groupData = data.group;
        nameEl.textContent = groupData.name;
        const g = groupsList.find(x => x.id === groupData.id);
        if (g) { g.name = groupData.name; g.description = groupData.description; g.allowAllEdit = groupData.allowAllEdit; }
        if (activeChat && activeChat.type === 'group' && activeChat.data.id === groupData.id) {
          activeChat.data = { ...activeChat.data, ...groupData };
          document.getElementById('chat-name').textContent = groupData.name;
        }
        refreshChatList();
        showToast('✅ Grupo atualizado!');
      } else { showToast(data.error || 'Erro'); }
    });
    editSection.appendChild(saveBtn);
    body.appendChild(editSection);
  }


  // Share / invite section
  const shareSection = document.createElement('div');
  shareSection.className = 'group-share-section';
  const inviteCode = groupData.inviteCode || groupData.id;
  const inviteLink = window.location.origin + '/?join=' + encodeURIComponent(inviteCode);
  shareSection.innerHTML = '<div class="section-title">Convidar amigos</div><p class="group-share-desc">Compartilhe este link ou código para seus amigos entrarem diretamente no grupo.</p><div class="group-share-row"><input class="group-share-input" id="group-invite-link" readonly value="' + escHtml(inviteLink) + '" /></div><div class="group-share-row"><input class="group-share-input" id="group-invite-code" readonly value="' + escHtml(inviteCode) + '" /></div><div class="group-share-actions"><button class="btn-secondary btn-sm" id="copy-group-link-btn">Copiar link</button><button class="btn-secondary btn-sm" id="copy-group-code-btn">Copiar código</button></div>';
  body.appendChild(shareSection);
  setTimeout(function() {
    const linkBtn = document.getElementById('copy-group-link-btn');
    const codeBtn = document.getElementById('copy-group-code-btn');
    if (linkBtn) linkBtn.addEventListener('click', function() { navigator.clipboard.writeText(inviteLink).then(() => showToast('Link do grupo copiado!')); });
    if (codeBtn) codeBtn.addEventListener('click', function() { navigator.clipboard.writeText(inviteCode).then(() => showToast('Código do grupo copiado!')); });
  }, 0);

  // Members section
  const membersSection = document.createElement('div');
  membersSection.className = 'members-section';
  const membersHeader = document.createElement('div');
  membersHeader.className = 'members-section-header';
  membersHeader.innerHTML = '<span class="members-count">Membros (' + memberCount + ')</span>';
  membersSection.appendChild(membersHeader);
  const membersList = document.createElement('div');
  membersList.className = 'members-list';

  members.forEach(function(member) {
    const isOwnerMember = member.id === groupData.createdBy;
    const isAdminMember = (groupData.admins || []).includes(member.id);
    const isSelf = member.id === currentUser.id;
    const roleLabel = isOwnerMember ? 'owner' : (isAdminMember ? 'admin' : 'member');
    const roleText = isOwnerMember ? '👑 Dono' : (isAdminMember ? '⚡ Admin' : 'Membro');
    const item = document.createElement('div');
    item.className = 'member-item';
    item.innerHTML = '<img src="' + (member.avatar || DEFAULT_AVATAR(member.name)) + '" class="avatar avatar-sm" onerror="this.src=\'' + DEFAULT_AVATAR(member.name) + '\'" /><div class="member-item-info"><div class="member-item-name">' + escHtml(member.name) + (isSelf ? ' <span style="font-size:10px;color:var(--text-muted)">(você)</span>' : '') + '</div><div class="member-item-sub"><span class="role-badge ' + roleLabel + '">' + roleText + '</span></div></div>';
    if (!isSelf) {
      item.style.cursor = 'pointer';
      item.addEventListener('click', function(e) {
        showMemberPopup(e, member, groupData, isAdmin, isOwner);
      });
    }
    membersList.appendChild(item);
  });

  membersSection.appendChild(membersList);
  body.appendChild(membersSection);

  // Leave group button
  if (!isOwner) {
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'btn-danger';
    leaveBtn.textContent = '🚪 Sair do Grupo';
    leaveBtn.addEventListener('click', async function() {
      if (!confirm('Tem certeza que deseja sair do grupo?')) return;
      const res = await fetch('/api/groups/' + groupData.id + '/leave', { method: 'POST' });
      if (res.ok) {
        closeModal('group-modal');
        groupsList = groupsList.filter(g => g.id !== groupData.id);
        if (activeChat && activeChat.type === 'group' && activeChat.data.id === groupData.id) {
          activeChat = null;
          document.getElementById('chat-header').classList.add('hidden');
          document.getElementById('messages-container').classList.add('hidden');
          document.getElementById('message-input-area').classList.add('hidden');
          document.getElementById('no-chat-selected').style.display = '';
          document.getElementById('app').classList.remove('chat-open');
        }
        refreshChatList();
        showToast('Você saiu do grupo');
      }
    });
    body.appendChild(leaveBtn);
  }

  document.getElementById('group-modal').classList.remove('hidden');
}

// ─── MEMBER POPUP ─────────────────────────────────────────
function setupMemberPopupClose() {
  document.addEventListener('click', function(e) {
    const popup = document.getElementById('member-popup');
    if (!popup.classList.contains('hidden') && !popup.contains(e.target)) {
      popup.classList.add('hidden');
    }
  });
}

function showMemberPopup(e, member, groupData, callerIsAdmin, callerIsOwner) {
  e.stopPropagation();
  const popup = document.getElementById('member-popup');
  const avatarImg = document.getElementById('member-popup-avatar');
  avatarImg.src = member.avatar || DEFAULT_AVATAR(member.name);
  avatarImg.onerror = () => { avatarImg.src = DEFAULT_AVATAR(member.name); };
  document.getElementById('member-popup-name').textContent = member.name;
  const isAdminMember = (groupData.admins || []).includes(member.id);
  const isOwnerMember = member.id === groupData.createdBy;
  document.getElementById('member-popup-role').textContent = isOwnerMember ? '👑 Dono' : (isAdminMember ? '⚡ Admin' : 'Membro');
  const actionsEl = document.getElementById('member-popup-actions');
  actionsEl.innerHTML = '';

  // Message privately
  const msgBtn = document.createElement('button');
  msgBtn.className = 'member-popup-btn';
  msgBtn.textContent = '💬 Mensagem Privada';
  msgBtn.addEventListener('click', function() {
    popup.classList.add('hidden');
    // Check if already friend
    const isFriend = (currentUser.friends || []).includes(member.id);
    if (!isFriend) {
      showToast('Adicione ' + member.name + ' como amigo primeiro');
      return;
    }
    const friendData = friendsList.find(f => f.id === member.id) || member;
    closeModal('group-modal');
    openChat('friend', friendData);
  });
  actionsEl.appendChild(msgBtn);

  // Send friend request
  const isFriend = (currentUser.friends || []).includes(member.id);
  if (!isFriend) {
    const frBtn = document.createElement('button');
    frBtn.className = 'member-popup-btn';
    frBtn.textContent = '👥 Enviar Solicitação de Amizade';
    frBtn.addEventListener('click', async function() {
      popup.classList.add('hidden');
      try {
        const res = await fetch('/api/friends/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: member.id }) });
        const data = await res.json();
        if (res.ok) showToast('✅ Solicitação enviada para ' + member.name + '!');
        else showToast(data.error || 'Erro ao enviar');
      } catch { showToast('Erro ao enviar solicitação'); }
    });
    actionsEl.appendChild(frBtn);
  }

  // Admin management (only for admins)
  if (callerIsAdmin && !isOwnerMember) {
    if (!isAdminMember) {
      const makeAdminBtn = document.createElement('button');
      makeAdminBtn.className = 'member-popup-btn';
      makeAdminBtn.textContent = '⚡ Tornar Admin';
      makeAdminBtn.addEventListener('click', async function() {
        popup.classList.add('hidden');
        const res = await fetch('/api/groups/' + groupData.id + '/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: member.id, action: 'add' }) });
        if (res.ok) { showToast('✅ ' + member.name + ' agora é admin!'); closeModal('group-modal'); openGroupModal(groupData); }
        else { const d = await res.json(); showToast(d.error || 'Erro'); }
      });
      actionsEl.appendChild(makeAdminBtn);
    } else {
      const removeAdminBtn = document.createElement('button');
      removeAdminBtn.className = 'member-popup-btn';
      removeAdminBtn.textContent = '↩ Remover Admin';
      removeAdminBtn.addEventListener('click', async function() {
        popup.classList.add('hidden');
        const res = await fetch('/api/groups/' + groupData.id + '/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: member.id, action: 'remove' }) });
        if (res.ok) { showToast('Admin removido'); closeModal('group-modal'); openGroupModal(groupData); }
        else { const d = await res.json(); showToast(d.error || 'Erro'); }
      });
      actionsEl.appendChild(removeAdminBtn);
    }
  }

  // Position popup
  const rect = e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : { left: e.clientX, top: e.clientY, width: 0 };
  const x = rect.left;
  const y = rect.top + (rect.height || 0);
  popup.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  popup.style.top = Math.min(y, window.innerHeight - 200) + 'px';
  popup.classList.remove('hidden');
}

// ─── BACK BUTTON ──────────────────────────────────────────
function setupBackBtn() {
  document.getElementById('back-btn').addEventListener('click', function() {
    document.getElementById('app').classList.remove('chat-open');
    activeChat = null;
  });
}

// ─── THEME TOGGLE ─────────────────────────────────────────
function setupThemeToggle() {
  document.getElementById('theme-toggle-btn').addEventListener('click', function() {
    const isLight = document.documentElement.dataset.theme === 'light';
    document.documentElement.dataset.theme = isLight ? '' : 'light';
    document.getElementById('theme-icon-moon').classList.toggle('hidden', !isLight);
    document.getElementById('theme-icon-sun').classList.toggle('hidden', isLight);
    localStorage.setItem('nexchat-theme', isLight ? '' : 'light');
  });
}
function loadTheme() {
  const theme = localStorage.getItem('nexchat-theme') || '';
  document.documentElement.dataset.theme = theme;
  if (theme === 'light') {
    document.getElementById('theme-icon-moon').classList.add('hidden');
    document.getElementById('theme-icon-sun').classList.remove('hidden');
  }
}




// ─── OTP REDEFINIÇÃO DE SENHA ────────────────────────────
function setupOTPResetModal() {
  const modal = document.getElementById('otp-reset-modal');
  if (!modal) return;
  
  const closeBtn = document.getElementById('otp-reset-modal-close');
  const cancelBtn = document.getElementById('otp-cancel-btn');
  const backBtn = document.getElementById('otp-back-btn');
  const requestBtn = document.getElementById('otp-request-btn');
  const verifyBtn = document.getElementById('otp-verify-btn');
  
  const emailInput = document.getElementById('otp-email-input');
  const codeInput = document.getElementById('otp-code-input');
  const passwordInput = document.getElementById('otp-password-input');
  const passwordConfirmInput = document.getElementById('otp-password-confirm-input');
  
  const errEl = document.getElementById('otp-error');
  const errEl2 = document.getElementById('otp-error-step2');
  
  const step1 = document.getElementById('otp-reset-step1');
  const step2 = document.getElementById('otp-reset-step2');
  
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.querySelector('.modal-backdrop').addEventListener('click', () => modal.classList.add('hidden'));
  
  backBtn.addEventListener('click', () => {
    step1.classList.add('active');
    step2.classList.remove('active');
    step1.classList.remove('hidden');
    step2.classList.add('hidden');
    errEl2.classList.add('hidden');
    emailInput.disabled = false;
    requestBtn.disabled = false;
  });
  
  requestBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    errEl.classList.add('hidden');
    
    if (!email || !email.includes('@')) return showError(errEl, 'Email inválido');
    
    requestBtn.textContent = 'Enviando...';
    requestBtn.disabled = true;
    
    try {
      const res = await fetch('/api/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      
      if (res.ok) {
        showToast('Código enviado! Verifique seu email.');
        step1.classList.remove('active');
        step2.classList.remove('hidden');
        step1.classList.add('hidden');
        step2.classList.add('active');
        emailInput.disabled = true;
      } else {
        showError(errEl, data.error || 'Erro ao enviar código');
      }
    } catch {
      showError(errEl, 'Erro de conexão');
    } finally {
      requestBtn.textContent = 'Enviar Código';
      requestBtn.disabled = false;
    }
  });
  
  verifyBtn.addEventListener('click', async () => {
    const otp = codeInput.value.trim();
    const password = passwordInput.value;
    const passwordConfirm = passwordConfirmInput.value;
    errEl2.classList.add('hidden');
    
    if (!otp || otp.length !== 6) return showError(errEl2, 'Código deve ter 6 dígitos');
    if (!password || !passwordConfirm) return showError(errEl2, 'Preencha as senhas');
    if (password.length < 6) return showError(errEl2, 'Senha mínima de 6 caracteres');
    if (password !== passwordConfirm) return showError(errEl2, 'As senhas não coincidem');
    
    verifyBtn.textContent = 'Verificando...';
    verifyBtn.disabled = true;
    
    try {
      const res = await fetch('/api/verify-otp-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp, newPassword: password })
      });
      const data = await res.json();
      
      if (res.ok) {
        showToast('Senha redefinida com sucesso! Faça login.');
        setTimeout(() => { window.location.href = '/'; }, 2000);
      } else {
        showError(errEl2, data.error || 'Erro ao redefinir senha');
      }
    } catch {
      showError(errEl2, 'Erro de conexão');
    } finally {
      verifyBtn.textContent = 'Redefinir Senha';
      verifyBtn.disabled = false;
    }
  });
}

// ─── RECOVERY EMAILS MANAGEMENT ────────────────────────────
async function loadRecoveryEmails() {
  try {
    const res = await fetch('/api/user/recovery-emails');
    if (!res.ok) return;
    const data = await res.json();
    return data;
  } catch { console.error('Erro ao carregar emails de recuperação'); return null; }
}

function setupRecoveryEmailsModal() {
  const modal = document.getElementById('recovery-emails-modal');
  if (!modal) return;
  
  const closeBtn = document.getElementById('recovery-emails-modal-close');
  const addBtn = document.getElementById('add-recovery-email-btn');
  const emailInput = document.getElementById('new-recovery-email');
  const errEl = document.getElementById('recovery-emails-error');
  
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.querySelector('.modal-backdrop').addEventListener('click', () => modal.classList.add('hidden'));
  
  // Carregar emails ao abrir modal
  modal.addEventListener('click', async (e) => {
    if (e.target === modal.querySelector('.modal-backdrop')) return;
    if (modal.classList.contains('hidden')) return;
    
    const data = await loadRecoveryEmails();
    if (!data) return;
    
    document.getElementById('primary-email-display').textContent = data.primaryEmail;
    
    const list = document.getElementById('recovery-emails-list');
    list.innerHTML = '';
    
    if (data.recoveryEmails.length === 0) {
      list.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">Nenhum email de recuperação adicionado</p>';
    } else {
      data.recoveryEmails.forEach(email => {
        const badge = document.createElement('div');
        badge.className = 'email-badge secondary';
        badge.innerHTML = `
          <span>${email}</span>
          <button class="remove-recovery-email-btn" data-email="${email}">✕</button>
        `;
        list.appendChild(badge);
      });
      
      document.querySelectorAll('.remove-recovery-email-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const emailToRemove = btn.dataset.email;
          errEl.classList.add('hidden');
          
          try {
            const res = await fetch('/api/user/recovery-emails/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ recoveryEmail: emailToRemove })
            });
            const result = await res.json();
            if (!res.ok) return showError(errEl, result.error);
            showToast('Email de recuperação removido');
            await loadRecoveryEmails();
            setupRecoveryEmailsModal();
          } catch { showError(errEl, 'Erro ao remover email'); }
        });
      });
    }
  });
  
  addBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    errEl.classList.add('hidden');
    
    if (!email || !email.includes('@')) return showError(errEl, 'Email inválido');
    
    addBtn.textContent = 'Adicionando...';
    addBtn.disabled = true;
    
    try {
      const res = await fetch('/api/user/recovery-emails/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recoveryEmail: email })
      });
      const data = await res.json();
      if (!res.ok) return showError(errEl, data.error);
      
      showToast('Email de recuperação adicionado!');
      emailInput.value = '';
      setupRecoveryEmailsModal();
    } catch { showError(errEl, 'Erro ao adicionar email'); }
    finally { addBtn.textContent = 'Adicionar'; addBtn.disabled = false; }
  });
}

function updateRecoveryMethodModal() {
  const modal = document.getElementById('recovery-method-modal');
  if (!modal) return;
  
  const methodBtns = document.querySelectorAll('.recovery-method-btn');
  methodBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const method = btn.dataset.method;
      
      if (method === 'otp') {
        modal.classList.add('hidden');
        document.getElementById('otp-reset-modal').classList.remove('hidden');
        return;
      }
      
      if (method === 'email') {
        // Carregar emails disponíveis
        const data = await loadRecoveryEmails();
        if (!data) {
          modal.classList.add('hidden');
          document.getElementById('forgot-form').classList.add('active');
          return;
        }
        
        // Se tem recovery emails, mostrar opção de escolher
        if (data.recoveryEmails.length > 0) {
          document.querySelectorAll('.recovery-section').forEach(s => s.classList.add('hidden'));
          const section = document.createElement('div');
          section.className = 'recovery-section active';
          section.id = 'recovery-email-select-section';
          section.innerHTML = `
            <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">Escolha para qual email deseja receber o link:</p>
            <div class="email-options">
              <button class="email-option-btn" data-target-email="${data.primaryEmail}">
                <div style="font-weight: 600; color: var(--text-primary);">${data.primaryEmail}</div>
                <div style="font-size: 11px; color: var(--text-muted);">Email Principal</div>
              </button>
              ${data.recoveryEmails.map(email => `
                <button class="email-option-btn" data-target-email="${email}">
                  <div style="font-weight: 600; color: var(--text-primary);">${email}</div>
                  <div style="font-size: 11px; color: var(--text-muted);">Email de Recuperação</div>
                </button>
              `).join('')}
            </div>
            <button class="btn-secondary" id="email-select-back-btn" style="margin-top: 12px;">Voltar</button>
          `;
          
          const parent = document.querySelector('.modal-body');
          const oldSection = document.getElementById('recovery-email-select-section');
          if (oldSection) oldSection.remove();
          parent.appendChild(section);
          
          document.querySelectorAll('.email-option-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const targetEmail = btn.dataset.targetEmail;
              localStorage.setItem('targetRecoveryEmail', targetEmail);
              modal.classList.add('hidden');
              document.getElementById('forgot-form').classList.add('active');
              document.getElementById('login-form').classList.remove('active');
              document.getElementById('register-form').classList.remove('active');
            });
          });
          
          document.getElementById('email-select-back-btn').addEventListener('click', () => {
            modal.classList.remove('hidden');
            section.remove();
          });
        } else {
          modal.classList.add('hidden');
          document.getElementById('forgot-form').classList.add('active');
          document.getElementById('login-form').classList.remove('active');
          document.getElementById('register-form').classList.remove('active');
        }
      }
    });
  });
}

// ─── SECURITY & 2FA ────────────────────────────────────────
var securityQuestions = [];

async function loadSecurityQuestions() {
  try {
    const res = await fetch('/api/user/security/questions');
    const data = await res.json();
    securityQuestions = data.questions || [];
  } catch { console.error('Erro ao carregar perguntas'); }
}

function setupSecurityModal() {
  const modal = document.getElementById('security-modal');
  const closeBtn = document.getElementById('security-modal-close');
  const tabs = document.querySelectorAll('.security-tab');
  const methods = document.querySelectorAll('.security-method');
  
  if (!modal) return;
  
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.querySelector('.modal-backdrop').addEventListener('click', () => modal.classList.add('hidden'));
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      methods.forEach(m => m.classList.remove('active'));
      tab.classList.add('active');
      const method = tab.dataset.method;
      document.getElementById(method + '-setup').classList.add('active');
    });
  });
  
  // Carregar perguntas de segurança
  const select = document.getElementById('security-question-select');
  if (select) {
    loadSecurityQuestions().then(() => {
      securityQuestions.forEach((q, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = q;
        select.appendChild(opt);
      });
    });
  }
  
  // Setup Security Question
  const setupSQBtn = document.getElementById('setup-security-question-btn');
  if (setupSQBtn) {
    setupSQBtn.addEventListener('click', async () => {
      const questionIndex = parseInt(document.getElementById('security-question-select').value);
      const answer = document.getElementById('security-answer-input').value.trim();
      const errEl = document.getElementById('security-error');
      errEl.classList.add('hidden');
      
      if (isNaN(questionIndex) || !answer) return showError(errEl, 'Preencha todos os campos');
      
      setupSQBtn.textContent = 'Configurando...';
      setupSQBtn.disabled = true;
      
      try {
        const res = await fetch('/api/user/security/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionIndex, answer, method: 'security-question' })
        });
        const data = await res.json();
        if (!res.ok) return showError(errEl, data.error);
        showToast('Pergunta de segurança configurada!');
        modal.classList.add('hidden');
      } catch { showError(errEl, 'Erro de conexão'); }
      finally { setupSQBtn.textContent = 'Configurar pergunta'; setupSQBtn.disabled = false; }
    });
  }
  
  // Setup 2FA
  const setup2FABtn = document.getElementById('setup-2fa-btn');
  if (setup2FABtn) {
    setup2FABtn.addEventListener('click', async () => {
      const errEl = document.getElementById('2fa-error');
      errEl.classList.add('hidden');
      
      setup2FABtn.textContent = 'Ativando...';
      setup2FABtn.disabled = true;
      
      try {
        const res = await fetch('/api/user/security/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionIndex: 0, answer: '', method: '2fa' })
        });
        const data = await res.json();
        if (!res.ok) return showError(errEl, data.error);
        showToast('Autenticação 2FA ativada! Verifique seu email.');
        modal.classList.add('hidden');
      } catch { showError(errEl, 'Erro de conexão'); }
      finally { setup2FABtn.textContent = 'Ativar 2FA'; setup2FABtn.disabled = false; }
    });
  }
}

function setupRecoveryMethodModal() {
  const modal = document.getElementById('recovery-method-modal');
  if (!modal) return;
  
  const closeBtn = document.getElementById('recovery-method-modal-close');
  const methodBtns = document.querySelectorAll('.recovery-method-btn');
  
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.querySelector('.modal-backdrop').addEventListener('click', () => modal.classList.add('hidden'));
  
  methodBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.method;
      document.querySelectorAll('.recovery-section').forEach(s => s.classList.add('hidden'));
      if (method === 'email') {
        modal.classList.add('hidden');
        document.getElementById('forgot-form').classList.add('active');
        document.getElementById('login-form').classList.remove('active');
        document.getElementById('register-form').classList.remove('active');
      } else if (method === 'security-question') {
        document.getElementById('recovery-question-section').classList.remove('hidden');
        handleSecurityQuestionRecovery();
      } else if (method === '2fa') {
        document.getElementById('recovery-2fa-section').classList.remove('hidden');
        handleTwoFactorRecovery();
      }
    });
  });
}

function handleSecurityQuestionRecovery() {
  const emailInput = document.getElementById('recovery-sq-email');
  const questionDisplay = document.getElementById('recovery-sq-question');
  const questionText = document.getElementById('recovery-sq-text');
  const answerInput = document.getElementById('recovery-sq-answer');
  const errEl = document.getElementById('recovery-sq-error');
  const submitBtn = document.getElementById('recovery-sq-submit-btn');
  const backBtn = document.getElementById('recovery-sq-back-btn');
  
  emailInput.addEventListener('blur', async () => {
    if (!emailInput.value.trim()) return;
    errEl.classList.add('hidden');
    try {
      const res = await fetch('/api/forgot-password-advanced', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value, method: 'security-question' })
      });
      const data = await res.json();
      if (!res.ok) return showError(errEl, data.error);
      if (data.question) {
        questionText.textContent = data.question;
        questionDisplay.classList.remove('hidden');
      }
    } catch { showError(errEl, 'Erro ao buscar pergunta'); }
  });
  
  submitBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const answer = answerInput.value.trim();
    errEl.classList.add('hidden');
    if (!email || !answer) return showError(errEl, 'Preencha todos os campos');
    
    submitBtn.textContent = 'Verificando...';
    submitBtn.disabled = true;
    
    try {
      const res = await fetch('/api/verify-security-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, answer })
      });
      const data = await res.json();
      if (!res.ok) return showError(errEl, data.error);
      
      localStorage.setItem('resetToken', data.resetToken);
      window.location.href = '/reset-password.html?token=' + encodeURIComponent(data.resetToken) + '&method=security-question';
    } catch { showError(errEl, 'Erro de conexão'); }
    finally { submitBtn.textContent = 'Enviar'; submitBtn.disabled = false; }
  });
  
  backBtn.addEventListener('click', () => {
    document.getElementById('recovery-method-modal').classList.remove('hidden');
    document.getElementById('recovery-question-section').classList.add('hidden');
  });
}

function handleTwoFactorRecovery() {
  const emailInput = document.getElementById('recovery-2fa-email');
  const codeSection = document.getElementById('recovery-2fa-code-input');
  const codeInput = document.getElementById('recovery-2fa-code');
  const passwordInput = document.getElementById('recovery-2fa-password');
  const errEl = document.getElementById('recovery-2fa-error');
  const submitBtn = document.getElementById('recovery-2fa-submit-btn');
  const backBtn = document.getElementById('recovery-2fa-back-btn');
  
  let codeSent = false;
  
  submitBtn.addEventListener('click', async () => {
    errEl.classList.add('hidden');
    
    if (!codeSent) {
      const email = emailInput.value.trim();
      if (!email) return showError(errEl, 'Digite seu email');
      
      submitBtn.textContent = 'Enviando...';
      submitBtn.disabled = true;
      
      try {
        const res = await fetch('/api/forgot-password-advanced', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, method: '2fa' })
        });
        const data = await res.json();
        if (!res.ok) return showError(errEl, data.error);
        
        codeSent = true;
        codeSection.classList.remove('hidden');
        emailInput.disabled = true;
        submitBtn.textContent = 'Verificar código';
      } catch { showError(errEl, 'Erro ao enviar código'); }
      finally { submitBtn.disabled = false; }
    } else {
      const code = codeInput.value.trim();
      const password = passwordInput.value;
      if (!code || !password) return showError(errEl, 'Preencha código e nova senha');
      if (password.length < 6) return showError(errEl, 'Senha mínima de 6 caracteres');
      
      submitBtn.textContent = 'Redefinindo...';
      submitBtn.disabled = true;
      
      try {
        const res = await fetch('/api/verify-2fa-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, newPassword: password })
        });
        const data = await res.json();
        if (!res.ok) return showError(errEl, data.error);
        
        showToast('Senha redefinida! Faça login.');
        setTimeout(() => { window.location.href = '/'; }, 2000);
      } catch { showError(errEl, 'Erro de conexão'); }
      finally { submitBtn.textContent = 'Verificar código'; submitBtn.disabled = false; }
    }
  });
  
  backBtn.addEventListener('click', () => {
    document.getElementById('recovery-method-modal').classList.remove('hidden');
    document.getElementById('recovery-2fa-section').classList.add('hidden');
    codeSent = false;
    codeSection.classList.add('hidden');
    emailInput.disabled = false;
    submitBtn.textContent = 'Enviar código';
  });
}

// ─── WALLPAPER ────────────────────────────────────────────
var WALLPAPERS = {
  gradients: [
    { id: 'g1', style: 'linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)', label: 'Midnight' },
    { id: 'g2', style: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)', label: 'Galaxy' },
    { id: 'g3', style: 'linear-gradient(135deg, #093028, #237a57)', label: 'Forest' },
    { id: 'g4', style: 'linear-gradient(135deg, #200122, #6f0000)', label: 'Crimson' },
    { id: 'g5', style: 'linear-gradient(135deg, #1a0533, #4c0085, #1a0533)', label: 'Violet' },
    { id: 'g6', style: 'linear-gradient(135deg, #005c97, #363795)', label: 'Ocean' },
    { id: 'g7', style: 'linear-gradient(135deg, #1f4037, #99f2c8)', label: 'Emerald' },
    { id: 'g8', style: 'linear-gradient(135deg, #fc4a1a, #f7b733)', label: 'Sunset' }
  ],
  patterns: [
    { id: 'p1', style: 'repeating-linear-gradient(45deg, #1a1a2e 0px, #1a1a2e 10px, #222244 10px, #222244 20px)', label: 'Stripes' },
    { id: 'p2', style: 'repeating-linear-gradient(0deg, transparent, transparent 30px, rgba(129,140,248,0.08) 30px, rgba(129,140,248,0.08) 31px), repeating-linear-gradient(90deg, transparent, transparent 30px, rgba(129,140,248,0.08) 30px, rgba(129,140,248,0.08) 31px), #0d0d14', label: 'Grid' },
    { id: 'p3', style: 'radial-gradient(ellipse at 20% 50%, rgba(120,80,255,0.15) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(6,182,212,0.15) 0%, transparent 50%), #0d0d14', label: 'Aurora' },
    { id: 'p4', style: 'radial-gradient(circle at 15% 85%, rgba(244,114,182,0.2) 0%, transparent 40%), radial-gradient(circle at 85% 15%, rgba(129,140,248,0.2) 0%, transparent 40%), radial-gradient(circle at 50% 50%, rgba(6,182,212,0.1) 0%, transparent 60%), #0d0d14', label: 'Nebula' },
    { id: 'p5', style: 'radial-gradient(rgba(129,140,248,0.15) 1px, transparent 1px) 0 0 / 24px 24px, #0d0d14', label: 'Stars' },
    { id: 'p6', style: 'conic-gradient(from 0deg at 50% 50%, #0d0d14, #1a1a2e, #0d0d14, #21213a, #0d0d14)', label: 'Vortex' }
  ],
  textures: [
    { id: 't1', style: 'linear-gradient(rgba(129,140,248,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(129,140,248,0.05) 1px, transparent 1px), #0d0d14', label: 'Blueprint' },
    { id: 't2', style: 'repeating-linear-gradient(-45deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 1px, transparent 0px, transparent 50%), #111118', label: 'Fabric' },
    { id: 't3', style: 'linear-gradient(rgba(255,255,255,0.03) 2px, transparent 2px), linear-gradient(90deg, rgba(255,255,255,0.03) 2px, transparent 2px), #0d0d14', label: 'Matrix' },
    { id: 't4', style: 'radial-gradient(rgba(129,140,248,0.15) 1px, transparent 1px) 0 0 / 24px 24px, #0d0d14', label: 'Stars2' }
  ]
};
var activeWallpaperId = null;

function getWallpaperScope() {
  const checked = document.querySelector('input[name="wp-scope"]:checked');
  return checked ? checked.value : 'messages';
}
function getWallpaperOpacity() {
  const saved = localStorage.getItem('nexchat-wallpaper-opacity');
  const n = saved === null ? 0.38 : Math.max(0, Math.min(1, parseFloat(saved)));
  return Number.isFinite(n) ? n : 0.38;
}
function setWallpaperOpacity(value, save) {
  const n = Math.max(0, Math.min(1, Number(value)));
  document.documentElement.style.setProperty('--nexchat-wallpaper-opacity', String(n));
  if (save) localStorage.setItem('nexchat-wallpaper-opacity', String(n));
  const input = document.getElementById('wallpaper-opacity-input');
  const label = document.getElementById('wallpaper-opacity-value');
  if (input) input.value = Math.round(n * 100);
  if (label) label.textContent = Math.round(n * 100) + '%';
}

function setupWallpaperModal() {
  document.getElementById('wallpaper-btn').addEventListener('click', function() {
    document.getElementById('wallpaper-modal').classList.remove('hidden');
    const savedScope = localStorage.getItem('nexchat-wp-scope') || 'messages';
    const radioEl = document.getElementById('wp-scope-' + savedScope);
    if (radioEl) radioEl.checked = true;
    setWallpaperOpacity(getWallpaperOpacity(), false);
    renderWallpaperGrid();
  });
  const opacityInput = document.getElementById('wallpaper-opacity-input');
  if (opacityInput) {
    opacityInput.addEventListener('input', function() { setWallpaperOpacity(Number(opacityInput.value) / 100, true); });
  }
  document.querySelectorAll('input[name="wp-scope"]').forEach(function(radio) {
    radio.addEventListener('change', function() {
      const scope = getWallpaperScope();
      localStorage.setItem('nexchat-wp-scope', scope);
      const imgData = localStorage.getItem('nexchat-wallpaper-image');
      const style = localStorage.getItem('nexchat-wallpaper-style');
      if (imgData) setWallpaperImage(imgData, scope);
      else if (style) setWallpaperStyle(style, scope);
    });
  });

  function renderWallpaperGrid() {
    var savedId = localStorage.getItem('nexchat-wallpaper-id');
    ['gradients', 'patterns', 'textures'].forEach(function(cat) {
      var grid = document.getElementById('wallpaper-grid-' + cat); if (!grid) return;
      grid.innerHTML = '';
      WALLPAPERS[cat].forEach(function(wp) {
        var opt = document.createElement('div');
        opt.className = 'wallpaper-option' + (savedId === wp.id ? ' active' : '');
        opt.innerHTML = '<div class="wallpaper-option-inner" style="background:' + wp.style + '" title="' + wp.label + '"></div>';
        opt.addEventListener('click', function() { applyWallpaper(wp.id, wp.style); });
        grid.appendChild(opt);
      });
    });
  }

  var fileInput = document.getElementById('wallpaper-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', function(e) {
      var file = e.target.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function(ev) { applyWallpaperImage(ev.target.result); };
      reader.readAsDataURL(file);
    });
  }
  var clearBtn = document.getElementById('wallpaper-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      clearWallpaper(); showToast('Wallpaper removido');
    });
  }
}

function applyWallpaper(id, style) {
  const scope = getWallpaperScope();
  activeWallpaperId = id;
  localStorage.setItem('nexchat-wallpaper-id', id);
  localStorage.setItem('nexchat-wallpaper-style', style);
  localStorage.setItem('nexchat-wp-scope', scope);
  localStorage.removeItem('nexchat-wallpaper-image');
  setWallpaperStyle(style, scope);
  document.querySelectorAll('.wallpaper-option').forEach(function(el) {
    el.classList.remove('active');
    var inner = el.querySelector('.wallpaper-option-inner');
    if (inner && inner.style.background === style) el.classList.add('active');
  });
  showToast('Wallpaper aplicado e salvo!');
}

function applyWallpaperImage(dataUrl) {
  const scope = getWallpaperScope();
  localStorage.setItem('nexchat-wallpaper-image', dataUrl);
  localStorage.setItem('nexchat-wp-scope', scope);
  localStorage.removeItem('nexchat-wallpaper-id');
  localStorage.removeItem('nexchat-wallpaper-style');
  setWallpaperImage(dataUrl, scope);
  showToast('Imagem aplicada e salva!');
}

function clearWallpaperTargets() {
  const msgContainer = document.getElementById('messages-container');
  const cl = document.querySelector('.chat-list');
  const chatArea = document.getElementById('chat-area');
  [msgContainer, cl].forEach(function(el) {
    if (!el) return;
    el.classList.remove('wallpaper-applied');
    el.style.removeProperty('--nexchat-wallpaper');
    el.style.background = '';
    el.style.backgroundImage = '';
  });
  if (chatArea) chatArea.classList.remove('has-wallpaper');
}

function applyWallpaperCss(cssBackground, scope) {
  scope = scope || localStorage.getItem('nexchat-wp-scope') || 'messages';
  clearWallpaperTargets();
  setWallpaperOpacity(getWallpaperOpacity(), false);
  const msgContainer = document.getElementById('messages-container');
  const sidebarList = document.querySelector('.chat-list');
  const chatArea = document.getElementById('chat-area');
  if ((scope === 'messages' || scope === 'both') && msgContainer) {
    msgContainer.classList.add('wallpaper-applied');
    msgContainer.style.setProperty('--nexchat-wallpaper', cssBackground);
    if (chatArea) chatArea.classList.add('has-wallpaper');
  }
  if ((scope === 'contacts' || scope === 'both') && sidebarList) {
    sidebarList.classList.add('wallpaper-applied');
    sidebarList.style.setProperty('--nexchat-wallpaper', cssBackground);
  }
}

function setWallpaperStyle(style, scope) { applyWallpaperCss(style, scope); }
function setWallpaperImage(dataUrl, scope) { applyWallpaperCss('url("' + dataUrl + '")', scope); }

function clearWallpaper() {
  localStorage.removeItem('nexchat-wallpaper-id');
  localStorage.removeItem('nexchat-wallpaper-style');
  localStorage.removeItem('nexchat-wallpaper-image');
  localStorage.removeItem('nexchat-wp-scope');
  clearWallpaperTargets();
  activeWallpaperId = null;
  window._pendingWallpaper = null;
}

function loadWallpaper() {
  setWallpaperOpacity(getWallpaperOpacity(), false);
  var imgData = localStorage.getItem('nexchat-wallpaper-image');
  var style = localStorage.getItem('nexchat-wallpaper-style');
  var scope = localStorage.getItem('nexchat-wp-scope') || 'messages';
  if (imgData) window._pendingWallpaper = { type: 'image', value: imgData, scope };
  else if (style) window._pendingWallpaper = { type: 'style', value: style, scope };
}

function applyPendingWallpaper() {
  setWallpaperOpacity(getWallpaperOpacity(), false);
  if (!window._pendingWallpaper) return;
  var p = window._pendingWallpaper;
  if (p.type === 'image') setWallpaperImage(p.value, p.scope);
  else setWallpaperStyle(p.value, p.scope);
}

async function handlePendingGroupJoin() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('join') || params.get('group');
  if (!code || !currentUser) return;
  try {
    const res = await fetch('/api/groups/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await res.json();
    if (res.ok && data.group) {
      showToast('Você entrou no grupo ' + data.group.name + '!');
      await loadGroups();
      socket.emit('join_group', { groupId: data.group.id });
      openChat('group', data.group);
      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      showToast(data.error || 'Não foi possível entrar no grupo');
    }
  } catch { showToast('Erro ao entrar no grupo'); }
}

// ─── MODALS ───────────────────────────────────────────────
function setupModalCloses() {
  document.querySelectorAll('.modal-close').forEach(function(btn) {
    btn.addEventListener('click', function() { closeModal(btn.dataset.modal); });
  });
  document.querySelectorAll('.modal-overlay').forEach(function(overlay) {
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(overlay.id); });
  });
}
function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }

// ─── UTILS ────────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return '';
  var d = new Date(ts); var now = new Date();
  if (now - d < 86400000 && d.getDate() === now.getDate()) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (now - d < 604800000) return d.toLocaleDateString('pt-BR', { weekday: 'short' });
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
function formatDateLabel(ts) {
  var d = new Date(ts); var now = new Date(); var diff = now - d;
  if (diff < 86400000 && d.getDate() === now.getDate()) return 'Hoje';
  if (diff < 172800000) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg) {
  var toast = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function() { toast.classList.add('hidden'); }, 3000);
}
