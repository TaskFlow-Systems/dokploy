CREATE TABLE "deployment_freeze" (
	"freezeId" text PRIMARY KEY NOT NULL,
	"scopeType" text NOT NULL,
	"scopeId" text NOT NULL,
	"reason" text,
	"createdByUserId" text,
	"createdByLabel" text,
	"createdByAuthMethod" text DEFAULT 'session' NOT NULL,
	"createdAt" text NOT NULL,
	"expiresAt" text,
	"liftedAt" text,
	"liftedByUserId" text,
	"skippedCount" integer DEFAULT 0 NOT NULL,
	"lastSkippedAt" text,
	"lastSkippedSource" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_freeze_active_scope_uidx" ON "deployment_freeze" USING btree ("scopeType","scopeId") WHERE "deployment_freeze"."liftedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "deployment_freeze_scope_created_idx" ON "deployment_freeze" USING btree ("scopeType","scopeId","createdAt");