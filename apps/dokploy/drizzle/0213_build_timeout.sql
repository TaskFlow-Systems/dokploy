ALTER TABLE "server" ADD COLUMN "buildTimeoutMinutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN "buildTimeoutMinutes" integer DEFAULT 60 NOT NULL;