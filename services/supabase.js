const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);
let supabaseClient = null;

if (isSupabaseConfigured) {
  try {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log(`[Supabase] Connected to project at "${SUPABASE_URL}". Chat history database is ACTIVE.`);
  } catch (err) {
    console.error('[Supabase] Initialization error:', err.message);
  }
} else {
  console.log('[Supabase] Credentials not set. Local persistent storage active for chat history.');
}

// Local messages JSON backup file path
const DATA_DIR = path.join(__dirname, '..', 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load local chat history cache from disk
 */
function loadLocalMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const raw = fs.readFileSync(MESSAGES_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log(`[Messages] Loaded cached messages for ${Object.keys(data).length} rooms from disk.`);
      return data;
    }
  } catch (err) {
    console.warn('[Messages] Failed to load local messages cache:', err.message);
  }
  return {};
}

/**
 * Persist in-memory messages to local disk backup
 */
function saveLocalMessages(messageStoreMap) {
  try {
    const obj = {};
    for (const [roomId, msgs] of messageStoreMap.entries()) {
      obj[roomId] = msgs.slice(-100);
    }
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Messages] Failed to save local messages cache:', err.message);
  }
}

/**
 * Persist a message to Supabase
 * @param {object} message
 */
async function persistMessage(message) {
  if (!supabaseClient) return;

  try {
    const { error } = await supabaseClient
      .from('messages')
      .insert({
        id: message.id,
        room_id: message.roomId,
        sender_id: message.senderId,
        sender_name: message.senderName,
        sender_avatar: message.senderAvatar,
        target_user_id: message.targetUserId || null,
        content: message.content || '',
        type: message.type || 'text',
        attachment: message.attachment || null,
        created_at: message.timestamp || Date.now()
      });

    if (error) {
      console.warn('[Supabase] Insert error:', error.message);
    }
  } catch (err) {
    console.warn('[Supabase] Failed to persist message:', err.message);
  }
}

/**
 * Fetch chat history for a room from Supabase
 * @param {string} roomId
 * @param {number} limit
 * @returns {Promise<Array<object>|null>}
 */
async function fetchRoomHistory(roomId, limit = 100) {
  if (!supabaseClient) return null;

  try {
    const { data, error } = await supabaseClient
      .from('messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map(row => ({
        id: row.id,
        roomId: row.room_id,
        senderId: row.sender_id,
        senderName: row.sender_name,
        senderAvatar: row.sender_avatar,
        targetUserId: row.target_user_id,
        content: row.content,
        type: row.type,
        attachment: row.attachment,
        timestamp: Number(row.created_at) || Date.now()
      }));
    }
  } catch (err) {
    console.warn('[Supabase] History query failed:', err.message);
  }
  return null;
}

module.exports = {
  isSupabaseConfigured,
  persistMessage,
  fetchRoomHistory,
  loadLocalMessages,
  saveLocalMessages
};
