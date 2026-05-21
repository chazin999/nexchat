const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) { nodemailer = null; }

// ─── CLOUDINARY SETUP ────────────────────────────────────
let cloudinary = null;
try {
  cloudinary = require('cloudinary').v2;
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    console.log('[Cloudinary] ✅ Configurado');
  } else {
    console.log('[Cloudinary] Não configurado, usando disco local');
    cloudinary = null;
  }
} catch(e) { cloudinary = null; }

async function uploadToCloud(filePath, folder = 'nexchat') {
  if (!cloudinary) return null;
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder,
      resource_type: 'auto',
    });
    return result.secure_url;
  } catch(e) {
    console.error('[Cloudinary] Upload error:', e.message);
    return null;
  }
}

// ─── MONGO SETUP ─────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || '';
let mongoClient, mdb;

// In-memory cache (fallback e performance)
const cache = {
  users: {},        // id -> user
  usersByEmail: {}, // email -> id
  usersByCode: {},  // friendCode -> id
  messages: {},     // chatId -> [msgs]
  groups: {},       // id -> group
  groupInvites: {}, // inviteCode -> groupId
  friendRequests: {} // userId -> [requests]
};

async function connectMongo() {
  if (!MONGO_URI) {
    console.warn('[DB] MONGODB_URI não configurado. Usando memória (dados não persistem ao reiniciar).');
    return false;
  }
  try {
    mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await mongoClient.connect();
    mdb = mongoClient.db('nexchat');
    console.log('[DB] ✅ MongoDB conectado');
    await loadFromMongo();
    return true;
  } catch(e) {
    console.error('[DB] ❌ Falha ao conectar MongoDB:', e.message);
    console.warn('[DB] Usando memória como fallback.');
    return false;
  }
}

async function loadFromMongo() {
  if (!mdb) return;
  try {
    // Carregar users
    const users = await mdb.collection('users').find({}).toArray();
    for (const u of users) {
      const { _id, ...user } = u;
      // Fix old users without friendCode
      if (!user.friendCode) {
        user.friendCode = generateFriendCode();
        await mdb.collection('users').updateOne({ id: user.id }, { $set: { friendCode: user.friendCode } });
        console.log('[Migration] Generated friendCode for user:', user.email);
      }
      // Fix old users without required fields
      if (!user.customNames) user.customNames = {};
      if (!user.friends) user.friends = [];
      if (!user.groups) user.groups = [];
      if (!user.recoveryMethods) user.recoveryMethods = ['email'];
      if (!user.recoveryEmails) user.recoveryEmails = [];
      cache.users[user.id] = user;
      cache.usersByEmail[user.email] = user.id;
      if (user.friendCode) cache.usersByCode[user.friendCode] = user.id;
      if (!cache.friendRequests[user.id]) cache.friendRequests[user.id] = [];
    }

    // Carregar groups
    const groups = await mdb.collection('groups').find({}).toArray();
    groups.forEach(g => {
      const { _id, ...group } = g;
      cache.groups[group.id] = group;
      if (group.inviteCode) cache.groupInvites[group.inviteCode] = group.id;
    });

    // Carregar messages (todas de uma vez para cache)
    const messages = await mdb.collection('messages').find({}).toArray();
    messages.forEach(m => {
      const { _id, chatId, ...msg } = m;
      if (!cache.messages[chatId]) cache.messages[chatId] = [];
      cache.messages[chatId].push(msg);
    });
    // Ordenar mensagens por timestamp
    Object.keys(cache.messages).forEach(chatId => {
      cache.messages[chatId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    });

    // Carregar friendRequests
    const frs = await mdb.collection('friendRequests').find({}).toArray();
    frs.forEach(fr => {
      const { _id, userId, ...req } = fr;
      if (!cache.friendRequests[userId]) cache.friendRequests[userId] = [];
      cache.friendRequests[userId].push(req);
    });

    console.log(`[DB] Carregados: ${users.length} usuários, ${groups.length} grupos, ${messages.length} mensagens`);
  } catch(e) {
    console.error('[DB] Erro ao carregar dados:', e.message);
  }
}

// Persistência assíncrona — não bloqueia o servidor
async function saveUser(user) {
  if (!mdb) return;
  try { await mdb.collection('users').replaceOne({ id: user.id }, user, { upsert: true }); } catch(e) { console.error('[DB] saveUser:', e.message); }
}
async function saveGroup(group) {
  if (!mdb) return;
  try { await mdb.collection('groups').replaceOne({ id: group.id }, group, { upsert: true }); } catch(e) { console.error('[DB] saveGroup:', e.message); }
}
async function saveMessage(chatId, msg) {
  if (!mdb) return;
  try { await mdb.collection('messages').replaceOne({ id: msg.id }, { chatId, ...msg }, { upsert: true }); } catch(e) { console.error('[DB] saveMessage:', e.message); }
}
async function deleteMessage(msgId) {
  if (!mdb) return;
  try { await mdb.collection('messages').deleteOne({ id: msgId }); } catch(e) { console.error('[DB] deleteMessage:', e.message); }
}
async function saveFriendRequest(userId, req) {
  if (!mdb) return;
  try { await mdb.collection('friendRequests').replaceOne({ id: req.id }, { userId, ...req }, { upsert: true }); } catch(e) { console.error('[DB] saveFR:', e.message); }
}
async function deleteFriendRequest(reqId) {
  if (!mdb) return;
  try { await mdb.collection('friendRequests').deleteOne({ id: reqId }); } catch(e) { console.error('[DB] deleteFR:', e.message); }
}

// ─── EXPRESS SETUP ─────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

const resetTokens = {};
const twoFactorTokens = {};
const otpTokens = {};

const uploadsDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/', 'video/', 'audio/'];
    if (allowed.some(t => file.mimetype.startsWith(t))) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido'));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(uploadsDir));

// Catch-all: serve index.html para rotas não reconhecidas
// ─── SESSION (persistente via MongoDB) ───────────────────
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
app.use(session({
  secret: process.env.SESSION_SECRET || 'nexchat-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction
  }
}));
// Necessário para sameSite=none funcionar atrás de proxy (Render, etc.)
if (isProduction) app.set('trust proxy', 1);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── UTILS ─────────────────────────────────────────────────
function generateFriendCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 8; i++) { if (i === 4) code += '-'; code += chars[Math.floor(Math.random() * chars.length)]; }
  } while (cache.usersByCode[code]);
  return code;
}
function generateGroupInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  do {
    code = 'NXG-';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (cache.groupInvites[code]);
  return code;
}
function normalizeGroupInviteCode(raw) {
  if (!raw) return '';
  let code = String(raw).trim();
  try { const url = new URL(code, appUrl); code = url.searchParams.get('join') || url.searchParams.get('group') || code; } catch {}
  code = code.split('/').pop().split('?').pop();
  return code.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}
