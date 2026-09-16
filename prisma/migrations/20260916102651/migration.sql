-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST', 'ARCHIVED');

-- CreateTable
CREATE TABLE "case_studies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subtitle" TEXT,
    "challenge" TEXT,
    "solution" TEXT,
    "outcome" TEXT,
    "excerpt" TEXT,
    "image" TEXT,
    "accent" TEXT DEFAULT 'emerald',
    "body" JSONB NOT NULL DEFAULT '[]',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "linkedin_url" TEXT,
    "facebook_url" TEXT,
    "instagram_url" TEXT,
    "twitter_url" TEXT,
    "upwork_url" TEXT,
    "website_url" TEXT,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_study_team_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "case_study_id" UUID NOT NULL,
    "team_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_study_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_page_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_page_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_gallery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT,
    "image_url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_gallery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technology_logos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technology_logos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_logos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_name" TEXT NOT NULL,
    "logo_image_url" TEXT,
    "website_url" TEXT,
    "sort_order" INTEGER DEFAULT 1,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "image_url" TEXT,
    "name" TEXT,

    CONSTRAINT "partner_logos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "author" TEXT DEFAULT 'GHL Prime Team',
    "excerpt" TEXT,
    "cover_image" TEXT,
    "reading_time" INTEGER,
    "content" TEXT,
    "seo_title" TEXT,
    "seo_description" TEXT,
    "seo_keywords" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "target_keyword" TEXT,
    "cta_variant" TEXT,
    "sources" JSONB,
    "research_mode" TEXT,
    "source_url" TEXT,
    "source_name" TEXT,
    "topic_id" UUID,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showcase_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "origin_name" TEXT NOT NULL,
    "origin_url" TEXT,
    "origin_icon" TEXT,
    "origin_description" TEXT,
    "origin_tagline" TEXT,
    "adaptation_badge" TEXT DEFAULT 'Enterprise Adaptation',
    "adaptation_name" TEXT NOT NULL,
    "adaptation_description" TEXT,
    "adaptation_tags" JSONB NOT NULL DEFAULT '[]',
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "showcase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showcase_stats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "showcase_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showcase_placements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_id" UUID NOT NULL,
    "page_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "showcase_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gallery_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT,
    "image_url" TEXT NOT NULL,
    "category_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 999,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gallery_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'EDITOR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "full_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "message" TEXT,
    "source" TEXT,
    "country" TEXT,
    "role" TEXT,
    "ghl_situation" TEXT,
    "client_volume" TEXT,
    "monthly_budget" TEXT,
    "timeline" TEXT,
    "biggest_challenge" TEXT,
    "page_url" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_surveys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "business" TEXT,
    "service" TEXT,
    "source" TEXT,
    "role" TEXT,
    "business_type" TEXT,
    "stage" TEXT,
    "app_type" TEXT,
    "needs" TEXT,
    "budget" TEXT,
    "sub_accounts" TEXT,
    "lead_volume" TEXT,
    "coverage" TEXT,
    "details" TEXT,
    "page_url" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "public_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secure_url" TEXT NOT NULL,
    "format" TEXT,
    "resource_type" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "folder" TEXT,
    "original_filename" TEXT,
    "alt" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_ai_settings" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL DEFAULT '',
    "keywords" TEXT NOT NULL DEFAULT '',
    "advanced_instructions" TEXT NOT NULL DEFAULT '',
    "categories" TEXT[] DEFAULT ARRAY['GoHighLevel', 'Automation', 'AI Agents', 'Case Studies', 'Voice AI', 'CRM', 'Vibe Coding']::TEXT[],
    "schedule_hour" INTEGER NOT NULL DEFAULT 6,
    "posts_per_day" INTEGER NOT NULL DEFAULT 1,
    "primary_provider" TEXT NOT NULL DEFAULT 'anthropic',
    "fallback_enabled" BOOLEAN NOT NULL DEFAULT false,
    "anthropic_model" TEXT NOT NULL DEFAULT '',
    "openai_model" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "style_rules" TEXT NOT NULL DEFAULT 'Do not use em dashes. Write short, clear sentences aimed at a general reader. Avoid jargon. Prefer active voice.',
    "topic_focus_areas" TEXT[] DEFAULT ARRAY['AI automation', 'CRM', 'GoHighLevel', 'Web Development']::TEXT[],
    "review_window_minutes" INTEGER NOT NULL DEFAULT 20,
    "image_generation_enabled" BOOLEAN NOT NULL DEFAULT true,
    "web_search_enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_seo_score" INTEGER NOT NULL DEFAULT 70,
    "competitor_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_internal_links" INTEGER NOT NULL DEFAULT 3,
    "blog_url_path" TEXT NOT NULL DEFAULT '/blog',
    "claude_cli_command" TEXT,
    "codex_cli_command" TEXT,
    "codex_enabled" BOOLEAN NOT NULL DEFAULT false,
    "placeholder_cover_image_url" TEXT NOT NULL DEFAULT '',
    "auto_blog_enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule_minute" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "blog_ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_ai_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "token_preview" TEXT NOT NULL,
    "model" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "cooldown_until" TIMESTAMPTZ(6),
    "done_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auth_type" TEXT NOT NULL DEFAULT 'oauth',

    CONSTRAINT "blog_ai_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_ai_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "account_label" TEXT,
    "blog_post_id" UUID,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "alerted_at" TIMESTAMPTZ(6),
    "current_step" TEXT,

    CONSTRAINT "blog_ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_ai_drafts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "provider" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "primary_keyword" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excerpt" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "seo_title" TEXT NOT NULL DEFAULT '',
    "seo_description" TEXT NOT NULL DEFAULT '',
    "seo_keywords" TEXT NOT NULL DEFAULT '',
    "reading_time" INTEGER,
    "cover_image" TEXT,
    "cover_image_alt" TEXT,
    "topic_research" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "review_deadline" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "checker_result" JSONB,
    "blog_post_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_topics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "target_keyword" TEXT,
    "category" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "schedule_id" UUID,
    "research_mode" TEXT NOT NULL DEFAULT 'keyword',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skip_reason" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_write_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "topic_id" UUID,
    "schedule_id" UUID,
    "ad_hoc_title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phase" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "retry_after" TIMESTAMPTZ(6),
    "error" TEXT,
    "blog_post_id" UUID,
    "model_used" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(10,4),
    "claimed_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_write_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_run_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "label" TEXT NOT NULL,
    "hour" INTEGER NOT NULL DEFAULT 6,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "days_of_week" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "next_keyword_index" INTEGER NOT NULL DEFAULT 0,
    "posts_per_run" INTEGER NOT NULL DEFAULT 1,
    "research_mode" TEXT NOT NULL DEFAULT 'keyword',
    "category" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMPTZ(6),
    "last_run_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_run_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_deleted_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "original_schedule_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "deleted_by" UUID,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_deleted_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_writer_settings" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "auto_publish_enabled" BOOLEAN NOT NULL DEFAULT false,
    "default_model" TEXT NOT NULL DEFAULT 'sonnet',
    "min_seo_score" INTEGER NOT NULL DEFAULT 70,
    "max_internal_links" INTEGER NOT NULL DEFAULT 3,
    "max_retries" INTEGER NOT NULL DEFAULT 6,
    "run_timeout_minutes" INTEGER NOT NULL DEFAULT 25,
    "style_rules" TEXT NOT NULL DEFAULT 'Do not use em dashes. Write short, clear sentences aimed at a general reader. Avoid jargon. Prefer active voice.',
    "categories" TEXT[] DEFAULT ARRAY['GoHighLevel', 'Automation', 'AI Agents', 'Case Studies', 'Voice AI', 'CRM', 'Vibe Coding']::TEXT[],
    "competitor_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "last_heartbeat_host" TEXT,
    "stop_requested" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_writer_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_studies_slug_key" ON "case_studies"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "blog_posts_slug_key" ON "blog_posts"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "gallery_categories_slug_key" ON "gallery_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_public_id_key" ON "media_assets"("public_id");

