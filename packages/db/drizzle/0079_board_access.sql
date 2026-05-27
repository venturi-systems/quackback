ALTER TABLE "boards" ADD COLUMN "access" jsonb DEFAULT '{"view":"anonymous","comment":"anonymous","submit":"anonymous","segmentIds":[],"approval":{"posts":false,"comments":false}}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "boards" SET "access" = jsonb_build_object(
  'view',
    CASE audience->>'kind'
      WHEN 'public'        THEN 'anonymous'
      WHEN 'authenticated' THEN 'authenticated'
      WHEN 'team'          THEN 'team'
      WHEN 'segments'      THEN 'segments'
    END,
  'comment',
    CASE audience->>'kind'
      WHEN 'public'        THEN 'anonymous'
      WHEN 'authenticated' THEN 'authenticated'
      WHEN 'team'          THEN 'team'
      WHEN 'segments'      THEN 'segments'
    END,
  'submit',
    CASE audience->>'kind'
      WHEN 'public'        THEN 'anonymous'
      WHEN 'authenticated' THEN 'authenticated'
      WHEN 'team'          THEN 'team'
      WHEN 'segments'      THEN 'segments'
    END,
  'segmentIds',
    COALESCE(audience->'segmentIds', '[]'::jsonb),
  'approval',
    '{"posts":false,"comments":false}'::jsonb
);