function getChatId(u1, u2) { return [u1, u2].sort().join('_'); }
function sanitizeUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, friendCode: user.friendCode, avatar: user.avatar, bio: user.bio, status: user.status, friends: user.friends, groups: user.groups, createdAt: user.createdAt, customNames: user.customNames || {} };
}
function sanitizeGroup(g) {
  if (!g.inviteCode) { g.inviteCode = generateGroupInviteCode(); cache.groupInvites[g.inviteCode] = g.id; saveGroup(g); }
  return { id: g.id, name: g.name, description: g.description, avatar: g.avatar, createdBy: g.createdBy, admins: g.admins, members: g.members, createdAt: g.createdAt, allowAllEdit: g.allowAllEdit || false, inviteCode: g.inviteCode, banned: g.banned || [] };
}

// ─── AUTH ROUTES ────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
  if (!email.toLowerCase().endsWith('@gmail.com')) return res.status(400).json({ error: 'Use um email Gmail (@gmail.com)' });
  if (cache.usersByEmail[email.toLowerCase()]) return res.status(400).json({ error: 'Email já cadastrado' });
  const userId = uuidv4(); const friendCode = generateFriendCode();
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = { id: userId, name, email, password: hashedPassword, friendCode, avatar: null, bio: '', status: 'online', friends: [], groups: [], createdAt: new Date().toISOString(), customNames: {}, securityQuestions: null, twoFactorEnabled: false, twoFactorSecret: null, recoveryMethods: ['email'], recoveryEmails: [] };
  cache.users[userId] = user; cache.usersByEmail[email] = userId; cache.usersByCode[friendCode] = userId; cache.friendRequests[userId] = [];
  saveUser(user);
  req.session.userId = userId;
  res.json({ success: true, user: sanitizeUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const userId = cache.usersByEmail[email.toLowerCase()];
  if (!userId) return res.status(401).json({ error: 'Credenciais inválidas' });
  const user = cache.users[userId];
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });
  req.session.userId = userId; user.status = 'online';
  saveUser(user);
  res.json({ success: true, user: sanitizeUser(user) });
});

app.post('/api/logout', (req, res) => {
  const userId = req.session.userId;
  if (userId && cache.users[userId]) { cache.users[userId].status = 'offline'; saveUser(cache.users[userId]); }
  req.session.destroy(); res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  const userId = req.session.userId;
  if (!userId || !cache.users[userId]) return res.status(401).json({ error: 'Não autenticado' });
  const user = cache.users[userId];
  // Auto-fix old users without friendCode
  if (!user.friendCode) {
    user.friendCode = generateFriendCode();
    cache.usersByCode[user.friendCode] = user.id;
    await saveUser(user);
  }
  if (!user.customNames) user.customNames = {};
  if (!user.friends) user.friends = [];
  if (!user.groups) user.groups = [];
  res.json({ user: sanitizeUser(user) });
});

app.put('/api/profile', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { name, bio, status } = req.body; const user = cache.users[userId];
  if (name) user.name = name; if (bio !== undefined) user.bio = bio; if (status) user.status = status;
  saveUser(user);
  io.emit('user_updated', { userId, name: user.name, bio: user.bio, status: user.status, avatar: user.avatar });
  res.json({ user: sanitizeUser(user) });
});

// ─── MEDIA UPLOAD ───────────────────────────────────────────
app.post('/api/upload-media', upload.single('media'), async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
  const mimetype = req.file.mimetype;
  let type = 'file';
  if (mimetype.startsWith('image/')) type = 'image';
  else if (mimetype.startsWith('video/')) type = 'video';
  else if (mimetype.startsWith('audio/')) type = 'audio';
  let url = '/uploads/' + req.file.filename;
  const cloudUrl = await uploadToCloud(req.file.path, 'nexchat/media');
  if (cloudUrl) { url = cloudUrl; try { fs.unlinkSync(req.file.path); } catch(e) {} }
  res.json({ url, type });
});

// ─── STICKERS ───────────────────────────────────────────────
app.post('/api/stickers', upload.single('sticker'), async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
  const user = cache.users[userId];
  if (!user.stickers) user.stickers = [];
  // Check duplicate by hash
  const fileBuffer = fs.readFileSync(req.file.path);
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const duplicate = user.stickers.find(s => s.hash === hash);
  if (duplicate) {
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    return res.json({ sticker: duplicate });
  }
  let url = '/uploads/' + req.file.filename;
  const cloudUrl = await uploadToCloud(req.file.path, 'nexchat/stickers');
  if (cloudUrl) { url = cloudUrl; try { fs.unlinkSync(req.file.path); } catch(e) {} }
  const sticker = { id: uuidv4(), url, hash, favorited: false, createdAt: new Date().toISOString() };
  user.stickers.push(sticker);
  saveUser(user);
  res.json({ sticker });
});

app.get('/api/stickers', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = cache.users[userId];
  res.json({ stickers: user.stickers || [] });
});

app.put('/api/stickers/:stickerId/favorite', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = cache.users[userId];
  const sticker = (user.stickers || []).find(s => s.id === req.params.stickerId);
  if (!sticker) return res.status(404).json({ error: 'Figurinha não encontrada' });
  sticker.favorited = !sticker.favorited;
  saveUser(user);
  res.json({ sticker });
});

app.delete('/api/stickers/:stickerId', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = cache.users[userId];
  user.stickers = (user.stickers || []).filter(s => s.id !== req.params.stickerId);
  saveUser(user);
  res.json({ success: true });
});