-- AddForeignKey
ALTER TABLE "case_study_team_members" ADD CONSTRAINT "case_study_team_members_case_study_id_fkey" FOREIGN KEY ("case_study_id") REFERENCES "case_studies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_study_team_members" ADD CONSTRAINT "case_study_team_members_team_member_id_fkey" FOREIGN KEY ("team_member_id") REFERENCES "team_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "blog_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "showcase_placements" ADD CONSTRAINT "showcase_placements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "showcase_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_images" ADD CONSTRAINT "gallery_images_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "gallery_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_ai_runs" ADD CONSTRAINT "blog_ai_runs_blog_post_id_fkey" FOREIGN KEY ("blog_post_id") REFERENCES "blog_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_ai_drafts" ADD CONSTRAINT "blog_ai_drafts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "blog_ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_ai_drafts" ADD CONSTRAINT "blog_ai_drafts_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_ai_drafts" ADD CONSTRAINT "blog_ai_drafts_blog_post_id_fkey" FOREIGN KEY ("blog_post_id") REFERENCES "blog_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_topics" ADD CONSTRAINT "blog_topics_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "blog_run_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_write_requests" ADD CONSTRAINT "blog_write_requests_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "blog_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_write_requests" ADD CONSTRAINT "blog_write_requests_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "blog_run_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_write_requests" ADD CONSTRAINT "blog_write_requests_blog_post_id_fkey" FOREIGN KEY ("blog_post_id") REFERENCES "blog_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_deleted_schedules" ADD CONSTRAINT "blog_deleted_schedules_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
