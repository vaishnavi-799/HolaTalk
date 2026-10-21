require('dotenv').config();
console.log('Starting PrivateChat...');
console.log('Node version:', process.version);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('MONGO_URI configured:', Boolean(process.env.MONGO_URI));
console.log('JWT_SECRET configured:', Boolean(process.env.JWT_SECRET));
console.log('PORT:', process.env.PORT || 'default');
const path = require('path'), fs = require('fs'), crypto = require('crypto'), http = require('http');
const express = require('express'), { Server } = require('socket.io'), mongoose = require('mongoose');
const bcrypt = require('bcrypt'), jwt = require('jsonwebtoken'), cookie = require('cookie');
const helmet = require('helmet'), rateLimit = require('express-rate-limit'), cookieParser = require('cookie-parser'), multer = require('multer');
const { MONGO_URI, JWT_SECRET, PORT = 3000, UPLOAD_DIR = 'uploads' } = process.env;
if (!MONGO_URI || !JWT_SECRET) { console.error('Create .env from .env.example first.'); process.exit(1); }
const prod = process.env.NODE_ENV === 'production';
const UP = path.resolve(UPLOAD_DIR);
const { Schema, model } = mongoose, oid = { type: Schema.Types.ObjectId, ref: 'User' };

// ---- Models ----
const User = model('User', new Schema({
  username: { type: String, required: true, unique: true, lowercase: true },
  displayName: { type: String, required: true, maxlength: 40 },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true }, profilePicture: String }, { timestamps: true }));
const convSchema = new Schema({ participants: { type: [oid], validate: v => v.length === 2 }, lastMessage: String, lastMessageAt: Date }, { timestamps: true });
convSchema.index({ participants: 1 });
const Conv = model('Conversation', convSchema);
const msgSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true }, senderId: { ...oid, required: true },
  type: { type: String, enum: ['text', 'image', 'video', 'location'], required: true }, text: String,
  media: { id: String, kind: String, ext: String, mime: String, name: String },
  location: { lat: Number, lng: Number }, clientId: String, deliveredAt: Date }, { timestamps: { createdAt: true, updatedAt: false } });
msgSchema.index({ conversationId: 1, createdAt: -1 });
msgSchema.index({ senderId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
msgSchema.index({ 'media.id': 1 }, { sparse: true });
const Message = model('Message', msgSchema);
const Session = model('Session', new Schema({ jti: { type: String, unique: true }, userId: oid, expiresAt: { type: Date, expires: 0 } }));

// ---- Helpers ----
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const wrap = f => (q, s, n) => Promise.resolve(f(q, s, n)).catch(n);
const pub = u => ({ id: u._id, username: u.username, displayName: u.displayName });
const dto = m => ({ id: m._id, conversationId: m.conversationId, senderId: m.senderId, type: m.type, text: m.text, location: m.location,
  media: m.media && m.media.id ? { id: m.media.id, kind: m.media.kind, name: m.media.name } : undefined, createdAt: m.createdAt, deliveredAt: m.deliveredAt });
const member = async (id, uid) => mongoose.isValidObjectId(id) ? Conv.findOne({ _id: id, participants: uid }) : null;
const verify = async t => { try { const p = jwt.verify(t, JWT_SECRET); return (await Session.exists({ jti: p.jti })) ? p : null; } catch { return null; } };
const login = async (res, uid) => {
  const jti = crypto.randomUUID();
  await Session.create({ jti, userId: uid, expiresAt: new Date(Date.now() + 7 * 864e5) });
  res.cookie('token', jwt.sign({ sub: String(uid), jti }, JWT_SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'strict', secure: prod, maxAge: 7 * 864e5 });
};
const auth = wrap(async (req, res, next) => {
  const p = await verify(req.cookies.token); if (!p) throw bad('Please log in', 401);
  req.uid = p.sub; req.jti = p.jti; next(); });

// ---- App / Socket setup ----
const app = express(), server = http.createServer(app), io = new Server(server), online = new Map();
if (prod) app.set('trust proxy', 1);
const cdn = 'https://cdn.jsdelivr.net';
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", cdn], styleSrc: ["'self'", cdn],
  imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'", cdn] } } }));
app.use(express.json({ limit: '50kb' }), cookieParser());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 6e4, limit: 20 }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 6e4, limit: 20 }));
app.use('/api', rateLimit({ windowMs: 6e4, limit: 300 }));

