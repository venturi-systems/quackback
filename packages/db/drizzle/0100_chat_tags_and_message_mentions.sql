-- Conversation tags ("labels") for the support inbox, plus @-mentions inside
-- chat messages. Both are deliberately SEPARATE from the feedback equivalents
-- (the `tags`/`post_tags` and `post_mentions` tables): conversation labels and
-- chat mentions have their own rows, ids, and lifecycle and never mix with the
-- feedback taxonomies.

-- Agent-managed conversation labels. Org-wide (database-per-tenant, so no
-- workspace column), unique by name, soft-deleted so removing a label detaches
-- it from conversations without erasing history.
CREATE TABLE "chat_tags" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "color" text NOT NULL DEFAULT '#6b7280',
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE INDEX "chat_tags_deleted_at_idx" ON "chat_tags" ("deleted_at");

-- Which labels are applied to which conversation. Both foreign keys cascade so
-- deleting a conversation or a label row leaves no dangling join rows; the
-- unique index makes (conversation, tag) idempotent.
CREATE TABLE "conversation_tags" (
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "chat_tag_id" uuid NOT NULL REFERENCES "chat_tags"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "conversation_tags_pk"
  ON "conversation_tags" ("conversation_id", "chat_tag_id");

CREATE INDEX "conversation_tags_chat_tag_idx"
  ON "conversation_tags" ("chat_tag_id");

-- Every @-mention of a team member inside a chat message (internal notes only).
-- Mirrors post_mentions: one row per (message, principal), `notified_at`
-- watermarks delivery so re-edits don't re-notify, and the (principal_id,
-- created_at DESC) index serves the "mentions of me" view without a sort pass.
-- Both foreign keys cascade on delete.
CREATE TABLE "chat_message_mentions" (
  "id" uuid PRIMARY KEY,
  "chat_message_id" uuid NOT NULL REFERENCES "chat_messages"("id") ON DELETE CASCADE,
  "principal_id" uuid NOT NULL REFERENCES "principal"("id") ON DELETE CASCADE,
  "notified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "chat_message_mentions_message_principal_uq"
  ON "chat_message_mentions" ("chat_message_id", "principal_id");

CREATE INDEX "chat_message_mentions_principal_idx"
  ON "chat_message_mentions" ("principal_id", "created_at" DESC);
