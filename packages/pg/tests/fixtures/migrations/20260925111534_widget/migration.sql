CREATE SCHEMA "fixture";
--> statement-breakpoint
CREATE TABLE "fixture"."widget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "fixture"."widget_version" (
	"id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"name" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fixture"."widget_version" ADD CONSTRAINT "widget_version_id_widget_id_fkey" FOREIGN KEY ("id") REFERENCES "fixture"."widget"("id");--> statement-breakpoint
CREATE VIEW "fixture"."widget_view" AS (select "fixture"."widget"."id", "fixture"."widget"."slug", "fixture"."widget_version"."name", "fixture"."widget_version"."timestamp" from "fixture"."widget" inner join "fixture"."widget_version" on "fixture"."widget"."id" = "fixture"."widget_version"."id");