async function createMessage(uid, conv, d) {
  const m = { conversationId: conv._id, senderId: uid, type: d.type, clientId: typeof d.clientId === 'string' ? d.clientId.slice(0, 64) : undefined };
  let preview;
  if (d.type === 'text') {
    const t = typeof d.text === 'string' ? d.text.trim() : '';
    if (!t || t.length > 2000) throw bad('Message must be 1-2000 characters');
    m.text = t; preview = t.slice(0, 60);
  } else if (d.type === 'location') {
    const { lat, lng } = d.location || {};
    if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw bad('Invalid location');
    m.location = { lat, lng }; preview = '📍 Location';
  } else if ((d.type === 'image' || d.type === 'video') && d.media) { m.media = d.media; preview = d.type === 'image' ? '📷 Photo' : '🎥 Video'; }
  else throw bad('Unsupported message type');
  let msg;
  try { msg = await Message.create(m); }
  catch (e) { if (e.code === 11000 && m.clientId) return Message.findOne({ senderId: uid, clientId: m.clientId }); throw e; }
  const other = String(conv.participants.find(p => String(p) !== String(uid)));
  if (online.has(other)) { msg.deliveredAt = new Date(); await msg.save(); }
  await Conv.updateOne({ _id: conv._id }, { lastMessage: preview, lastMessageAt: msg.createdAt });
  io.to('u:' + uid).to('u:' + other).emit('message:new', dto(msg));
  return msg;
}

// ---- Auth routes ----
app.post('/api/auth/register', wrap(async (req, res) => {
  const { username, displayName, email, password, confirmPassword } = req.body || {};
  if ([username, displayName, email, password].some(v => typeof v !== 'string' || !v.trim())) throw bad('All fields are required');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw bad('Username: 3-20 letters, numbers or underscores');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Invalid email address');
  if (password !== confirmPassword) throw bad('Passwords do not match');
  if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) throw bad('Password needs 8+ characters with upper-case, lower-case and a number');
  let u;
  try { u = await User.create({ username, displayName: displayName.trim().slice(0, 40), email, passwordHash: await bcrypt.hash(password, 12) }); }
  catch (e) { if (e.code === 11000) throw bad('Username or email already registered', 409); throw e; }
  await login(res, u._id); res.status(201).json({ user: pub(u) });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = typeof username === 'string' && typeof password === 'string' && await User.findOne({ username: username.toLowerCase() });
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) throw bad('Invalid username or password', 401);
  await login(res, u._id); res.json({ user: pub(u) });
}));
app.post('/api/auth/logout', auth, wrap(async (req, res) => { await Session.deleteOne({ jti: req.jti }); res.clearCookie('token'); res.json({ ok: true }); }));
app.get('/api/auth/me', auth, wrap(async (req, res) => { const u = await User.findById(req.uid); if (!u) throw bad('Please log in', 401); res.json({ user: pub(u) }); }));

// ---- Users ----
app.get('/api/users/search', auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 30); if (q.length < 2) return res.json({ users: [] });
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const users = await User.find({ _id: { $ne: req.uid }, $or: [{ username: re }, { displayName: re }] }).limit(10);
  res.json({ users: users.map(pub) });
}));
app.get('/api/users/:id', auth, wrap(async (req, res) => {
  const u = mongoose.isValidObjectId(req.params.id) && await User.findById(req.params.id); if (!u) throw bad('User not found', 404); res.json({ user: pub(u) }); }));

// ---- Conversations ----
const shape = (c, uid) => ({ id: c._id, other: pub(c.participants.find(p => String(p._id) !== String(uid))), lastMessage: c.lastMessage, lastMessageAt: c.lastMessageAt });
app.post('/api/conversations', auth, wrap(async (req, res) => {
  const { userId } = req.body || {};
  if (!mongoose.isValidObjectId(userId) || userId === req.uid || !(await User.exists({ _id: userId }))) throw bad('Invalid user');
  let c = await Conv.findOne({ participants: { $all: [req.uid, userId] } });
  if (!c) c = await Conv.create({ participants: [req.uid, userId] });
  res.status(201).json({ conversation: shape(await c.populate('participants'), req.uid) });
}));
app.get('/api/conversations', auth, wrap(async (req, res) => {
  const cs = await Conv.find({ participants: req.uid }).sort({ lastMessageAt: -1, createdAt: -1 }).populate('participants');
  res.json({ conversations: cs.map(c => shape(c, req.uid)) });
}));
app.get('/api/conversations/:id', auth, wrap(async (req, res) => {
  const c = await member(req.params.id, req.uid); if (!c) throw bad('Conversation not found', 404);
  res.json({ conversation: shape(await c.populate('participants'), req.uid) }); }));

