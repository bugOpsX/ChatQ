-- ============================================================
-- ChatQ Database Schema for Supabase
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================

-- 1. Create Messages Table for Real-Time & Historical Chat Storage
CREATE TABLE IF NOT EXISTS public.messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_avatar TEXT,
    target_user_id TEXT,
    content TEXT DEFAULT '',
    type TEXT DEFAULT 'text',
    attachment JSONB,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- 2. Performance Indexes for Rapid Chat History Loading
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON public.messages(room_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON public.messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_target ON public.messages(target_user_id);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- 4. Set Policies for Authenticated / Anon Keys
DROP POLICY IF EXISTS "Allow public read access" ON public.messages;
CREATE POLICY "Allow public read access" ON public.messages FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public insert access" ON public.messages;
CREATE POLICY "Allow public insert access" ON public.messages FOR INSERT WITH CHECK (true);
