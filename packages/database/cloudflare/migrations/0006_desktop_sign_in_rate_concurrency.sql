CREATE TRIGGER "cap_revision_desktop_sign_in_rate_limits_insert" AFTER INSERT ON "desktop_sign_in_rate_limits" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_desktop_sign_in_rate_limits_update" AFTER UPDATE ON "desktop_sign_in_rate_limits" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_desktop_sign_in_rate_limits_delete" AFTER DELETE ON "desktop_sign_in_rate_limits" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
