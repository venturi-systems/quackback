-- Rich TipTap doc body for chat messages that carry structured content —
-- specifically agent internal notes with @-mentions, which render the same way
-- as feedback comments/posts. Additive + backfill-safe: existing plain
-- live-chat/email rows get NULL and keep rendering from `content`. Mirrors the
-- comments/posts `content_json` column.

ALTER TABLE "chat_messages" ADD COLUMN "content_json" jsonb;
