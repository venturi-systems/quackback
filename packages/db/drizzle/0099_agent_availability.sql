-- Per-agent manual availability override: 'online' (default — route chats to me)
-- vs 'away' (connected but opted out of routing). The presence TTL handles
-- auto-offline; this column is the explicit opt-out. Additive; existing rows
-- get 'online' via the column default.
ALTER TABLE "principal"
  ADD COLUMN "chat_availability" text NOT NULL DEFAULT 'online';
