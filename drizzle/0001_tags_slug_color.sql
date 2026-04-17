-- BL-22: add slug and color columns to tags table
ALTER TABLE "tags" ADD COLUMN "slug" text NOT NULL DEFAULT '';
ALTER TABLE "tags" ADD COLUMN "color" text;
