-- Supabase exposes the public schema through its Data API (anon/authenticated
-- roles). Swizzo only talks to Postgres from the server, so lock every table:
-- RLS on, no policies → the Data API sees nothing; the server's direct
-- connection (table owner) is unaffected.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
