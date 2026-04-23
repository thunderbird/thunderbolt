CREATE TABLE "powersync"."agents" (
	"id" text NOT NULL,
	"name" text,
	"type" text,
	"transport" text,
	"command" text,
	"args" text,
	"url" text,
	"auth_method" text,
	"icon" text,
	"is_system" integer DEFAULT 0,
	"enabled" integer DEFAULT 1,
	"registry_id" text,
	"installed_version" text,
	"registry_version" text,
	"distribution_type" text,
	"install_path" text,
	"package_name" text,
	"description" text,
	"default_hash" text,
	"deleted_at" timestamp,
	"user_id" text NOT NULL,
	CONSTRAINT "agents_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agents_user_id" ON "powersync"."agents" USING btree ("user_id");