CREATE TABLE "libsql_grpc_ca" (
	"organizationId" text PRIMARY KEY NOT NULL,
	"certificate" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "libsql_grpc_ca" ADD CONSTRAINT "libsql_grpc_ca_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;