app.post('/api/avatar', upload.single('avatar'), async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
  const user = cache.users[userId];
  let avatarUrl = `/uploads/${req.file.filename}`;
  const cloudUrl = await uploadToCloud(req.file.path, 'nexchat/avatars');
  if (cloudUrl) { avatarUrl = cloudUrl; try { fs.unlinkSync(req.file.path); } catch(e) {} }
  user.avatar = avatarUrl;
  saveUser(user);
  io.emit('user_updated', { userId, name: user.name, bio: user.bio, status: user.status, avatar: user.avatar });
  res.json({ avatar: user.avatar });
});

app.put('/api/contacts/:contactId/name', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { contactId } = req.params; const { customName } = req.body;
  const user = cache.users[userId]; if (!user.customNames) user.customNames = {};
  if (customName && customName.trim()) user.customNames[contactId] = customName.trim();
  else delete user.customNames[contactId];
  saveUser(user);
  res.json({ success: true, customNames: user.customNames });
});

// ─── FRIENDS ────────────────────────────────────────────────
app.post('/api/friends/request', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { friendCode, targetId: directTargetId } = req.body;
  const targetId = directTargetId || cache.usersByCode[friendCode?.toUpperCase()];
  if (!targetId) return res.status(404).json({ error: 'Código não encontrado' });
  if (targetId === userId) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });
  const sender = cache.users[userId]; if (!sender) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (sender.friends.includes(targetId)) return res.status(400).json({ error: 'Já são amigos' });
  const existing = cache.friendRequests[targetId]?.find(r => r.from === userId);
  if (existing) return res.status(400).json({ error: 'Solicitação já enviada' });
  const request = { id: uuidv4(), from: userId, fromName: sender.name, fromAvatar: sender.avatar, fromCode: sender.friendCode, timestamp: new Date().toISOString() };
  if (!cache.friendRequests[targetId]) cache.friendRequests[targetId] = [];
  cache.friendRequests[targetId].push(request);
  saveFriendRequest(targetId, request);
  io.to(`user_${targetId}`).emit('friend_request', request);
  res.json({ success: true, message: 'Solicitação enviada!' });
});

app.get('/api/friends/requests', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ requests: cache.friendRequests[userId] || [] });
});

app.post('/api/friends/accept', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { requestId } = req.body; const requests = cache.friendRequests[userId] || [];
  const reqIdx = requests.findIndex(r => r.id === requestId);
  if (reqIdx === -1) return res.status(404).json({ error: 'Solicitação não encontrada' });
  const request = requests[reqIdx]; const fromId = request.from;
  cache.users[userId].friends.push(fromId); cache.users[fromId].friends.push(userId);
  cache.friendRequests[userId].splice(reqIdx, 1);
  const chatId = getChatId(userId, fromId);
  if (!cache.messages[chatId]) cache.messages[chatId] = [];
  await deleteFriendRequest(requestId);
  saveUser(cache.users[userId]); saveUser(cache.users[fromId]);
  io.to(`user_${fromId}`).emit('friend_accepted', { userId, name: cache.users[userId].name, avatar: cache.users[userId].avatar, friendCode: cache.users[userId].friendCode });
  res.json({ success: true });
});

app.post('/api/friends/reject', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { requestId } = req.body; const requests = cache.friendRequests[userId] || [];
  const reqIdx = requests.findIndex(r => r.id === requestId);
  if (reqIdx !== -1) { cache.friendRequests[userId].splice(reqIdx, 1); await deleteFriendRequest(requestId); }
  res.json({ success: true });
});

app.post('/api/friends/remove', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { friendId } = req.body; const user = cache.users[userId]; const friend = cache.users[friendId];
  if (!user || !friend) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.friends = user.friends.filter(id => id !== friendId);
  friend.friends = friend.friends.filter(id => id !== userId);
  saveUser(user); saveUser(friend);
  res.json({ success: true });
});

app.get('/api/friends', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = cache.users[userId];
  const friends = user.friends.map(fId => {
    const f = cache.users[fId]; if (!f) return null;
    const chatId = getChatId(userId, fId); const msgs = cache.messages[chatId] || [];
    const lastMsg = msgs[msgs.length - 1] || null;
    const customName = (user.customNames || {})[fId];
    return { ...sanitizeUser(f), displayName: customName || f.name, lastMessage: lastMsg ? { text: lastMsg.text, timestamp: lastMsg.timestamp, type: lastMsg.type } : null, unread: msgs.filter(m => m.to === userId && !m.read).length };
  }).filter(Boolean);
  res.json({ friends });
});

// ─── GROUPS ─────────────────────────────────────────────────
app.post('/api/groups', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { name, description, memberIds } = req.body;
  const groupId = uuidv4();
  const members = [userId, ...(memberIds || [])].filter(id => cache.users[id]);
  const inviteCode = generateGroupInviteCode();
  const group = { id: groupId, name, description: description || '', avatar: null, createdBy: userId, admins: [userId], members, createdAt: new Date().toISOString(), allowAllEdit: false, inviteCode, banned: [] };
  cache.groups[groupId] = group; cache.groupInvites[inviteCode] = groupId; cache.messages[`group_${groupId}`] = [];
  members.forEach(mId => {
    if (!cache.users[mId].groups) cache.users[mId].groups = [];
    cache.users[mId].groups.push(groupId);
    saveUser(cache.users[mId]);
    io.to(`user_${mId}`).emit('group_created', sanitizeGroup(group));
  });
  saveGroup(group);
  res.json({ group: sanitizeGroup(group) });
});

app.get('/api/groups', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = cache.users[userId];
  const groups = (user.groups || []).map(gId => {
    const g = cache.groups[gId]; if (!g) return null;
    const msgs = cache.messages[`group_${gId}`] || []; const lastMsg = msgs[msgs.length - 1] || null;
    return { ...sanitizeGroup(g), memberDetails: g.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean), lastMessage: lastMsg ? { text: lastMsg.text, timestamp: lastMsg.timestamp, senderName: lastMsg.senderName } : null };
  }).filter(Boolean);
  res.json({ groups });
});

