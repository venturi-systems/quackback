-- The inbound channel a conversation arrived on. Additive + backfill-safe: the
-- NOT NULL DEFAULT 'live_chat' stamps every existing row (all of which are
-- widget live-chat threads today) and every future insert that omits it. This
-- makes the conversation polymorphic across channels ('email', 'web_form' land
-- in later phases) so "live chat vs support ticket" is one object, not two.

ALTER TABLE "conversations" ADD COLUMN "channel" text DEFAULT 'live_chat' NOT NULL;
