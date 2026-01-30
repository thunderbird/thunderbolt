CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text,
	"last_seen" integer DEFAULT extract(epoch from now())::integer,
	"created_at" integer DEFAULT extract(epoch from now())::integer,
	"revoked_at" integer
);
