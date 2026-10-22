CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"server" text NOT NULL,
	"tool" text NOT NULL,
	"args_summary" jsonb NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"order_id" text,
	"cart_id" text,
	"correlation_id" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"order_id" text NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"restaurant_id" text,
	"event_id" text,
	"starts_at" timestamp with time zone,
	"party_size" integer,
	"amount" numeric(12, 2),
	"lat" double precision,
	"lng" double precision,
	"last_status" text,
	"last_status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_kind_ck" CHECK ("bookings"."kind" in ('dineout', 'scenes'))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"message" jsonb NOT NULL,
	CONSTRAINT "chat_messages_session_id_position_pk" PRIMARY KEY("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"service" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_runs" (
	"user_id" uuid NOT NULL,
	"session_client_id" text NOT NULL,
	"run" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_runs_user_id_session_client_id_pk" PRIMARY KEY("user_id","session_client_id")
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swiggy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_swiggy_user_id_unique" UNIQUE("swiggy_user_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_runs" ADD CONSTRAINT "plan_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_created_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_order_idx" ON "audit_log" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_user_kind_order_uq" ON "bookings" USING btree ("user_id","kind","order_id");--> statement-breakpoint
CREATE INDEX "bookings_user_created_idx" ON "bookings" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_user_client_uq" ON "chat_sessions" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_updated_idx" ON "chat_sessions" USING btree ("user_id","updated_at");