-- 'snoozed' was removed as a conversation status. The status column is free
-- text (no DB enum), so normalize any legacy rows to 'open' rather than leave a
-- conversation on a value the app no longer understands. Idempotent + harmless
-- where no such rows exist.
UPDATE "conversations" SET "status" = 'open' WHERE "status" = 'snoozed';
