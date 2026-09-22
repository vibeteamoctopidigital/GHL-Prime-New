-- Blog Writer v2: the octopi-shaped queue/batch/schedule design replaces the
-- first-pass tables from 20260916102651. Those held only test rows (the
-- feature was never run end to end), so they are dropped and recreated rather
-- than migrated in place — several new columns are NOT NULL without a default
-- (blog_topics.topic, blog_schedule_keywords.*), which an in-place ALTER on a
-- populated table would refuse.
--
-- blog_posts is touched only additively: its writer columns stay, cover_image_alt
-- is added, and topic_id is cleared (the rows it pointed at go away) and re-linked.
-- The retired blog_ai_* tables are not touched.

-- Detach blog_posts from the old topics table before it goes.
ALTER TABLE "blog_posts" DROP CONSTRAINT IF EXISTS "blog_posts_topic_id_fkey";
UPDATE "blog_posts" SET "topic_id" = NULL WHERE "topic_id" IS NOT NULL;

-- AlterTable
ALTER TABLE "blog_posts" ADD COLUMN IF NOT EXISTS "cover_image_alt" TEXT;

-- DropTable (first-pass Blog Writer tables; test data only)
DROP TABLE IF EXISTS "blog_write_requests";
DROP TABLE IF EXISTS "blog_deleted_schedules";
DROP TABLE IF EXISTS "blog_topics";
DROP TABLE IF EXISTS "blog_run_schedules";
DROP TABLE IF EXISTS "blog_writer_settings";

-- CreateTable
CREATE TABLE "blog_topics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "topic" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'keyword',
    "notes" TEXT NOT NULL DEFAULT '',
    "image_count" INTEGER,
    "words" INTEGER,
    "cta_variant" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "order" INTEGER NOT NULL DEFAULT 0,
    "batch_id" TEXT NOT NULL DEFAULT '',
    "schedule_id" UUID,
    "schedule_name" TEXT NOT NULL DEFAULT '',
    "blog_slug" TEXT NOT NULL DEFAULT '',
    "written_at" TIMESTAMPTZ(6),
    "skip_reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_write_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "topic_id" UUID,
    "requested_by" TEXT NOT NULL DEFAULT '',
    "posts_per_run" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "phase" TEXT NOT NULL DEFAULT 'starting',
    "detail" TEXT NOT NULL DEFAULT '',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "blog_slug" TEXT NOT NULL DEFAULT '',
    "topic_label" TEXT NOT NULL DEFAULT '',
    "failure_kind" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retry_after" TIMESTAMPTZ(6),
    "batch_id" TEXT NOT NULL DEFAULT '',
    "batch_total" INTEGER NOT NULL DEFAULT 0,
    "usage" JSONB,
    "error" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_write_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_run_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL DEFAULT 'New schedule',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'queue',
    "time" TEXT NOT NULL DEFAULT '07:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "posts_per_run" INTEGER NOT NULL DEFAULT 1,
    "posts_per_day" INTEGER NOT NULL DEFAULT 10,
    "sheet_url" TEXT NOT NULL DEFAULT '',
    "image_count" INTEGER NOT NULL DEFAULT 1,
    "words" INTEGER NOT NULL DEFAULT 500,
    "cta_variant" TEXT NOT NULL DEFAULT '',
    "sites" JSONB NOT NULL DEFAULT '[]',
    "last_run_day" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_run_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_schedule_keywords" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schedule_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "topic" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "image_count" INTEGER,
    "words" INTEGER,
    "cta_variant" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_schedule_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_deleted_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schedule_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "keyword_count" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_deleted_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_writer_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_writer_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "blog_topics_status_order_idx" ON "blog_topics"("status", "order");
CREATE INDEX "blog_topics_kind_idx" ON "blog_topics"("kind");
CREATE INDEX "blog_topics_batch_id_idx" ON "blog_topics"("batch_id");
CREATE INDEX "blog_topics_schedule_id_idx" ON "blog_topics"("schedule_id");
CREATE INDEX "blog_write_requests_status_retry_after_created_at_idx" ON "blog_write_requests"("status", "retry_after", "created_at");
CREATE INDEX "blog_write_requests_batch_id_idx" ON "blog_write_requests"("batch_id");
CREATE INDEX "blog_run_schedules_enabled_order_idx" ON "blog_run_schedules"("enabled", "order");
CREATE INDEX "blog_schedule_keywords_schedule_id_position_idx" ON "blog_schedule_keywords"("schedule_id", "position");
CREATE INDEX "blog_deleted_schedules_deleted_at_idx" ON "blog_deleted_schedules"("deleted_at");

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "blog_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "blog_topics" ADD CONSTRAINT "blog_topics_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "blog_run_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "blog_write_requests" ADD CONSTRAINT "blog_write_requests_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "blog_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "blog_schedule_keywords" ADD CONSTRAINT "blog_schedule_keywords_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "blog_run_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
