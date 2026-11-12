CREATE TABLE "ontology"."collection" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "collection_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "collection_type_valid" CHECK ("type" IN ('volume', 'supplement', 'pamphlet'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."collection_version" (
	"id" uuid,
	"version" bigint,
	"name" text NOT NULL,
	CONSTRAINT "collection_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."pamphlet" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "pamphlet_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "pamphlet_type_valid" CHECK ("type" IN ('pamphlet'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."pamphlet_version" (
	"id" uuid,
	"version" bigint,
	"label" text,
	CONSTRAINT "pamphlet_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."series" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"code" text,
	CONSTRAINT "series_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "series_type_valid" CHECK ("type" IN ('volume', 'supplement'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."series_version" (
	"id" uuid,
	"version" bigint,
	"cadence" text,
	CONSTRAINT "series_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."supplement" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "supplement_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "supplement_type_valid" CHECK ("type" IN ('supplement'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."supplement_version" (
	"id" uuid,
	"version" bigint,
	"label" text,
	CONSTRAINT "supplement_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."volume" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "volume_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "volume_type_valid" CHECK ("type" IN ('volume'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."volume_version" (
	"id" uuid,
	"version" bigint,
	"label" text,
	CONSTRAINT "volume_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
ALTER TABLE "ontology"."collection" ADD CONSTRAINT "collection_id_node_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."collection" ADD CONSTRAINT "collection_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."node"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."collection_version" ADD CONSTRAINT "collection_version_id_collection_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."collection_version" ADD CONSTRAINT "collection_version_node_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."node_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."pamphlet" ADD CONSTRAINT "pamphlet_id_collection_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."collection"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."pamphlet" ADD CONSTRAINT "pamphlet_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."collection"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."pamphlet_version" ADD CONSTRAINT "pamphlet_version_id_pamphlet_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."pamphlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."pamphlet_version" ADD CONSTRAINT "pamphlet_version_collection_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."collection_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."series" ADD CONSTRAINT "series_id_collection_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."collection"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."series" ADD CONSTRAINT "series_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."collection"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."series_version" ADD CONSTRAINT "series_version_id_series_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."series"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."series_version" ADD CONSTRAINT "series_version_collection_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."collection_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."supplement" ADD CONSTRAINT "supplement_id_series_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."series"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."supplement" ADD CONSTRAINT "supplement_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."series"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."supplement_version" ADD CONSTRAINT "supplement_version_id_supplement_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."supplement"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."supplement_version" ADD CONSTRAINT "supplement_version_series_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."series_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."volume" ADD CONSTRAINT "volume_id_series_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."series"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."volume" ADD CONSTRAINT "volume_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."series"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."volume_version" ADD CONSTRAINT "volume_version_id_volume_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."volume"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."volume_version" ADD CONSTRAINT "volume_version_series_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."series_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
CREATE VIEW "ontology"."collection_view" AS (((select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."node"."type", "ontology"."collection_version"."name", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at", "ontology"."volume_version"."label" from "ontology"."volume_version" inner join "ontology"."node_version" on (("ontology"."volume_version"."id" = "ontology"."node_version"."id") and ("ontology"."volume_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."volume_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."volume_version"."id" = "ontology"."collection_version"."id") and ("ontology"."volume_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."series_version" on (("ontology"."volume_version"."id" = "ontology"."series_version"."id") and ("ontology"."volume_version"."version" = "ontology"."series_version"."version")) inner join "ontology"."series" on "ontology"."volume_version"."id" = "ontology"."series"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."volume_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."volume_version"."id") and ("newer"."version" > "ontology"."volume_version"."version")))) union all (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."node"."type", "ontology"."collection_version"."name", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at", "ontology"."supplement_version"."label" from "ontology"."supplement_version" inner join "ontology"."node_version" on (("ontology"."supplement_version"."id" = "ontology"."node_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."supplement_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."supplement_version"."id" = "ontology"."collection_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."series_version" on (("ontology"."supplement_version"."id" = "ontology"."series_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."series_version"."version")) inner join "ontology"."series" on "ontology"."supplement_version"."id" = "ontology"."series"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."supplement_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."supplement_version"."id") and ("newer"."version" > "ontology"."supplement_version"."version"))))) union all (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."node"."type", "ontology"."collection_version"."name", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at", "ontology"."pamphlet_version"."label" from "ontology"."pamphlet_version" inner join "ontology"."node_version" on (("ontology"."pamphlet_version"."id" = "ontology"."node_version"."id") and ("ontology"."pamphlet_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."pamphlet_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."pamphlet_version"."id" = "ontology"."collection_version"."id") and ("ontology"."pamphlet_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."node_version" "version_zero" on (("ontology"."pamphlet_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."pamphlet_version"."id") and ("newer"."version" > "ontology"."pamphlet_version"."version")))));--> statement-breakpoint
CREATE VIEW "ontology"."pamphlet_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."collection_version"."name", "ontology"."pamphlet_version"."label", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."pamphlet_version" inner join "ontology"."node_version" on (("ontology"."pamphlet_version"."id" = "ontology"."node_version"."id") and ("ontology"."pamphlet_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."pamphlet_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."pamphlet_version"."id" = "ontology"."collection_version"."id") and ("ontology"."pamphlet_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."node_version" "version_zero" on (("ontology"."pamphlet_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."pamphlet_version"."id") and ("newer"."version" > "ontology"."pamphlet_version"."version"))));--> statement-breakpoint
CREATE VIEW "ontology"."series_view" AS ((select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."node"."type", "ontology"."collection_version"."name", "ontology"."series"."code", "ontology"."series_version"."cadence", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."volume_version" inner join "ontology"."node_version" on (("ontology"."volume_version"."id" = "ontology"."node_version"."id") and ("ontology"."volume_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."volume_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."volume_version"."id" = "ontology"."collection_version"."id") and ("ontology"."volume_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."series_version" on (("ontology"."volume_version"."id" = "ontology"."series_version"."id") and ("ontology"."volume_version"."version" = "ontology"."series_version"."version")) inner join "ontology"."series" on "ontology"."volume_version"."id" = "ontology"."series"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."volume_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."volume_version"."id") and ("newer"."version" > "ontology"."volume_version"."version")))) union all (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."node"."type", "ontology"."collection_version"."name", "ontology"."series"."code", "ontology"."series_version"."cadence", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."supplement_version" inner join "ontology"."node_version" on (("ontology"."supplement_version"."id" = "ontology"."node_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."supplement_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."supplement_version"."id" = "ontology"."collection_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."series_version" on (("ontology"."supplement_version"."id" = "ontology"."series_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."series_version"."version")) inner join "ontology"."series" on "ontology"."supplement_version"."id" = "ontology"."series"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."supplement_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."supplement_version"."id") and ("newer"."version" > "ontology"."supplement_version"."version")))));--> statement-breakpoint
CREATE VIEW "ontology"."supplement_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."collection_version"."name", "ontology"."series"."code", "ontology"."series_version"."cadence", "ontology"."supplement_version"."label", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."supplement_version" inner join "ontology"."node_version" on (("ontology"."supplement_version"."id" = "ontology"."node_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."supplement_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."supplement_version"."id" = "ontology"."collection_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."series_version" on (("ontology"."supplement_version"."id" = "ontology"."series_version"."id") and ("ontology"."supplement_version"."version" = "ontology"."series_version"."version")) inner join "ontology"."series" on "ontology"."supplement_version"."id" = "ontology"."series"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."supplement_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."supplement_version"."id") and ("newer"."version" > "ontology"."supplement_version"."version"))));--> statement-breakpoint
CREATE VIEW "ontology"."volume_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."collection_version"."name", "ontology"."series"."code", "ontology"."series_version"."cadence", "ontology"."volume_version"."label", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."volume_version" inner join "ontology"."node_version" on (("ontology"."volume_version"."id" = "ontology"."node_version"."id") and ("ontology"."volume_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."volume_version"."id" = "ontology"."node"."id" inner join "ontology"."collection_version" on (("ontology"."volume_version"."id" = "ontology"."collection_version"."id") and ("ontology"."volume_version"."version" = "ontology"."collection_version"."version")) inner join "ontology"."series_version" on (("ontology"."volume_version"."id" = "ontology"."series_version"."id") and ("ontology"."volume_version"."version" = "ontology"."series_version"."version")) inner join "ontology"."series" on "ontology"."volume_version"."id" = "ontology"."series"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."volume_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."volume_version"."id") and ("newer"."version" > "ontology"."volume_version"."version"))));