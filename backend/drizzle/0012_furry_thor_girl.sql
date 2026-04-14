ALTER TABLE "session" ADD COLUMN "device_id" text;--> statement-breakpoint
CREATE INDEX "session_deviceId_idx" ON "session" USING btree ("device_id");