CREATE SCHEMA "ontology";
--> statement-breakpoint
CREATE TABLE "ontology"."agent" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "agent_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "agent_type_valid" CHECK ("type" IN ('person', 'organisation'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."agent_version" (
	"id" uuid,
	"version" bigint,
	CONSTRAINT "agent_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."book" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "book_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "book_type_valid" CHECK ("type" IN ('book'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."book_version" (
	"id" uuid,
	"version" bigint,
	"pages" integer,
	CONSTRAINT "book_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."edition" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "edition_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "edition_type_valid" CHECK ("type" IN ('edition'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."edition_version" (
	"id" uuid,
	"version" bigint,
	CONSTRAINT "edition_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."essay" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "essay_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "essay_type_valid" CHECK ("type" IN ('essay'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."essay_version" (
	"id" uuid,
	"version" bigint,
	CONSTRAINT "essay_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."manifestation" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "manifestation_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "manifestation_type_valid" CHECK ("type" IN ('edition'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."manifestation_isbn" (
	"id" uuid,
	"version" bigint,
	"isbn" text,
	CONSTRAINT "manifestation_isbn_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."manifestation_version" (
	"id" uuid,
	"version" bigint,
	CONSTRAINT "manifestation_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."node" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "node_id_type_unique" UNIQUE("id","type")
);
--> statement-breakpoint
CREATE TABLE "ontology"."node_version" (
	"id" uuid,
	"version" bigint,
	"action" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text,
	CONSTRAINT "node_version_pkey" PRIMARY KEY("id","version"),
	CONSTRAINT "node_version_action_valid" CHECK ("action" IN ('create', 'update', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."organisation" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "organisation_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "organisation_type_valid" CHECK ("type" IN ('organisation'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."organisation_version" (
	"id" uuid,
	"version" bigint,
	CONSTRAINT "organisation_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."person" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "person_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "person_type_valid" CHECK ("type" IN ('person'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."person_version" (
	"id" uuid,
	"version" bigint,
	CONSTRAINT "person_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "ontology"."work" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	CONSTRAINT "work_id_type_unique" UNIQUE("id","type"),
	CONSTRAINT "work_type_valid" CHECK ("type" IN ('book', 'essay'))
);
--> statement-breakpoint
CREATE TABLE "ontology"."work_version" (
	"id" uuid,
	"version" bigint,
	"title" text NOT NULL,
	CONSTRAINT "work_version_pkey" PRIMARY KEY("id","version")
);
--> statement-breakpoint
ALTER TABLE "ontology"."agent" ADD CONSTRAINT "agent_id_node_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."agent" ADD CONSTRAINT "agent_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."node"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."agent_version" ADD CONSTRAINT "agent_version_id_agent_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."agent_version" ADD CONSTRAINT "agent_version_node_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."node_version"("id","version");--> statement-breakpoint
ALTER TABLE "ontology"."book" ADD CONSTRAINT "book_id_work_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."work"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."book" ADD CONSTRAINT "book_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."work"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."book_version" ADD CONSTRAINT "book_version_id_book_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."book"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."book_version" ADD CONSTRAINT "book_version_work_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."work_version"("id","version");--> statement-breakpoint
ALTER TABLE "ontology"."edition" ADD CONSTRAINT "edition_id_manifestation_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."manifestation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."edition" ADD CONSTRAINT "edition_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."manifestation"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."edition_version" ADD CONSTRAINT "edition_version_id_edition_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."edition"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."edition_version" ADD CONSTRAINT "edition_version_manifestation_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."manifestation_version"("id","version");--> statement-breakpoint
ALTER TABLE "ontology"."essay" ADD CONSTRAINT "essay_id_work_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."work"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."essay" ADD CONSTRAINT "essay_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."work"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."essay_version" ADD CONSTRAINT "essay_version_id_essay_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."essay"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."essay_version" ADD CONSTRAINT "essay_version_work_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."work_version"("id","version");--> statement-breakpoint
ALTER TABLE "ontology"."manifestation" ADD CONSTRAINT "manifestation_id_node_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."manifestation" ADD CONSTRAINT "manifestation_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."node"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."manifestation_isbn" ADD CONSTRAINT "manifestation_isbn_manifestation_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."manifestation_version"("id","version") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."manifestation_version" ADD CONSTRAINT "manifestation_version_id_manifestation_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."manifestation"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."manifestation_version" ADD CONSTRAINT "manifestation_version_node_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."node_version"("id","version");--> statement-breakpoint
ALTER TABLE "ontology"."node_version" ADD CONSTRAINT "node_version_id_node_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."organisation" ADD CONSTRAINT "organisation_id_agent_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."organisation" ADD CONSTRAINT "organisation_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."agent"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."organisation_version" ADD CONSTRAINT "organisation_version_id_organisation_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."organisation_version" ADD CONSTRAINT "organisation_version_agent_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."agent_version"("id","version");--> statement-breakpoint
ALTER TABLE "ontology"."person" ADD CONSTRAINT "person_id_agent_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."person" ADD CONSTRAINT "person_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."agent"("id","type") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."person_version" ADD CONSTRAINT "person_version_id_person_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."person"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."person_version" ADD CONSTRAINT "person_version_agent_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."agent_version"("id","version");--> statement-breakpoint
ALTER TABLE "ontology"."work" ADD CONSTRAINT "work_id_node_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."node"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."work" ADD CONSTRAINT "work_id_type_fk" FOREIGN KEY ("id","type") REFERENCES "ontology"."node"("id","type");--> statement-breakpoint
ALTER TABLE "ontology"."work_version" ADD CONSTRAINT "work_version_id_work_id_fkey" FOREIGN KEY ("id") REFERENCES "ontology"."work"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ontology"."work_version" ADD CONSTRAINT "work_version_node_version_fk" FOREIGN KEY ("id","version") REFERENCES "ontology"."node_version"("id","version");