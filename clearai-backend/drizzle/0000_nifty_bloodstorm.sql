-- Extensions required by schema. Must run before any CREATE TABLE that uses
-- gen_random_uuid() (pgcrypto), tsvector (built-in), or vector(...) (pgvector).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TABLE "classification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"endpoint" varchar(32) NOT NULL,
	"request" jsonb NOT NULL,
	"language_detected" varchar(8),
	"decision_status" varchar(24) NOT NULL,
	"decision_reason" varchar(32) NOT NULL,
	"confidence_band" varchar(8),
	"chosen_code" varchar(12),
	"alternatives" jsonb,
	"top_retrieval_score" double precision,
	"top2_gap" double precision,
	"candidate_count" integer,
	"branch_size" integer,
	"llm_used" boolean DEFAULT false NOT NULL,
	"llm_status" varchar(24),
	"guard_tripped" boolean DEFAULT false NOT NULL,
	"model_calls" jsonb,
	"embedder_version" varchar(64),
	"llm_model" varchar(64),
	"total_latency_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "hs_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(12) NOT NULL,
	"chapter" varchar(2) NOT NULL,
	"heading" varchar(4) NOT NULL,
	"hs6" varchar(6) NOT NULL,
	"hs8" varchar(8) NOT NULL,
	"hs10" varchar(10) NOT NULL,
	"parent10" varchar(10) NOT NULL,
	"description_en" text,
	"description_ar" text,
	"duty_en" text,
	"duty_ar" text,
	"procedures" text,
	"tsv_en" "tsvector",
	"tsv_ar" "tsvector",
	"embedding" vector(384),
	"is_leaf" boolean DEFAULT true NOT NULL,
	"raw_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hs_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "setup_meta" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "events_created_at_idx" ON "classification_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_endpoint_idx" ON "classification_events" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "classification_events" USING btree ("decision_status");--> statement-breakpoint
CREATE INDEX "hs_codes_chapter_idx" ON "hs_codes" USING btree ("chapter");--> statement-breakpoint
CREATE INDEX "hs_codes_heading_idx" ON "hs_codes" USING btree ("heading");--> statement-breakpoint
CREATE INDEX "hs_codes_hs6_idx" ON "hs_codes" USING btree ("hs6");--> statement-breakpoint
CREATE INDEX "hs_codes_hs8_idx" ON "hs_codes" USING btree ("hs8");--> statement-breakpoint
CREATE INDEX "hs_codes_hs10_idx" ON "hs_codes" USING btree ("hs10");--> statement-breakpoint
CREATE INDEX "hs_codes_parent10_idx" ON "hs_codes" USING btree ("parent10");--> statement-breakpoint
CREATE INDEX "hs_codes_leaf_idx" ON "hs_codes" USING btree ("is_leaf");