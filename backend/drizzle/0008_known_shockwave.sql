CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"expire" timestamp with time zone
);
CREATE INDEX "rate_limits_expire_idx" ON "rate_limits" USING btree ("expire");
