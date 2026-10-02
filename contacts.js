const fs = require('fs');
const path = require('path');
const { userStore } = require('./auth');

const DATA_DIR = path.join(__dirname, 'data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

class ContactManager {
  constructor() {
    this.requests = new Map(); // id -> { id, requesterId, recipientId, status: 'pending'|'accepted'|'rejected', createdAt, updatedAt }
    this.loadContacts();
  }

  loadContacts() {
    try {
      if (fs.existsSync(CONTACTS_FILE)) {
        const raw = fs.readFileSync(CONTACTS_FILE, 'utf8');
        const list = JSON.parse(raw);
        list.forEach(req => this.requests.set(req.id, req));
        console.log(`[Contacts] Loaded ${this.requests.size} contact relations from disk.`);
      }
    } catch (err) {
      console.error('[Contacts] Failed to load contacts from disk:', err);
    }
  }

  saveContacts() {
    try {
      const list = Array.from(this.requests.values());
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.error('[Contacts] Failed to save contacts:', err);
    }
  }

  findRequest(userId1, userId2) {
    for (const req of this.requests.values()) {
      if (
        (req.requesterId === userId1 && req.recipientId === userId2) ||
        (req.requesterId === userId2 && req.recipientId === userId1)
      ) {
        return req;
      }
    }
    return null;
  }

  areContacts(userId1, userId2) {
    if (!userId1 || !userId2) return false;
    if (userId1 === userId2) return true; // Self interaction
    const req = this.findRequest(userId1, userId2);
    return !!(req && req.status === 'accepted');
  }

  getRelationshipStatus(userId, otherUserId) {
    const req = this.findRequest(userId, otherUserId);
    if (!req) return 'none';
    if (req.status === 'accepted') return 'accepted';
    if (req.status === 'rejected') return 'rejected';
    if (req.status === 'pending') {
      return req.requesterId === userId ? 'pending_sent' : 'pending_received';
    }
    return 'none';
  }

  sendRequest(requesterId, targetIdentifier) {
    if (!requesterId || !targetIdentifier) {
      throw new Error('Missing requester or target identifier.');
    }

    const trimmed = String(targetIdentifier).trim();
    const lower = trimmed.toLowerCase();
    
    // Find recipient by exact ID, or username, or email
    let recipient = userStore.findUserById(trimmed);
    if (!recipient) recipient = userStore.findUserByUsername(lower);
    if (!recipient) recipient = userStore.findUserByEmail(lower);

    if (!recipient) {
      throw new Error(`User "${targetIdentifier}" not found.`);
    }

    if (recipient.id === requesterId) {
      throw new Error('You cannot add yourself as a contact.');
    }

    let existing = this.findRequest(requesterId, recipient.id);

    if (existing) {
      if (existing.status === 'accepted') {
        throw new Error(`You and ${recipient.username} are already connected contacts.`);
      }
      if (existing.status === 'pending') {
        if (existing.requesterId === requesterId) {
          throw new Error('A contact request has already been sent and is awaiting approval.');
        } else {
          // If the other user already sent a pending request to this user, auto-accept it!
          existing.status = 'accepted';
          existing.updatedAt = Date.now();
          this.saveContacts();
          return { request: existing, recipient, autoAccepted: true };
        }
      }
      if (existing.status === 'rejected') {
        // Allow re-requesting if previously rejected
        existing.requesterId = requesterId;
        existing.recipientId = recipient.id;
        existing.status = 'pending';
        existing.updatedAt = Date.now();
        this.saveContacts();
        return { request: existing, recipient, autoAccepted: false };
      }
    }

    const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
    const newRequest = {
      id: requestId,
      requesterId,
      recipientId: recipient.id,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.requests.set(requestId, newRequest);
    this.saveContacts();

    return { request: newRequest, recipient, autoAccepted: false };
  }

  respondRequest(requestId, recipientId, action) {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new Error('Contact request not found.');
    }

    if (req.recipientId !== recipientId) {
      throw new Error('Unauthorized to respond to this request.');
    }

    if (action !== 'accept' && action !== 'reject') {
      throw new Error('Invalid action. Must be "accept" or "reject".');
    }

    req.status = action === 'accept' ? 'accepted' : 'rejected';
    req.updatedAt = Date.now();
    this.saveContacts();

    const requester = userStore.findUserById(req.requesterId);
    const recipient = userStore.findUserById(req.recipientId);

    return {
      request: req,
      requester: requester ? userStore.sanitizeUser(requester) : null,
      recipient: recipient ? userStore.sanitizeUser(recipient) : null
    };
  }

  getUserContacts(userId) {
    const contacts = [];
    for (const req of this.requests.values()) {
      if (req.status === 'accepted') {
        if (req.requesterId === userId) {
          const user = userStore.findUserById(req.recipientId);
          if (user) contacts.push(userStore.sanitizeUser(user));
        } else if (req.recipientId === userId) {
          const user = userStore.findUserById(req.requesterId);
          if (user) contacts.push(userStore.sanitizeUser(user));
        }
      }
    }
    return contacts;
  }

  getPendingRequests(userId) {
    const incoming = [];
    const outgoing = [];

    for (const req of this.requests.values()) {
      if (req.status === 'pending') {
        if (req.recipientId === userId) {
          const requester = userStore.findUserById(req.requesterId);
          if (requester) {
            incoming.push({
              requestId: req.id,
              user: userStore.sanitizeUser(requester),
              createdAt: req.createdAt
            });
          }
        } else if (req.requesterId === userId) {
          const recipient = userStore.findUserById(req.recipientId);
          if (recipient) {
            outgoing.push({
              requestId: req.id,
              user: userStore.sanitizeUser(recipient),
              createdAt: req.createdAt
            });
          }
        }
      }
    }

    return { incoming, outgoing };
  }

  searchUsers(query, currentUserId) {
    const q = (query || '').toLowerCase().trim();
    const results = [];

    for (const u of userStore.users.values()) {
      if (u.id === currentUserId) continue; // Skip self

      const matchUsername = u.username && u.username.toLowerCase().includes(q);
      const matchEmail = u.email && u.email.toLowerCase().includes(q);

      if (!q || matchUsername || matchEmail) {
        const relation = this.getRelationshipStatus(currentUserId, u.id);
        const req = this.findRequest(currentUserId, u.id);
        results.push({
          ...userStore.sanitizeUser(u),
          relationship: relation,
          requestId: req ? req.id : null
        });
      }
    }

    return results;
  }
}

const contactManager = new ContactManager();

module.exports = {
  contactManager
};