app.post('/api/groups/join', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const code = normalizeGroupInviteCode(req.body.code || req.body.inviteCode || req.body.link);
  const groupId = cache.groupInvites[code] || (cache.groups[code] ? code : null);
  const group = groupId ? cache.groups[groupId] : null;
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado. Verifique o código ou link.' });
  if (group.banned && group.banned.includes(userId)) return res.status(403).json({ error: 'Você está banido deste grupo.' });
  const user = cache.users[userId];
  if (!user.groups) user.groups = [];
  if (!group.members.includes(userId)) group.members.push(userId);
  if (!user.groups.includes(group.id)) user.groups.push(group.id);
  saveUser(user); saveGroup(group);
  const updated = { ...sanitizeGroup(group), memberDetails: group.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) };
  io.to(`user_${userId}`).emit('group_created', updated);
  io.to(`group_${group.id}`).emit('group_updated', updated);
  res.json({ success: true, group: updated });
});

app.get('/api/groups/:groupId/invite', (req, res) => {
  const userId = req.session.userId; const { groupId } = req.params; const group = cache.groups[groupId];
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  if (!group || !group.members.includes(userId)) return res.status(403).json({ error: 'Acesso negado' });
  if (!group.inviteCode) { group.inviteCode = generateGroupInviteCode(); cache.groupInvites[group.inviteCode] = group.id; saveGroup(group); }
  res.json({ inviteCode: group.inviteCode, inviteLink: `${appUrl}/?join=${encodeURIComponent(group.inviteCode)}` });
});

app.get('/api/groups/:groupId', (req, res) => {
  const userId = req.session.userId; const { groupId } = req.params; const g = cache.groups[groupId];
  if (!g || !g.members.includes(userId)) return res.status(403).json({ error: 'Acesso negado' });
  res.json({ group: { ...sanitizeGroup(g), memberDetails: g.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) } });
});

app.put('/api/groups/:groupId', (req, res) => {
  const userId = req.session.userId; const { groupId } = req.params; const group = cache.groups[groupId];
  if (!group || !group.members.includes(userId)) return res.status(403).json({ error: 'Sem permissão' });
  const isAdmin = group.admins.includes(userId);
  if (!isAdmin && !group.allowAllEdit) return res.status(403).json({ error: 'Somente admins podem editar' });
  const { name, description, allowAllEdit } = req.body;
  if (name !== undefined) group.name = name;
  if (description !== undefined) group.description = description;
  if (allowAllEdit !== undefined && isAdmin) group.allowAllEdit = allowAllEdit;
  saveGroup(group);
  const updated = { ...sanitizeGroup(group), memberDetails: group.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) };
  io.to(`group_${groupId}`).emit('group_updated', updated);
  res.json({ group: updated });
});

app.post('/api/groups/:groupId/avatar', upload.single('avatar'), (req, res) => {
  const userId = req.session.userId; const { groupId } = req.params; const group = cache.groups[groupId];
  if (!group || !group.members.includes(userId)) return res.status(403).json({ error: 'Sem permissão' });
  if (!group.admins.includes(userId) && !group.allowAllEdit) return res.status(403).json({ error: 'Somente admins podem mudar a foto' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
  if (group.avatar) { const old = path.join(uploadsDir, path.basename(group.avatar)); if (fs.existsSync(old)) fs.unlinkSync(old); }
  group.avatar = `/uploads/${req.file.filename}`;
  saveGroup(group);
  const updated = { ...sanitizeGroup(group), memberDetails: group.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) };
  io.to(`group_${groupId}`).emit('group_updated', updated);
  res.json({ avatar: group.avatar, group: updated });
});

app.post('/api/groups/:groupId/admin', (req, res) => {
  const userId = req.session.userId; const { groupId } = req.params; const { memberId, action } = req.body;
  const group = cache.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Somente admins podem gerenciar admins' });
  if (!group.members.includes(memberId)) return res.status(400).json({ error: 'Membro não está no grupo' });
  if (action === 'add') { if (!group.admins.includes(memberId)) group.admins.push(memberId); }
  else if (action === 'remove') {
    if (memberId === group.createdBy) return res.status(400).json({ error: 'Não é possível remover o dono' });
    group.admins = group.admins.filter(id => id !== memberId);
  }
  saveGroup(group);
  const updated = { ...sanitizeGroup(group), memberDetails: group.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) };
  io.to(`group_${groupId}`).emit('group_updated', updated);
  res.json({ group: updated });
});

app.post('/api/groups/:groupId/leave', (req, res) => {
  const userId = req.session.userId; const { groupId } = req.params; const group = cache.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  group.members = group.members.filter(id => id !== userId);
  group.admins = group.admins.filter(id => id !== userId);
  const user = cache.users[userId]; if (user) user.groups = (user.groups || []).filter(id => id !== groupId);
  saveGroup(group); saveUser(user);
  io.to(`group_${groupId}`).emit('group_updated', { ...sanitizeGroup(group), memberDetails: group.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) });
  res.json({ success: true });
});

// ─── DISSOLVER GRUPO ─────────────────────────────────────────────
app.post('/api/groups/:groupId/dissolve', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { groupId } = req.params; const group = cache.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (group.createdBy !== userId) return res.status(403).json({ error: 'Somente o dono pode dissolver o grupo' });
  const { mode, newAdminId } = req.body;
  // mode: 'all' = dissolver e remover todos; 'transfer' = transferir para novo admin e sair
  if (mode === 'transfer' && newAdminId) {
    // transferir dono, sair do grupo
    if (!group.members.includes(newAdminId)) return res.status(400).json({ error: 'Membro não encontrado' });
    group.createdBy = newAdminId;
    if (!group.admins.includes(newAdminId)) group.admins.push(newAdminId);
    group.admins = group.admins.filter(id => id !== userId);
    group.members = group.members.filter(id => id !== userId);
    const user = cache.users[userId]; if (user) user.groups = (user.groups || []).filter(id => id !== groupId);
    saveGroup(group); saveUser(user);
    const updated = { ...sanitizeGroup(group), memberDetails: group.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) };
    io.to(`group_${groupId}`).emit('group_updated', updated);
    io.to(`user_${userId}`).emit('group_dissolved_exit', { groupId });
    res.json({ success: true, mode: 'transfer' });
  } else {
    // dissolve completamente - remover todos os membros
    const members = [...group.members];
    members.forEach(mId => {
      const u = cache.users[mId]; if (u) u.groups = (u.groups || []).filter(id => id !== groupId); saveUser(u);
    });
    // Notificar todos
    io.to(`group_${groupId}`).emit('group_dissolved', { groupId, groupName: group.name });
    // Remover grupo
    delete cache.groups[groupId];
    if (group.inviteCode) delete cache.groupInvites[group.inviteCode];
    delete cache.messages[`group_${groupId}`];
    if (mdb) { mdb.collection('groups').deleteOne({ id: groupId }).catch(console.error); mdb.collection('messages').deleteMany({ chatId: `group_${groupId}` }).catch(console.error); }
    res.json({ success: true, mode: 'all' });
  }
});

