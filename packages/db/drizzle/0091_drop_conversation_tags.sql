-- Drop the live-chat conversation labels feature. The shared "tags" vocabulary
-- (used by feedback posts) is untouched; only the chat-specific join table and
-- its indexes are removed. Indexes drop with the table, but we drop them
-- explicitly first to keep the teardown order clear and idempotent.

DROP INDEX IF EXISTS "conversation_tags_tag_id_idx";
DROP INDEX IF EXISTS "conversation_tags_conversation_id_idx";
DROP INDEX IF EXISTS "conversation_tags_pk";
DROP TABLE IF EXISTS "conversation_tags";
