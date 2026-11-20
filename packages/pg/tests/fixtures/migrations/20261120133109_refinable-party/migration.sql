CREATE TABLE "ontology"."band" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "band_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "band_type_valid" CHECK ("type" IN ('band'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."band_version" (
	"id" uuid,
	"version" bigint,
	"genre" text,
	CONSTRAINT "band_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."guild" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "guild_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "guild_type_valid" CHECK ("type" IN ('band'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."guild_version" (
	"id" uuid,
	"version" bigint,
	"motto" text NOT NULL,
	CONSTRAINT "guild_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."member" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"badge" text,
	CONSTRAINT "member_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "member_type_valid" CHECK ("type" IN ('member'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."member_version" (
	"id" uuid,
	"version" bigint,
	"rank" integer,
	CONSTRAINT "member_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."party" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "party_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "party_type_valid" CHECK ("type" IN ('party', 'member', 'band'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."party_version" (
	"id" uuid,
	"version" bigint,
	"handle" text NOT NULL,
	CONSTRAINT "party_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."realm" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "realm_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "realm_type_valid" CHECK ("type" IN ('party', 'member', 'band'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."realm_version" (
	"id" uuid,
	"version" bigint,
	CONSTRAINT "realm_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
ALTER TABLE "ontology"."band" ADD CONSTRAINT "band_id_guild_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."guild"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."band" ADD CONSTRAINT "band_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."guild"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."band_version" ADD CONSTRAINT "band_version_id_band_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."band"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."band_version" ADD CONSTRAINT "band_version_guild_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."guild_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."guild" ADD CONSTRAINT "guild_id_party_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."party"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."guild" ADD CONSTRAINT "guild_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."party"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."guild_version" ADD CONSTRAINT "guild_version_id_guild_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."guild_version" ADD CONSTRAINT "guild_version_party_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."party_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."member" ADD CONSTRAINT "member_id_party_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."party"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."member" ADD CONSTRAINT "member_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."party"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."member_version" ADD CONSTRAINT "member_version_id_member_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."member"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."member_version" ADD CONSTRAINT "member_version_party_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."party_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."party" ADD CONSTRAINT "party_id_realm_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."party" ADD CONSTRAINT "party_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."realm"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."party_version" ADD CONSTRAINT "party_version_id_party_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."party"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."party_version" ADD CONSTRAINT "party_version_realm_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."realm_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."realm" ADD CONSTRAINT "realm_id_node_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."realm" ADD CONSTRAINT "realm_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."node"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."realm_version" ADD CONSTRAINT "realm_version_id_realm_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."realm"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."realm_version" ADD CONSTRAINT "realm_version_node_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."node_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
CREATE VIEW "ontology"."band_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."party_version"."handle", "ontology"."guild_version"."motto", "ontology"."band_version"."genre", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."band_version" inner join "ontology"."node_version" on (("ontology"."band_version"."id" = "ontology"."node_version"."id") and ("ontology"."band_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."band_version"."id" = "ontology"."node"."id" inner join "ontology"."party_version" on (("ontology"."band_version"."id" = "ontology"."party_version"."id") and ("ontology"."band_version"."version" = "ontology"."party_version"."version")) inner join "ontology"."guild_version" on (("ontology"."band_version"."id" = "ontology"."guild_version"."id") and ("ontology"."band_version"."version" = "ontology"."guild_version"."version")) cross join lateral (select  from "ontology"."realm_version" where (("ontology"."band_version"."id" = "ontology"."realm_version"."id") and ("ontology"."band_version"."version" = "ontology"."realm_version"."version")) offset 0) "tail" inner join "ontology"."node_version" "version_zero" on (("ontology"."band_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."band_version"."id") and ("newer"."version" > "ontology"."band_version"."version"))));--> statement-breakpoint
CREATE VIEW "ontology"."member_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."party_version"."handle", "tail"."badge", "ontology"."member_version"."rank", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."member_version" inner join "ontology"."node_version" on (("ontology"."member_version"."id" = "ontology"."node_version"."id") and ("ontology"."member_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."member_version"."id" = "ontology"."node"."id" inner join "ontology"."party_version" on (("ontology"."member_version"."id" = "ontology"."party_version"."id") and ("ontology"."member_version"."version" = "ontology"."party_version"."version")) cross join lateral (select "ontology"."member"."badge" from "ontology"."realm_version" inner join "ontology"."member" on "ontology"."member_version"."id" = "ontology"."member"."id" where (("ontology"."member_version"."id" = "ontology"."realm_version"."id") and ("ontology"."member_version"."version" = "ontology"."realm_version"."version")) offset 0) "tail" inner join "ontology"."node_version" "version_zero" on (("ontology"."member_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."member_version"."id") and ("newer"."version" > "ontology"."member_version"."version"))));--> statement-breakpoint
CREATE VIEW "ontology"."party_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."party_version"."handle", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."party_version" inner join "ontology"."node_version" on (("ontology"."party_version"."id" = "ontology"."node_version"."id") and ("ontology"."party_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."party_version"."id" = "ontology"."node"."id" cross join lateral (select  from "ontology"."realm_version" where (("ontology"."party_version"."id" = "ontology"."realm_version"."id") and ("ontology"."party_version"."version" = "ontology"."realm_version"."version")) offset 0) "tail" inner join "ontology"."node_version" "version_zero" on (("ontology"."party_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."party_version"."id") and ("newer"."version" > "ontology"."party_version"."version"))));--> statement-breakpoint
CREATE VIEW "ontology"."realm_view" AS (select "ontology"."node_version"."id", "ontology"."node_version"."version", "ontology"."node_version"."action", "ontology"."node"."type", "ontology"."node_version"."timestamp", "version_zero"."timestamp" as "created_at" from "ontology"."realm_version" inner join "ontology"."node_version" on (("ontology"."realm_version"."id" = "ontology"."node_version"."id") and ("ontology"."realm_version"."version" = "ontology"."node_version"."version")) inner join "ontology"."node" on "ontology"."realm_version"."id" = "ontology"."node"."id" inner join "ontology"."node_version" "version_zero" on (("ontology"."realm_version"."id" = "version_zero"."id") and ("version_zero"."version" = 0)) where ((not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."realm_version"."id") and ("newer"."version" > "ontology"."realm_version"."version")))) and (case "ontology"."node"."type" when 'party' then exists (select 1 from "ontology"."party_version" where (("ontology"."realm_version"."id" = "ontology"."party_version"."id") and ("ontology"."realm_version"."version" = "ontology"."party_version"."version")) offset 0) when 'member' then ((exists (select 1 from "ontology"."party_version" where (("ontology"."realm_version"."id" = "ontology"."party_version"."id") and ("ontology"."realm_version"."version" = "ontology"."party_version"."version")) offset 0)) and (exists (select 1 from "ontology"."member_version" where (("ontology"."realm_version"."id" = "ontology"."member_version"."id") and ("ontology"."realm_version"."version" = "ontology"."member_version"."version")) offset 0)) and (exists (select 1 from "ontology"."member" where "ontology"."realm_version"."id" = "ontology"."member"."id" offset 0))) when 'band' then ((exists (select 1 from "ontology"."party_version" where (("ontology"."realm_version"."id" = "ontology"."party_version"."id") and ("ontology"."realm_version"."version" = "ontology"."party_version"."version")) offset 0)) and (exists (select 1 from "ontology"."guild_version" where (("ontology"."realm_version"."id" = "ontology"."guild_version"."id") and ("ontology"."realm_version"."version" = "ontology"."guild_version"."version")) offset 0)) and (exists (select 1 from "ontology"."band_version" where (("ontology"."realm_version"."id" = "ontology"."band_version"."id") and ("ontology"."realm_version"."version" = "ontology"."band_version"."version")) offset 0))) else false end)));