// ─── ENTRAR POR CÓDIGO (modal na sidebar) ──────────────────────
app.post('/api/groups/join-by-code', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const code = normalizeGroupInviteCode(req.body.code || '');
  const groupId = cache.groupInvites[code] || (cache.groups[code] ? code : null);
  const group = groupId ? cache.groups[groupId] : null;
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado. Verifique o código.' });
  if (group.banned && group.banned.includes(userId)) return res.status(403).json({ error: 'Você está banido deste grupo.' });
  const user = cache.users[userId]; if (!user.groups) user.groups = [];
  if (!group.members.includes(userId)) group.members.push(userId);
  if (!user.groups.includes(group.id)) user.groups.push(group.id);
  saveUser(user); saveGroup(group);
  const updated = { ...sanitizeGroup(group), memberDetails: group.members.map(mId => sanitizeUser(cache.users[mId])).filter(Boolean) };
  io.to(`user_${userId}`).emit('group_created', updated);
  io.to(`group_${group.id}`).emit('group_updated', updated);
  res.json({ success: true, group: updated });
});

// ─── MODERAÇÃO ───────────────────────────────────────────────
app.post('/api/groups/:groupId/remove-member', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { groupId } = req.params; const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'Membro obrigatório' });
  const group = cache.groups[groupId]; if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Sem permissão' });
  if (memberId === group.createdBy) return res.status(400).json({ error: 'Não pode remover o dono' });
  const idx = group.members.indexOf(memberId); if (idx === -1) return res.status(400).json({ error: 'Membro não encontrado' });
  group.members.splice(idx, 1);
  saveGroup(group);
  io.to(`group_${groupId}`).emit('member_removed', { memberId, groupId });
  res.json({ success: true, message: 'Membro removido' });
});

app.post('/api/groups/:groupId/ban-member', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { groupId } = req.params; const { memberId } = req.body;
  const group = cache.groups[groupId]; if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Sem permissão' });
  if (memberId === group.createdBy) return res.status(400).json({ error: 'Não pode banir o dono' });
  if (!group.banned) group.banned = [];
  if (group.banned.includes(memberId)) return res.status(400).json({ error: 'Usuário já está banido' });
  const idx = group.members.indexOf(memberId); if (idx !== -1) group.members.splice(idx, 1);
  group.banned.push(memberId);
  saveGroup(group);
  io.to(`group_${groupId}`).emit('member_banned', { memberId, groupId });
  res.json({ success: true, message: 'Usuário banido' });
});

app.post('/api/groups/:groupId/unban-member', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { groupId } = req.params; const { memberId } = req.body;
  const group = cache.groups[groupId]; if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Sem permissão' });
  if (!group.banned) group.banned = [];
  const idx = group.banned.indexOf(memberId); if (idx === -1) return res.status(400).json({ error: 'Usuário não está banido' });
  group.banned.splice(idx, 1);
  saveGroup(group);
  res.json({ success: true, message: 'Usuário desbanido' });
});

app.get('/api/groups/:groupId/banned-users', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { groupId } = req.params; const group = cache.groups[groupId];
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Sem permissão' });
  const bannedUsers = (group.banned || []).map(id => { const u = cache.users[id]; return { id, name: u ? u.name : 'Usuário desconhecido', avatar: u ? u.avatar : null }; });
  res.json({ bannedUsers });
});

// ─── MESSAGES ───────────────────────────────────────────────
app.get('/api/messages/:chatId', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { chatId } = req.params; const msgs = cache.messages[chatId] || [];
  msgs.forEach(m => { if (m.to === userId && !m.read) { m.read = true; saveMessage(chatId, m); } });
  const filtered = msgs.filter(m => !m.deletedFor || !m.deletedFor.includes(userId));
  res.json({ messages: filtered });
});

app.post('/api/messages/:chatId/:msgId/react', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { chatId, msgId } = req.params; const { emoji } = req.body;
  const msgs = cache.messages[chatId] || []; const msg = msgs.find(m => m.id === msgId);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  const idx = msg.reactions[emoji].indexOf(userId);
  if (idx === -1) msg.reactions[emoji].push(userId);
  else { msg.reactions[emoji].splice(idx, 1); if (!msg.reactions[emoji].length) delete msg.reactions[emoji]; }
  saveMessage(chatId, msg);
  io.emit('reaction_updated', { chatId, msgId, reactions: msg.reactions });
  res.json({ reactions: msg.reactions });
});

app.delete('/api/messages/:chatId/:msgId', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { chatId, msgId } = req.params;
  const { scope } = req.query; // 'me' or 'all'
  const msgs = cache.messages[chatId] || [];
  const idx = msgs.findIndex(m => m.id === msgId);
  if (idx === -1) return res.status(404).json({ error: 'Mensagem não encontrada' });
  const msg = msgs[idx];
  if (scope === 'all') {
    if (msg.from !== userId) return res.status(403).json({ error: 'Sem permissão' });
    msgs.splice(idx, 1); deleteMessage(msgId);
    io.to(chatId).emit('message_deleted', { chatId, msgId, scope: 'all' });
    // Also notify the other user directly
    const otherId = chatId.split('_').find(id => id !== userId);
    if (otherId) io.to('user_' + otherId).emit('message_deleted', { chatId, msgId, scope: 'all' });
  } else {
    // Delete only for me: mark as deleted for this user
    if (!msg.deletedFor) msg.deletedFor = [];
    if (!msg.deletedFor.includes(userId)) msg.deletedFor.push(userId);
    saveMessage(chatId, msg);
  }
  res.json({ success: true });
});

