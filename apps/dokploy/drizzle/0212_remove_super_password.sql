DROP TABLE IF EXISTS "super_password" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "super_password_token" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "super_session" CASCADE;--> statement-breakpoint
ALTER TABLE "notification" DROP COLUMN IF EXISTS "superPassword";