CREATE TABLE "fixture"."outbox" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fixture"."outbox_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"stream" text NOT NULL,
	"stream_version" bigint NOT NULL,
	"event_index" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_stream_event_unique" UNIQUE("stream","stream_version","event_index")
);
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "fixture"."outbox" ("seq") WHERE "published_at" IS NULL;