// ─── EDITAR MENSAGEM ──────────────────────────────────────────
app.put('/api/messages/:chatId/:msgId/edit', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { chatId, msgId } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Texto vazio' });
  const msgs = cache.messages[chatId] || [];
  const msg = msgs.find(m => m.id === msgId);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
  if (msg.from !== userId) return res.status(403).json({ error: 'Sem permissão para editar' });
  msg.text = text.trim();
  msg.editedAt = new Date().toISOString();
  msg.edited = true;
  saveMessage(chatId, msg);
  io.to(chatId).emit('message_edited', { chatId, msgId, newText: text.trim(), editedAt: msg.editedAt });
  if (!chatId.startsWith('group_')) {
    const otherId = chatId.split('_').find(id => id !== userId);
    if (otherId) io.to('user_' + otherId).emit('message_edited', { chatId, msgId, newText: text.trim(), editedAt: msg.editedAt });
  }
  res.json({ success: true, message: msg });
});

// ─── SECURITY & PASSWORD ────────────────────────────────────
const SECURITY_QUESTIONS = [
  'Qual é o nome do seu primeiro animal de estimação?',
  'Em qual cidade você nasceu?',
  'Qual é o nome da sua mãe?',
  'Qual é o seu filme favorito?',
  'Qual é a marca do seu primeiro carro?',
  'Qual é o seu livro favorito?',
  'Qual é o nome do seu melhor amigo da infância?',
  'Qual é a sua comida favorita?'
];
function generateTwoFactorCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

const emailUser = process.env.EMAIL_USER || '';
const emailPass = process.env.EMAIL_PASS || '';
const emailFrom = process.env.EMAIL_FROM || `NexChat <${emailUser}>`;
const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

let transporter = null;
if (emailUser && emailPass && nodemailer) {
  transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });
  transporter.verify((err) => {
    if (err) console.error('[Email] ❌', err.message);
    else console.log('[Email] ✅ Servidor de email pronto');
  });
} else {
  console.warn('[Email] Não configurado. Emails aparecerão no console (modo dev).');
}

async function sendMail(to, subject, html) {
  if (transporter) { await transporter.sendMail({ from: emailFrom, to, subject, html }); }
  else { console.log(`\n[DEV EMAIL] Para: ${to}\nAssunto: ${subject}\n`); }
}
async function sendPasswordResetEmail(toEmail, token) {
  const resetUrl = `${appUrl}/reset-password.html?token=${token}`;
  const html = `<div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f0f17;border-radius:16px;padding:32px;border:1px solid #2a2a3e;"><h2 style="color:#818CF8;">🔐 Redefinição de senha - NexChat</h2><p style="color:#94a3b8;">Clique no link abaixo para criar uma nova senha:</p><a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#818CF8,#06B6D4);color:white;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;">Redefinir minha senha</a><p style="color:#64748b;font-size:12px;margin-top:24px;">Link expira em 1 hora. Se não foi você, ignore.</p></div>`;
  if (transporter) await sendMail(toEmail, '🔐 Redefinir senha - NexChat', html);
  else console.log(`[DEV] RESET LINK: ${resetUrl}`);
}
async function sendOTPEmail(toEmail, otp) {
  const html = `<div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f0f17;border-radius:16px;padding:32px;border:1px solid #2a2a3e;"><h2 style="color:#818CF8;">🔑 Código OTP - NexChat</h2><div style="background:#1a1a2e;border:2px solid #818CF8;border-radius:10px;padding:20px;text-align:center;margin:16px 0;"><div style="font-size:36px;font-weight:700;color:#818CF8;letter-spacing:4px;">${otp}</div></div><p style="color:#64748b;font-size:12px;">Expira em 15 minutos.</p></div>`;
  if (transporter) await sendMail(toEmail, '🔑 Código de verificação - NexChat', html);
  else console.log(`[DEV] OTP para ${toEmail}: ${otp}`);
}

app.get('/api/user/security/questions', (req, res) => res.json({ questions: SECURITY_QUESTIONS }));

app.post('/api/user/security/setup', async (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { questionIndex, answer, method } = req.body;
  const user = cache.users[userId]; if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (method === 'security-question') {
    const hashedAnswer = await bcrypt.hash(answer.toLowerCase().trim(), 10);
    user.securityQuestions = { questionIndex, answer: hashedAnswer };
    if (!user.recoveryMethods.includes('security-question')) user.recoveryMethods.push('security-question');
  } else if (method === '2fa') {
    user.twoFactorEnabled = true;
    if (!user.recoveryMethods.includes('2fa')) user.recoveryMethods.push('2fa');
  }
  saveUser(user);
  res.json({ success: true });
});

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body; if (!email) return res.status(400).json({ error: 'Email obrigatório' });
  const userId = cache.usersByEmail[email.toLowerCase().trim()];
  if (userId) {
    const token = uuidv4() + uuidv4();
    Object.keys(resetTokens).forEach(t => { if (resetTokens[t].userId === userId) delete resetTokens[t]; });
    resetTokens[token] = { userId, expires: Date.now() + 3600000 };
    try { await sendPasswordResetEmail(email, token); } catch(e) { console.error('[Email]', e.message); }
  }
  res.json({ success: true, message: 'Se o email estiver cadastrado, você receberá um link.' });
});

