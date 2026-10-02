require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { userStore, CLERK_PUBLISHABLE_KEY, isClerkConfigured } = require('./auth');
const { contactManager } = require('./contacts');
const { isCloudinaryConfigured, uploadToCloudinary } = require('./services/cloudinary');
const {
  isSupabaseConfigured,
  persistMessage,
  fetchRoomHistory,
  loadLocalMessages,
  saveLocalMessages
} = require('./services/supabase');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8 // 100 MB max buffer for attachments
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Security: Helmet HTTP Headers (configured for WebRTC, external avatars, Clerk, Supabase & Cloudinary)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://*.clerk.accounts.dev", "https://*.clerk.com"],
      connectSrc: ["'self'", "ws:", "wss:", "http:", "https:", "https://*.clerk.accounts.dev", "https://*.clerk.com", "https://*.supabase.co"],
      imgSrc: ["'self'", "data:", "blob:", "https://api.dicebear.com", "https://images.clerk.dev", "https://*.clerk.com", "https://img.clerk.com", "https://res.cloudinary.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'self'", "https://*.clerk.accounts.dev", "https://*.clerk.com", "https://challenges.cloudflare.com"],
      mediaSrc: ["'self'", "blob:", "data:", "https://res.cloudinary.com"],
      workerSrc: ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(express.json());

// Rate Limiting: Prevent Brute Force Attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many authentication attempts. Please try again later.' }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Upload rate limit reached. Please wait before uploading more files.' }
});

// Static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Authentication Middleware for REST endpoints
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  try {
    const user = await userStore.verifyToken(token);
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: err.message || 'Invalid or expired session' });
  }
}

// ================= AUTH REST APIS =================