// ---- Messages ----
app.get('/api/conversations/:id/messages', auth, wrap(async (req, res) => {
  const c = await member(req.params.id, req.uid); if (!c) throw bad('Conversation not found', 404);
  const limit = Math.min(parseInt(req.query.limit) || 30, 100), f = { conversationId: c._id };
  if (req.query.before && !isNaN(Date.parse(req.query.before))) f.createdAt = { $lt: new Date(req.query.before) };
  const ms = await Message.find(f).sort({ createdAt: -1 }).limit(limit);
  res.json({ messages: ms.map(dto), hasMore: ms.length === limit });
}));
app.post('/api/conversations/:id/messages', auth, wrap(async (req, res) => {
  const c = await member(req.params.id, req.uid); if (!c) throw bad('Conversation not found', 404);
  const { type, text, location, clientId } = req.body || {};
  res.status(201).json({ message: dto(await createMessage(req.uid, c, { type, text, location, clientId })) });
}));

// ---- Media (local storage; swap this section for S3/Cloudinary later) ----
const sniff = b => {
  const at = (o, s) => b.subarray(o, o + s.length).toString('latin1') === s;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', ext: '.jpg', mime: 'image/jpeg' };
  if (b[0] === 0x89 && at(1, 'PNG')) return { kind: 'image', ext: '.png', mime: 'image/png' };
  if (at(0, 'GIF8')) return { kind: 'image', ext: '.gif', mime: 'image/gif' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { kind: 'image', ext: '.webp', mime: 'image/webp' };
  if (at(4, 'ftyp')) return { kind: 'video', ext: '.mp4', mime: 'video/mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', ext: '.webm', mime: 'video/webm' };
  return null;
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
app.post('/api/conversations/:id/media', auth, wrap(async (req, res) => {
  const c = await member(req.params.id, req.uid); if (!c) throw bad('Conversation not found', 404);
  await new Promise((ok, no) => upload.single('file')(req, res, e => e ? no(e) : ok()));
  if (!req.file) throw bad('No file uploaded');
  const t = sniff(req.file.buffer); if (!t) throw bad('Unsupported file type (JPEG, PNG, GIF, WebP, MP4, WebM only)', 415);
  const id = crypto.randomUUID(), dir = path.join(UP, t.kind === 'image' ? 'photos' : 'videos');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, id + t.ext), req.file.buffer);
  const name = path.basename(req.file.originalname || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 80);
  const m = await createMessage(req.uid, c, { type: t.kind, media: { id, kind: t.kind, ext: t.ext, mime: t.mime, name }, clientId: req.body.clientId });
  res.status(201).json({ message: dto(m) });
}));
app.get('/api/media/:mediaId', auth, wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.mediaId)) throw bad('Media not found', 404);
  const m = await Message.findOne({ 'media.id': req.params.mediaId });
  if (!m || !(await member(m.conversationId, req.uid))) throw bad('Media not found', 404);
  const file = path.join(UP, m.media.kind === 'image' ? 'photos' : 'videos', m.media.id + m.media.ext);
  if (!fs.existsSync(file)) throw bad('File is missing from storage', 404);
  res.set({ 'Content-Type': m.media.mime, 'Cache-Control': 'private, max-age=3600' });
  if (req.query.download) res.attachment(m.media.name);
  res.sendFile(file);
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((e, req, res, next) => {
  const status = e.code === 'LIMIT_FILE_SIZE' ? 413 : e.status || (e.name === 'ValidationError' ? 400 : 500);
  if (status === 500) console.error('Server error:', e.message);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : e.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB)' : e.message });
});

// ---- Socket.IO ----
io.use(async (s, next) => {
  const p = await verify(cookie.parse(s.handshake.headers.cookie || '').token);
  if (!p) return next(new Error('unauthorized')); s.uid = p.sub; next(); });
io.on('connection', s => {
  s.join('u:' + s.uid);
  online.set(s.uid, (online.get(s.uid) || 0) + 1);
  if (online.get(s.uid) === 1) io.emit('user:online', s.uid);
  s.emit('presence', [...online.keys()]);
  s.on('message:send', async (d, ack) => {
    try {
      const c = await member(d && d.conversationId, s.uid); if (!c) throw bad('Not allowed', 403);
      const m = await createMessage(s.uid, c, { type: d.type, text: d.text, location: d.location, clientId: d.clientId });
      ack && ack({ ok: true, message: dto(m) });
    } catch (e) { ack && ack({ ok: false, error: e.status ? e.message : 'Could not send' }); }
  });
  s.on('disconnect', () => {
    const n = (online.get(s.uid) || 1) - 1;
    if (n) online.set(s.uid, n); else { online.delete(s.uid); io.emit('user:offline', s.uid); }
  });
});

const port = Number(PORT);

server.listen(port, '0.0.0.0', async () => {
  console.log(`HTTP server listening on port ${port}`);

  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 15000
    });

    console.log('MongoDB connected successfully');
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  }
});

server.on('error', (err) => {
  console.error('Server startup error:', err);
});