app.post('/api/forgot-password-advanced', async (req, res) => {
  const { email, method } = req.body;
  const userId = cache.usersByEmail[email?.toLowerCase().trim()];
  if (!userId) return res.json({ success: true, message: 'Se o email estiver cadastrado, você receberá instruções.' });
  const user = cache.users[userId];
  if (method === 'email') {
    const token = uuidv4() + uuidv4();
    resetTokens[token] = { userId, expires: Date.now() + 3600000 };
    try { await sendPasswordResetEmail(email, token); } catch(e) {}
    return res.json({ success: true, message: 'Se o email estiver cadastrado, você receberá instruções.' });
  } else if (method === 'security-question') {
    if (!user.securityQuestions) return res.status(400).json({ error: 'Pergunta de segurança não configurada' });
    return res.json({ success: true, questionIndex: user.securityQuestions.questionIndex, question: SECURITY_QUESTIONS[user.securityQuestions.questionIndex] });
  } else if (method === '2fa') {
    const code = generateTwoFactorCode();
    twoFactorTokens[code] = { userId, expires: Date.now() + 600000 };
    try { await sendOTPEmail(email, code); } catch(e) {}
    return res.json({ success: true, message: 'Código enviado para seu email' });
  }
  res.json({ success: true });
});

app.post('/api/verify-security-answer', async (req, res) => {
  const { email, answer } = req.body;
  const userId = cache.usersByEmail[email?.toLowerCase().trim()]; if (!userId) return res.status(400).json({ error: 'Usuário não encontrado' });
  const user = cache.users[userId]; if (!user.securityQuestions) return res.status(400).json({ error: 'Não configurada' });
  const valid = await bcrypt.compare(answer.toLowerCase().trim(), user.securityQuestions.answer);
  if (!valid) return res.status(400).json({ error: 'Resposta incorreta' });
  const token = uuidv4() + uuidv4();
  resetTokens[token] = { userId, expires: Date.now() + 3600000 };
  res.json({ success: true, resetToken: token });
});

app.post('/api/request-otp', async (req, res) => {
  const { email } = req.body; if (!email) return res.status(400).json({ error: 'Email obrigatório' });
  const userId = cache.usersByEmail[email.toLowerCase().trim()];
  if (userId) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    Object.keys(otpTokens).forEach(t => { if (otpTokens[t].userId === userId) delete otpTokens[t]; });
    otpTokens[otp] = { userId, expires: Date.now() + 900000 };
    try { await sendOTPEmail(email, otp); } catch(e) {}
  }
  res.json({ success: true, message: 'Se o email estiver cadastrado, você receberá um código.' });
});

app.post('/api/verify-otp-reset', async (req, res) => {
  const { otp, newPassword } = req.body;
  if (!otp || !newPassword) return res.status(400).json({ error: 'Código e senha obrigatórios' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
  const record = otpTokens[otp];
  if (!record || Date.now() > record.expires) { if (record) delete otpTokens[otp]; return res.status(400).json({ error: 'Código inválido ou expirado' }); }
  const user = cache.users[record.userId]; if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.password = await bcrypt.hash(newPassword, 10);
  delete otpTokens[otp];
  saveUser(user);
  res.json({ success: true, message: 'Senha redefinida com sucesso!' });
});

app.post('/api/verify-2fa-code', async (req, res) => {
  const { code, newPassword } = req.body;
  const record = twoFactorTokens[code];
  if (!record || Date.now() > record.expires) { if (record) delete twoFactorTokens[code]; return res.status(400).json({ error: 'Código inválido ou expirado' }); }
  const user = cache.users[record.userId]; if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.password = await bcrypt.hash(newPassword, 10);
  delete twoFactorTokens[code];
  saveUser(user);
  res.json({ success: true, message: 'Senha redefinida com sucesso!' });
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token e senha obrigatórios' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
  const record = resetTokens[token];
  if (!record) return res.status(400).json({ error: 'Link inválido ou expirado' });
  if (Date.now() > record.expires) { delete resetTokens[token]; return res.status(400).json({ error: 'Link expirado. Solicite um novo.' }); }
  const user = cache.users[record.userId]; if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.password = await bcrypt.hash(password, 10);
  delete resetTokens[token];
  saveUser(user);
  res.json({ success: true, message: 'Senha redefinida com sucesso! Faça login.' });
});

app.get('/api/reset-token/:token', (req, res) => {
  const record = resetTokens[req.params.token];
  if (!record || Date.now() > record.expires) return res.status(400).json({ valid: false });
  res.json({ valid: true });
});

app.get('/api/user/recovery-emails', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const user = cache.users[userId]; if (!user) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ primaryEmail: user.email, recoveryEmails: user.recoveryEmails || [] });
});

app.post('/api/user/recovery-emails/add', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { recoveryEmail } = req.body; if (!recoveryEmail?.includes('@')) return res.status(400).json({ error: 'Email inválido' });
  const user = cache.users[userId]; if (!user.recoveryEmails) user.recoveryEmails = [];
  const normalized = recoveryEmail.toLowerCase().trim();
  if (user.recoveryEmails.includes(normalized)) return res.status(400).json({ error: 'Email já adicionado' });
  user.recoveryEmails.push(normalized);
  saveUser(user);
  res.json({ success: true, recoveryEmails: user.recoveryEmails });
});

app.post('/api/user/recovery-emails/remove', (req, res) => {
  const userId = req.session.userId; if (!userId) return res.status(401).json({ error: 'Não autenticado' });
  const { recoveryEmail } = req.body;
  const user = cache.users[userId]; if (!user.recoveryEmails) user.recoveryEmails = [];
  user.recoveryEmails = user.recoveryEmails.filter(e => e !== recoveryEmail.toLowerCase().trim());
  saveUser(user);
  res.json({ success: true, recoveryEmails: user.recoveryEmails });
});

app.post('/api/forgot-password-to-email', async (req, res) => {
  const { email, targetEmail } = req.body;
  const userId = cache.usersByEmail[email?.toLowerCase().trim()];
  if (!userId) return res.json({ success: true, message: 'Se o email estiver cadastrado, você receberá instruções.' });
  const user = cache.users[userId];
  const validEmails = [user.email, ...(user.recoveryEmails || [])];
  if (!validEmails.includes(targetEmail?.toLowerCase().trim())) return res.status(400).json({ error: 'Email de destino não configurado' });
  const token = uuidv4() + uuidv4();
  resetTokens[token] = { userId, expires: Date.now() + 3600000 };
  try { await sendPasswordResetEmail(targetEmail, token); } catch(e) {}
  res.json({ success: true, message: `Link enviado para ${targetEmail}` });
});