app.get('/api/auth/config', (req, res) => {
  res.json({
    clerkEnabled: isClerkConfigured,
    clerkPublishableKey: CLERK_PUBLISHABLE_KEY || null
  });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, avatar } = req.body;
    const user = await userStore.registerUser({ username, email, password, avatar });
    const token = userStore.generateToken(user);
    res.status(201).json({ success: true, user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    const user = await userStore.loginUser(emailOrUsername, password);
    const token = userStore.generateToken(user);
    res.json({ success: true, user, token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/clerk-sync', async (req, res) => {
  try {
    const { clerkId, email, username, avatar } = req.body;
    if (!clerkId) {
      return res.status(400).json({ error: 'Clerk ID is required' });
    }

    const user = userStore.syncClerkUser({ clerkId, email, username, avatar });
    const token = userStore.generateToken(user);
    res.json({ success: true, user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ================= CONTACTS & AUTHORIZATION REST APIS =================

// 1. Get my accepted contacts & pending requests
app.get('/api/contacts', requireAuth, (req, res) => {
  try {
    const contacts = contactManager.getUserContacts(req.user.id);
    const contactsWithPresence = contacts.map(c => {
      const onlineUser = findUserByUserId(c.id);
      return {
        ...c,
        status: onlineUser ? onlineUser.status : 'offline'
      };
    });
    const requests = contactManager.getPendingRequests(req.user.id);
    res.json({ success: true, contacts: contactsWithPresence, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Search users to add as contacts
app.get('/api/contacts/search', requireAuth, (req, res) => {
  try {
    const query = req.query.q || '';
    const results = contactManager.searchUsers(query, req.user.id);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Send contact / friend request
app.post('/api/contacts/request', requireAuth, (req, res) => {
  try {
    const { targetIdentifier } = req.body;
    const result = contactManager.sendRequest(req.user.id, targetIdentifier);
    
    // Broadcast update to recipient socket if online
    const targetSocketId = findSocketIdByUserId(result.recipient.id);
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) sendUserContacts(targetSocket);
      io.to(targetSocketId).emit('contact:request:received', {
        from: req.user,
        request: result.request
      });
    }

    // Refresh requester socket
    const mySockId = findSocketIdByUserId(req.user.id);
    if (mySockId) {
      const mySock = io.sockets.sockets.get(mySockId);
      if (mySock) sendUserContacts(mySock);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Respond to contact request (Accept or Reject)
app.post('/api/contacts/respond', requireAuth, (req, res) => {
  try {
    const { requestId, action } = req.body;
    const result = contactManager.respondRequest(requestId, req.user.id, action);

    // Notify requester if online
    const requesterSocketId = findSocketIdByUserId(result.request.requesterId);
    if (requesterSocketId) {
      const reqSocket = io.sockets.sockets.get(requesterSocketId);
      if (reqSocket) sendUserContacts(reqSocket);
      io.to(requesterSocketId).emit('contact:request:resolved', {
        action,
        user: req.user
      });
    }

    // Refresh recipient
    const recipientSocketId = findSocketIdByUserId(req.user.id);
    if (recipientSocketId) {
      const recSocket = io.sockets.sockets.get(recipientSocketId);
      if (recSocket) sendUserContacts(recSocket);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ================= FILE UPLOAD =================

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const sanitized = path.basename(file.originalname).replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitized}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|pdf|doc|docx|txt|zip/i;
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    if (allowed.test(ext) || allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format'));
    }
  }
});

app.post('/api/upload', uploadLimiter, requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  let fileUrl = `/uploads/${req.file.filename}`;
  let cloudBackup = null;

  if (isCloudinaryConfigured) {
    cloudBackup = await uploadToCloudinary(req.file.path, {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype
    });
    if (cloudBackup && cloudBackup.url) {
      fileUrl = cloudBackup.url;
    }
  }

  res.json({
    success: true,
    file: {
      url: fileUrl,
      filename: req.file.originalname,
      storedName: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedBy: req.user.username,
      cloudinary: Boolean(cloudBackup && cloudBackup.url)
    }
  });
});

// Service Status API (Checks integration state)
app.get('/api/services/status', (req, res) => {
  res.json({
    supabase: isSupabaseConfigured,
    cloudinary: isCloudinaryConfigured,
    clerk: isClerkConfigured
  });
});

// ================= IN-MEMORY CHAT STATE & SOCKET HELPERS =================

// socketId -> { id, username, email, avatar, status: 'online'|'in-call', socketId }
const activeSockets = new Map();
// roomId -> [messageObj]
const messageStore = new Map();

// Initialize messageStore from local backup cache
try {
  const cachedRooms = loadLocalMessages();
  for (const [roomId, msgs] of Object.entries(cachedRooms)) {
    if (Array.isArray(msgs)) {
      messageStore.set(roomId, msgs);
    }
  }
} catch (e) {
  console.warn('[Messages] Could not load initial cache:', e.message);
}

function getDmRoomId(id1, id2) {
  return [id1, id2].sort().join('--');
}

function findSocketIdByUserId(userId) {
  for (const [sockId, u] of activeSockets.entries()) {
    if (u.id === userId) return sockId;
  }
  return null;
}

function findUserByUserId(userId) {
  for (const u of activeSockets.values()) {
    if (u.id === userId) return u;
  }
  return null;
}

function sendUserContacts(socket) {
  if (!socket.user) return;
  const contacts = contactManager.getUserContacts(socket.user.id);
  const contactsWithPresence = contacts.map(c => {
    const onlineUser = findUserByUserId(c.id);
    return {
      ...c,
      status: onlineUser ? onlineUser.status : 'offline'
    };
  });
  const requests = contactManager.getPendingRequests(socket.user.id);
  socket.emit('contacts:data', {
    contacts: contactsWithPresence,
    requests
  });
}

function broadcastAllContacts() {
  for (const socket of io.sockets.sockets.values()) {
    sendUserContacts(socket);
  }
}

// ================= SOCKET.IO AUTHENTICATION MIDDLEWARE =================
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token) {
    console.warn(`[Socket Auth Failed] Unauthorized connection rejected: ${socket.id}`);
    return next(new Error('Authentication token required'));
  }

  try {
    const user = await userStore.verifyToken(token);
    socket.user = user;
    next();
  } catch (err) {
    console.warn(`[Socket Auth Failed] Invalid token from ${socket.id}: ${err.message}`);
    return next(new Error('Authentication invalid: ' + err.message));
  }
});

// ================= REAL-TIME EVENT HANDLERS =================
io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`[Socket Authenticated] ${user.username} (${user.id}) connected via ${socket.id}`);

  // Register active presence
  const sessionUser = {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    email: user.email,
    status: 'online',
    socketId: socket.id
  };
  activeSockets.set(socket.id, sessionUser);
  socket.emit('user:registered', sessionUser);

  // Send user their authorized contacts and pending requests
  sendUserContacts(socket);
  // Notify other contacts of presence
  broadcastAllContacts();

  // Fetch message history (Enforce contacts check for DMs)
  socket.on('chat:history', async ({ targetUserId, roomId }) => {
    if (targetUserId) {
      const isAllowed = contactManager.areContacts(user.id, targetUserId);
      if (!isAllowed) {
        return socket.emit('chat:history', {
          roomId: getDmRoomId(user.id, targetUserId),
          messages: [],
          unauthorized: true,
          message: 'Contact request must be accepted to view or send messages.'
        });
      }
    }

    const actualRoom = roomId || (targetUserId ? getDmRoomId(user.id, targetUserId) : 'general');
    let history = messageStore.get(actualRoom);

    // If memory is empty, check Supabase
    if (!history || history.length === 0) {
      try {
        const cloudHistory = await fetchRoomHistory(actualRoom);
        if (cloudHistory && cloudHistory.length > 0) {
          history = cloudHistory;
          messageStore.set(actualRoom, history);
        }
      } catch (err) {
        console.warn('[Chat History] Cloud query error:', err.message);
      }
    }

    socket.emit('chat:history', { roomId: actualRoom, messages: history || [] });
  });

  // Secure Message Sending (Strict Contact Authorization Check)
  socket.on('chat:message', (payload) => {
    const { targetUserId, roomId, content, type, attachment } = payload;

    // RULE ENFORCEMENT: Only interact if accepted contacts!
    if (targetUserId) {
      const isAllowed = contactManager.areContacts(user.id, targetUserId);
      if (!isAllowed) {
        return socket.emit('chat:error', {
          message: 'Interaction blocked: You must send a contact request and have it accepted before messaging.'
        });
      }
    }

    const actualRoom = roomId || (targetUserId ? getDmRoomId(user.id, targetUserId) : 'general');

    const message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      senderId: user.id,
      senderName: user.username,
      senderAvatar: user.avatar,
      targetUserId: targetUserId || null,
      roomId: actualRoom,
      content: content ? String(content).slice(0, 5000) : '',
      type: type || (attachment ? attachment.type : 'text'),
      attachment: attachment || null,
      timestamp: Date.now()
    };

    if (!messageStore.has(actualRoom)) {
      messageStore.set(actualRoom, []);
    }
    const roomHistory = messageStore.get(actualRoom);
    roomHistory.push(message);
    if (roomHistory.length > 100) roomHistory.shift();

    // Persist to local backup cache and cloud Supabase
    saveLocalMessages(messageStore);
    persistMessage(message);

    if (targetUserId) {
      const recipientSocketId = findSocketIdByUserId(targetUserId);
      socket.emit('chat:message', message);
      if (recipientSocketId && recipientSocketId !== socket.id) {
        io.to(recipientSocketId).emit('chat:message', message);
      }
    } else {
      io.emit('chat:message', message);
    }
  });

  // Typing indicator (Only if contacts)
  socket.on('chat:typing', ({ targetUserId, isTyping }) => {
    if (!targetUserId) return;
    if (!contactManager.areContacts(user.id, targetUserId)) return;

    const targetSocketId = findSocketIdByUserId(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('chat:typing', {
        userId: user.id,
        username: user.username,
        isTyping: !!isTyping
      });
    }
  });

  // Request fresh contacts data
  socket.on('contacts:refresh', () => {
    sendUserContacts(socket);
  });

  // ================= WEBRTC CALL SIGNALING (Strict Contact Authorization) =================

  socket.on('call:initiate', ({ targetUserId, type }) => {
    // RULE ENFORCEMENT: Calling strictly requires accepted contact status!
    const isAllowed = contactManager.areContacts(user.id, targetUserId);
    if (!isAllowed) {
      return socket.emit('call:failed', {
        reason: 'Interaction blocked: You must be accepted contacts to make audio or video calls.'
      });
    }

    const targetSocketId = findSocketIdByUserId(targetUserId);
    const targetUser = findUserByUserId(targetUserId);

    if (!targetSocketId || !targetUser) {
      return socket.emit('call:failed', { reason: 'User is currently offline' });
    }

    if (targetUser.status === 'in-call') {
      return socket.emit('call:busy', { targetUser });
    }

    io.to(targetSocketId).emit('call:incoming', {
      caller: {
        id: user.id,
        username: user.username,
        avatar: user.avatar
      },
      type: type || 'video'
    });
  });

  socket.on('call:accept', ({ targetUserId, type }) => {
    const callee = activeSockets.get(socket.id);
    if (!callee) return;

    const callerSocketId = findSocketIdByUserId(targetUserId);
    if (!callerSocketId) return;

    callee.status = 'in-call';
    const caller = findUserByUserId(targetUserId);
    if (caller) caller.status = 'in-call';
    broadcastAllContacts();

    io.to(callerSocketId).emit('call:accepted', {
      callee: {
        id: callee.id,
        username: callee.username,
        avatar: callee.avatar
      },
      type
    });
  });

  socket.on('call:reject', ({ targetUserId, reason }) => {
    const callerSocketId = findSocketIdByUserId(targetUserId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call:rejected', {
        reason: reason || 'Call declined'
      });
    }
  });

  socket.on('call:end', ({ targetUserId }) => {
    const current = activeSockets.get(socket.id);
    if (current) current.status = 'online';

    const peer = findUserByUserId(targetUserId);
    if (peer) peer.status = 'online';
    broadcastAllContacts();

    const peerSocketId = findSocketIdByUserId(targetUserId);
    if (peerSocketId) {
      io.to(peerSocketId).emit('call:ended');
    }
  });

  socket.on('webrtc:offer', ({ targetUserId, offer }) => {
    if (!contactManager.areContacts(user.id, targetUserId)) return;
    const targetSocketId = findSocketIdByUserId(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc:offer', {
        fromUserId: user.id,
        offer
      });
    }
  });

  socket.on('webrtc:answer', ({ targetUserId, answer }) => {
    if (!contactManager.areContacts(user.id, targetUserId)) return;
    const targetSocketId = findSocketIdByUserId(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc:answer', {
        fromUserId: user.id,
        answer
      });
    }
  });

  socket.on('webrtc:ice-candidate', ({ targetUserId, candidate }) => {
    if (!contactManager.areContacts(user.id, targetUserId)) return;
    const targetSocketId = findSocketIdByUserId(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc:ice-candidate', {
        fromUserId: user.id,
        candidate
      });
    }
  });

  // Clean Disconnect
  socket.on('disconnect', () => {
    const leaving = activeSockets.get(socket.id);
    if (leaving) {
      console.log(`[User Disconnected] ${leaving.username}`);
      activeSockets.delete(socket.id);
      broadcastAllContacts();
    }
  });
});

server.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(` ChatQ Platform running at http://localhost:${PORT}`);
  console.log(` Contact & Authorization System: ACTIVE`);
  console.log(` WebRTC & Media interaction requires mutual contact approval`);
  console.log(`===========================================================`);
});
