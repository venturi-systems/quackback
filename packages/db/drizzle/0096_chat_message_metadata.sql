-- Channel provenance for chat messages: a JSONB blob carrying the source
-- channel and, for inbound email, the provider Message-ID used to dedupe
-- webhook retries (Resend may redeliver). Additive + backfill-safe (existing
-- live-chat messages get NULL). A partial unique index makes inbound-email
-- ingestion idempotent at the database layer: a redelivered Message-ID can
-- never insert a duplicate message, regardless of application-level checks.

ALTER TABLE "chat_messages" ADD COLUMN "metadata" jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_email_message_id_idx"
  ON "chat_messages" (("metadata" ->> 'emailMessageId'))
  WHERE "metadata" ->> 'emailMessageId' IS NOT NULL;
