CREATE TABLE "otp_challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"challenge_token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenge_email_unique" UNIQUE("email")
);
