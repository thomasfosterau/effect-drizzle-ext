CREATE TABLE "ontology"."artefact" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "artefact_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "artefact_type_valid" CHECK ("type" IN ('printed', 'digital', 'ebook'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."artefact_version" (
	"id" uuid,
	"version" bigint,
	"caption" text NOT NULL,
	CONSTRAINT "artefact_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."digital" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "digital_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "digital_type_valid" CHECK ("type" IN ('digital', 'ebook'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."digital_version" (
	"id" uuid,
	"version" bigint,
	"file_size" integer,
	CONSTRAINT "digital_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."ebook" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "ebook_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "ebook_type_valid" CHECK ("type" IN ('ebook'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."ebook_version" (
	"id" uuid,
	"version" bigint,
	"drm" text,
	CONSTRAINT "ebook_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."printed" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "printed_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "printed_type_valid" CHECK ("type" IN ('printed', 'ebook'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."printed_version" (
	"id" uuid,
	"version" bigint,
	"press_run" integer,
	CONSTRAINT "printed_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
ALTER TABLE "ontology"."artefact" ADD CONSTRAINT "artefact_id_node_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."artefact" ADD CONSTRAINT "artefact_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."node"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."artefact_version" ADD CONSTRAINT "artefact_version_id_artefact_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."artefact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."artefact_version" ADD CONSTRAINT "artefact_version_node_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."node_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."digital" ADD CONSTRAINT "digital_id_artefact_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."artefact"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."digital" ADD CONSTRAINT "digital_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."artefact"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."digital_version" ADD CONSTRAINT "digital_version_id_digital_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."digital"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."digital_version" ADD CONSTRAINT "digital_version_artefact_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."artefact_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."ebook" ADD CONSTRAINT "ebook_id_printed_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."printed"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."ebook" ADD CONSTRAINT "ebook_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."printed"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."ebook" ADD CONSTRAINT "ebook_id_digital_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."digital"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."ebook" ADD CONSTRAINT "ebook_id_type_digital_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."digital"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."ebook_version" ADD CONSTRAINT "ebook_version_id_ebook_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."ebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."ebook_version" ADD CONSTRAINT "ebook_version_printed_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."printed_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."ebook_version" ADD CONSTRAINT "ebook_version_digital_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."digital_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."printed" ADD CONSTRAINT "printed_id_artefact_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."artefact"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."printed" ADD CONSTRAINT "printed_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."artefact"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."printed_version" ADD CONSTRAINT "printed_version_id_printed_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."printed"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."printed_version" ADD CONSTRAINT "printed_version_artefact_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."artefact_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
CREATE VIEW "ontology"."artefact_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."node"."type", "ontology"."artefact_version"."caption", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."artefact_version" inner join "ontology"."node_version" on (("ontology"."artefact_version"."id" = "ontology"."node_version"."id") and ("ontology"."artefact_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."artefact_version"."id" = "ontology"."node"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."artefact_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where ((not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."artefact_version"."id") and ("newer"."version" > "ontology"."artefact_version"."version")))) and (case "ontology"."node"."type" when 'printed' then exists (select 1 from "ontology"."printed_version" where (("ontology"."artefact_version"."id" = "ontology"."printed_version"."id") and ("ontology"."artefact_version"."version" = "ontology"."printed_version"."version")) offset 0) when 'digital' then exists (select 1 from "ontology"."digital_version" where (("ontology"."artefact_version"."id" = "ontology"."digital_version"."id") and ("ontology"."artefact_version"."version" = "ontology"."digital_version"."version")) offset 0) when 'ebook' then ((exists (select 1 from "ontology"."printed_version" where (("ontology"."artefact_version"."id" = "ontology"."printed_version"."id") and ("ontology"."artefact_version"."version" = "ontology"."printed_version"."version")) offset 0)) and (exists (select 1 from "ontology"."digital_version" where (("ontology"."artefact_version"."id" = "ontology"."digital_version"."id") and ("ontology"."artefact_version"."version" = "ontology"."digital_version"."version")) offset 0)) and (exists (select 1 from "ontology"."ebook_version" where (("ontology"."artefact_version"."id" = "ontology"."ebook_version"."id") and ("ontology"."artefact_version"."version" = "ontology"."ebook_version"."version")) offset 0))) else false end)));--> statement-breakpoint
CREATE VIEW "ontology"."digital_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."artefact_version"."caption", "ontology"."digital_version"."file_size", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."digital_version" inner join "ontology"."node_version" on (("ontology"."digital_version"."id" = "ontology"."node_version"."id") and ("ontology"."digital_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."digital_version"."id" = "ontology"."node"."id" inner join "ontology"."artefact_version" on (("ontology"."digital_version"."id" = "ontology"."artefact_version"."id") and ("ontology"."digital_version"."version" = "ontology"."artefact_version"."version")) inner join "ontology"."node_version" "version_zero" on (("ontology"."digital_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."digital_version"."id") and ("newer"."version" > "ontology"."digital_version"."version"))));--> statement-breakpoint
CREATE VIEW "ontology"."ebook_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."artefact_version"."caption", "ontology"."printed_version"."press_run", "ontology"."digital_version"."file_size", "ontology"."ebook_version"."drm", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."ebook_version" inner join "ontology"."node_version" on (("ontology"."ebook_version"."id" = "ontology"."node_version"."id") and ("ontology"."ebook_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."ebook_version"."id" = "ontology"."node"."id" inner join "ontology"."artefact_version" on (("ontology"."ebook_version"."id" = "ontology"."artefact_version"."id") and ("ontology"."ebook_version"."version" = "ontology"."artefact_version"."version")) inner join "ontology"."printed_version" on (("ontology"."ebook_version"."id" = "ontology"."printed_version"."id") and ("ontology"."ebook_version"."version" = "ontology"."printed_version"."version")) inner join "ontology"."digital_version" on (("ontology"."ebook_version"."id" = "ontology"."digital_version"."id") and ("ontology"."ebook_version"."version" = "ontology"."digital_version"."version")) inner join "ontology"."node_version" "version_zero" on (("ontology"."ebook_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."ebook_version"."id") and ("newer"."version" > "ontology"."ebook_version"."version"))));--> statement-breakpoint
CREATE VIEW "ontology"."printed_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."artefact_version"."caption", "ontology"."printed_version"."press_run", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."printed_version" inner join "ontology"."node_version" on (("ontology"."printed_version"."id" = "ontology"."node_version"."id") and ("ontology"."printed_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."printed_version"."id" = "ontology"."node"."id" inner join "ontology"."artefact_version" on (("ontology"."printed_version"."id" = "ontology"."artefact_version"."id") and ("ontology"."printed_version"."version" = "ontology"."artefact_version"."version")) inner join "ontology"."node_version" "version_zero" on (("ontology"."printed_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."printed_version"."id") and ("newer"."version" > "ontology"."printed_version"."version"))));