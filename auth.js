const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'chatq_super_secret_jwt_key_98234710923847102938';

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize Clerk client if secret key is present
let clerkClient = null;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || '';
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '';

if (CLERK_SECRET_KEY) {
  try {
    const { createClerkClient } = require('@clerk/backend');
    clerkClient = createClerkClient({ secretKey: CLERK_SECRET_KEY });
    console.log('[Auth] Clerk Backend SDK initialized successfully.');
  } catch (err) {
    console.warn('[Auth] Clerk SDK failed to initialize:', err.message);
  }
}

// Persistent user database helper
class UserStore {
  constructor() {
    this.users = new Map(); // id -> user
    this.loadUsers();
  }

  loadUsers() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const raw = fs.readFileSync(USERS_FILE, 'utf8');
        const list = JSON.parse(raw);
        list.forEach(u => this.users.set(u.id, u));
        console.log(`[Auth] Loaded ${this.users.size} registered users from disk.`);
      } else {
        this.seedDemoUsers();
      }
    } catch (err) {
      console.error('[Auth] Failed to load users, seeding defaults:', err);
      this.seedDemoUsers();
    }
  }

  saveUsers() {
    try {
      const list = Array.from(this.users.values());
      fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.error('[Auth] Failed to persist users:', err);
    }
  }

  seedDemoUsers() {
    const defaultPasswordHash = bcrypt.hashSync('Password123!', 10);
    const demos = [
      {
        id: 'u_alice_demo',
        username: 'Alice',
        email: 'alice@chatq.io',
        passwordHash: defaultPasswordHash,
        avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Alice',
        createdAt: Date.now()
      },
      {
        id: 'u_bob_demo',
        username: 'Bob',
        email: 'bob@chatq.io',
        passwordHash: defaultPasswordHash,
        avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Bob',
        createdAt: Date.now()
      },
      {
        id: 'u_charlie_demo',
        username: 'Charlie',
        email: 'charlie@chatq.io',
        passwordHash: defaultPasswordHash,
        avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Charlie',
        createdAt: Date.now()
      }
    ];

    demos.forEach(u => this.users.set(u.id, u));
    this.saveUsers();
    console.log('[Auth] Initialized default demo users (Alice, Bob, Charlie with password: Password123!)');
  }

  findUserByEmail(email) {
    if (!email) return null;
    const lower = email.toLowerCase().trim();
    for (const u of this.users.values()) {
      if (u.email && u.email.toLowerCase() === lower) return u;
    }
    return null;
  }

  findUserByUsername(username) {
    if (!username) return null;
    const lower = username.toLowerCase().trim();
    for (const u of this.users.values()) {
      if (u.username && u.username.toLowerCase() === lower) return u;
    }
    return null;
  }

  findUserById(id) {
    return this.users.get(id) || null;
  }

  findUserByClerkId(clerkId) {
    for (const u of this.users.values()) {
      if (u.clerkId === clerkId) return u;
    }
    return null;
  }

  async registerUser({ username, email, password, avatar }) {
    if (!username || username.trim().length < 2) {
      throw new Error('Username must be at least 2 characters long.');
    }
    if (!email || !email.includes('@')) {
      throw new Error('Please provide a valid email address.');
    }
    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters long.');
    }

    if (this.findUserByEmail(email)) {
      throw new Error('An account with this email already exists.');
    }
    if (this.findUserByUsername(username)) {
      throw new Error('Username is already taken. Please choose another.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);

    const newUser = {
      id: userId,
      username: username.trim(),
      email: email.toLowerCase().trim(),
      passwordHash,
      avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username.trim())}`,
      createdAt: Date.now()
    };

    this.users.set(userId, newUser);
    this.saveUsers();

    return this.sanitizeUser(newUser);
  }

  async loginUser(emailOrUsername, password) {
    if (!emailOrUsername || !password) {
      throw new Error('Please provide your email/username and password.');
    }

    let user = this.findUserByEmail(emailOrUsername);
    if (!user) {
      user = this.findUserByUsername(emailOrUsername);
    }

    if (!user || !user.passwordHash) {
      throw new Error('Invalid email/username or password.');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new Error('Invalid email/username or password.');
    }

    return this.sanitizeUser(user);
  }

  syncClerkUser({ clerkId, email, username, avatar }) {
    let user = this.findUserByClerkId(clerkId);
    if (!user && email) {
      user = this.findUserByEmail(email);
    }

    if (user) {
      // Update info
      user.clerkId = clerkId;
      if (avatar) user.avatar = avatar;
      if (username) user.username = username;
      this.saveUsers();
    } else {
      const userId = 'u_clerk_' + clerkId.slice(-8);
      user = {
        id: userId,
        clerkId,
        username: username || 'User_' + clerkId.slice(-4),
        email: email || `${clerkId}@clerk.user`,
        avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${clerkId}`,
        createdAt: Date.now()
      };
      this.users.set(userId, user);
      this.saveUsers();
    }

    return this.sanitizeUser(user);
  }

  generateToken(user) {
    return jwt.sign(
      {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
  }

  async verifyToken(token) {
    if (!token) throw new Error('No authentication token provided');

    // 1. First attempt verifying as local signed JWT
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = this.findUserById(decoded.id);
      if (user) return this.sanitizeUser(user);
    } catch (e) {
      // If local JWT fails, check Clerk if enabled
    }

    // 2. If Clerk is configured, check with Clerk
    if (clerkClient) {
      try {
        const decoded = await clerkClient.verifyToken(token);
        if (decoded && decoded.sub) {
          const user = this.findUserByClerkId(decoded.sub);
          if (user) return this.sanitizeUser(user);
        }
      } catch (err) {
        // Clerk verification also failed
      }
    }

    throw new Error('Invalid or expired authentication session');
  }

  sanitizeUser(user) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
      createdAt: user.createdAt,
      isClerk: !!user.clerkId
    };
  }
}

const userStore = new UserStore();

module.exports = {
  userStore,
  CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY,
  isClerkConfigured: !!(CLERK_PUBLISHABLE_KEY && CLERK_SECRET_KEY)
};