// ─── SOCKET.IO ───────────────────────────────────────────────
const connectedUsers = {};

io.on('connection', (socket) => {
  socket.on('auth', ({ userId }) => {
    if (!cache.users[userId]) return;
    socket.userId = userId;
    socket.join(`user_${userId}`);
    if (!connectedUsers[userId]) connectedUsers[userId] = new Set();
    connectedUsers[userId].add(socket.id);
    const user = cache.users[userId];
    user.status = 'online';
    user.lastSeen = new Date().toISOString();
    saveUser(user);
    (user.groups || []).forEach(gId => socket.join(`group_${gId}`));
    io.emit('user_status', { userId, status: 'online' });
    io.emit('user_updated', { userId, status: 'online', lastSeen: user.lastSeen });
    const pending = (cache.friendRequests[userId] || []).length;
    if (pending > 0) socket.emit('pending_requests', { count: pending });
  });

  socket.on('send_message', (data) => {
    const { to, text, type = 'text', chatId, replyTo, url } = data;
    const userId = socket.userId;
    if (!userId) return;
    if (type === 'text' && !text?.trim()) return;
    if (type === 'sticker' && !url) return;
    const user = cache.users[userId]; if (!user) return;
    const msgId = uuidv4(); const timestamp = new Date().toISOString();
    const message = { id: msgId, from: userId, to, fromName: user.name, fromAvatar: user.avatar, senderName: user.name, text: (text || '').trim(), url: url || null, type, timestamp, read: false, status: 'sent', chatId, reactions: {}, replyTo: replyTo || null, edited: false };
    if (!cache.messages[chatId]) cache.messages[chatId] = [];
    cache.messages[chatId].push(message);
    saveMessage(chatId, message);
    if (!chatId.startsWith('group_')) { socket.emit('message', message); io.to(`user_${to}`).emit('message', message); }
    else { io.to(chatId).emit('message', message); }
  });

  socket.on('typing', ({ chatId, isTyping }) => {
    const userId = socket.userId; if (!userId) return;
    const user = cache.users[userId]; if (!user) return;
    if (chatId.startsWith('group_')) socket.to(chatId).emit('typing', { userId, name: user.name, chatId, isTyping });
    else { const otherId = chatId.split('_').find(id => id !== userId); if (otherId) io.to(`user_${otherId}`).emit('typing', { userId, name: user.name, chatId, isTyping }); }
  });

  socket.on('message_read', ({ chatId, messageIds }) => {
    const msgs = cache.messages[chatId] || [];
    const readIds = [];
    msgs.forEach(m => {
      if (messageIds.includes(m.id)) {
        if (!m.read) {
          m.read = true;
          m.status = 'read';
          m.readAt = new Date().toISOString();
          saveMessage(chatId, m);
          readIds.push(m.id);
        }
      }
    });
    if (readIds.length > 0) {
      io.to(chatId).emit('messages_read', { chatId, messageIds: readIds, readBy: socket.userId });
      if (!chatId.startsWith('group_')) {
        const otherId = chatId.split('_').find(id => id !== socket.userId);
        if (otherId) io.to('user_' + otherId).emit('messages_read', { chatId, messageIds: readIds, readBy: socket.userId });
      }
    }
  });

  socket.on('join_group', ({ groupId }) => socket.join(`group_${groupId}`));

  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (userId) {
      if (connectedUsers[userId]) {
        connectedUsers[userId].delete(socket.id);
        if (connectedUsers[userId].size === 0) {
          delete connectedUsers[userId];
          if (cache.users[userId]) { cache.users[userId].status = 'offline'; saveUser(cache.users[userId]); }
          io.emit('user_status', { userId, status: 'offline' });
        }
      }
    }
  });
});

// ─── START ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

connectMongo().then(() => {
  server.listen(PORT, () => { console.log(`\n  NexChat running at http://localhost:${PORT}\n`); });
});
// ─── GOOGLE OAUTH ────────────────────────────────────────────
// Rota: redireciona para o Google
app.get('/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).send('GOOGLE_CLIENT_ID não configurado.');
  const redirectUri = encodeURIComponent(`${appUrl}/auth/google/callback`);
  const scope = encodeURIComponent('openid email profile');
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&prompt=select_account`);
});

// Rota: callback do Google após login
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?google_error=1');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${appUrl}/auth/google/callback`;

  try {
    // 1. Trocar código por access_token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?google_error=1');

    // 2. Buscar dados do usuário no Google
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    const { id: googleId, email, name, picture } = profile;
    if (!email) return res.redirect('/?google_error=1');

    // 3. Verificar se usuário já existe (por email ou googleId)
    let userId = cache.usersByEmail[email];
    if (userId) {
      // Usuário já existe — vincular googleId se ainda não tiver
      const user = cache.users[userId];
      if (!user.googleId) { user.googleId = googleId; saveUser(user); }
      if (picture && !user.avatar) { user.avatar = picture; saveUser(user); }
    } else {
      // Novo usuário — criar conta automaticamente
      userId = uuidv4();
      const friendCode = generateFriendCode();
      const user = {
        id: userId, name, email,
        password: null, // sem senha (login só pelo Google)
        googleId,
        friendCode,
        avatar: picture || null,
        bio: '', status: 'online', friends: [], groups: [],
        createdAt: new Date().toISOString(),
        customNames: {}, securityQuestions: null,
        twoFactorEnabled: false, twoFactorSecret: null,
        recoveryMethods: ['email'], recoveryEmails: []
      };
      cache.users[userId] = user;
      cache.usersByEmail[email] = userId;
      cache.usersByCode[friendCode] = userId;
      cache.friendRequests[userId] = [];
      saveUser(user);
    }

    // 4. Criar sessão e redirecionar para o app
    req.session.userId = userId;
    const user = cache.users[userId];
    user.status = 'online';
    saveUser(user);
    res.redirect('/');
  } catch (e) {
    console.error('[Google OAuth]', e.message);
    res.redirect('/?google_error=1');
  }
});
