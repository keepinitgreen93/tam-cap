CREATE TABLE cap_database_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991));
--> statement-breakpoint
INSERT INTO cap_database_revision (id, revision) VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE cap_snapshot_guard (id INTEGER PRIMARY KEY CHECK (id = 1), valid INTEGER NOT NULL CONSTRAINT cap_d1_snapshot_guard CHECK (valid = 1));
--> statement-breakpoint
CREATE TRIGGER "cap_revision_accounts_insert" AFTER INSERT ON "accounts" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_accounts_update" AFTER UPDATE ON "accounts" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_accounts_delete" AFTER DELETE ON "accounts" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_authorization_codes_insert" AFTER INSERT ON "agent_api_authorization_codes" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_authorization_codes_update" AFTER UPDATE ON "agent_api_authorization_codes" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_authorization_codes_delete" AFTER DELETE ON "agent_api_authorization_codes" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_idempotency_insert" AFTER INSERT ON "agent_api_idempotency" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_idempotency_update" AFTER UPDATE ON "agent_api_idempotency" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_idempotency_delete" AFTER DELETE ON "agent_api_idempotency" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_keys_insert" AFTER INSERT ON "agent_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_keys_update" AFTER UPDATE ON "agent_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_keys_delete" AFTER DELETE ON "agent_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_operations_insert" AFTER INSERT ON "agent_api_operations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_operations_update" AFTER UPDATE ON "agent_api_operations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_agent_api_operations_delete" AFTER DELETE ON "agent_api_operations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_auth_api_keys_insert" AFTER INSERT ON "auth_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_auth_api_keys_update" AFTER UPDATE ON "auth_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_auth_api_keys_delete" AFTER DELETE ON "auth_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_comments_insert" AFTER INSERT ON "comments" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_comments_update" AFTER UPDATE ON "comments" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_comments_delete" AFTER DELETE ON "comments" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_api_keys_insert" AFTER INSERT ON "developer_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_api_keys_update" AFTER UPDATE ON "developer_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_api_keys_delete" AFTER DELETE ON "developer_api_keys" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_app_domains_insert" AFTER INSERT ON "developer_app_domains" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_app_domains_update" AFTER UPDATE ON "developer_app_domains" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_app_domains_delete" AFTER DELETE ON "developer_app_domains" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_apps_insert" AFTER INSERT ON "developer_apps" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_apps_update" AFTER UPDATE ON "developer_apps" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_apps_delete" AFTER DELETE ON "developer_apps" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_credit_accounts_insert" AFTER INSERT ON "developer_credit_accounts" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_credit_accounts_update" AFTER UPDATE ON "developer_credit_accounts" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_credit_accounts_delete" AFTER DELETE ON "developer_credit_accounts" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_credit_transactions_insert" AFTER INSERT ON "developer_credit_transactions" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_credit_transactions_update" AFTER UPDATE ON "developer_credit_transactions" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_credit_transactions_delete" AFTER DELETE ON "developer_credit_transactions" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_daily_storage_snapshots_insert" AFTER INSERT ON "developer_daily_storage_snapshots" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_daily_storage_snapshots_update" AFTER UPDATE ON "developer_daily_storage_snapshots" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_daily_storage_snapshots_delete" AFTER DELETE ON "developer_daily_storage_snapshots" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_videos_insert" AFTER INSERT ON "developer_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_videos_update" AFTER UPDATE ON "developer_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_developer_videos_delete" AFTER DELETE ON "developer_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_folders_insert" AFTER INSERT ON "folders" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_folders_update" AFTER UPDATE ON "folders" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_folders_delete" AFTER DELETE ON "folders" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_imported_videos_insert" AFTER INSERT ON "imported_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_imported_videos_update" AFTER UPDATE ON "imported_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_imported_videos_delete" AFTER DELETE ON "imported_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_integration_installations_insert" AFTER INSERT ON "integration_installations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_integration_installations_update" AFTER UPDATE ON "integration_installations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_integration_installations_delete" AFTER DELETE ON "integration_installations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loom_migration_imports_insert" AFTER INSERT ON "loom_migration_imports" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loom_migration_imports_update" AFTER UPDATE ON "loom_migration_imports" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loom_migration_imports_delete" AFTER DELETE ON "loom_migration_imports" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loom_migration_requests_insert" AFTER INSERT ON "loom_migration_requests" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loom_migration_requests_update" AFTER UPDATE ON "loom_migration_requests" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loom_migration_requests_delete" AFTER DELETE ON "loom_migration_requests" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loops_sync_jobs_insert" AFTER INSERT ON "loops_sync_jobs" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loops_sync_jobs_update" AFTER UPDATE ON "loops_sync_jobs" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_loops_sync_jobs_delete" AFTER DELETE ON "loops_sync_jobs" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_clients_insert" AFTER INSERT ON "mcp_oauth_clients" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_clients_update" AFTER UPDATE ON "mcp_oauth_clients" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_clients_delete" AFTER DELETE ON "mcp_oauth_clients" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_codes_insert" AFTER INSERT ON "mcp_oauth_codes" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_codes_update" AFTER UPDATE ON "mcp_oauth_codes" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_codes_delete" AFTER DELETE ON "mcp_oauth_codes" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_registration_quotas_insert" AFTER INSERT ON "mcp_oauth_registration_quotas" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_registration_quotas_update" AFTER UPDATE ON "mcp_oauth_registration_quotas" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_registration_quotas_delete" AFTER DELETE ON "mcp_oauth_registration_quotas" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_tokens_insert" AFTER INSERT ON "mcp_oauth_tokens" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_tokens_update" AFTER UPDATE ON "mcp_oauth_tokens" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_mcp_oauth_tokens_delete" AFTER DELETE ON "mcp_oauth_tokens" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_media_processing_budgets_insert" AFTER INSERT ON "media_processing_budgets" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_media_processing_budgets_update" AFTER UPDATE ON "media_processing_budgets" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_media_processing_budgets_delete" AFTER DELETE ON "media_processing_budgets" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_conversations_insert" AFTER INSERT ON "messenger_conversations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_conversations_update" AFTER UPDATE ON "messenger_conversations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_conversations_delete" AFTER DELETE ON "messenger_conversations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_messages_insert" AFTER INSERT ON "messenger_messages" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_messages_update" AFTER UPDATE ON "messenger_messages" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_messages_delete" AFTER DELETE ON "messenger_messages" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_support_emails_insert" AFTER INSERT ON "messenger_support_emails" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_support_emails_update" AFTER UPDATE ON "messenger_support_emails" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_messenger_support_emails_delete" AFTER DELETE ON "messenger_support_emails" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_notifications_insert" AFTER INSERT ON "notifications" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_notifications_update" AFTER UPDATE ON "notifications" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_notifications_delete" AFTER DELETE ON "notifications" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_invites_insert" AFTER INSERT ON "organization_invites" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_invites_update" AFTER UPDATE ON "organization_invites" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_invites_delete" AFTER DELETE ON "organization_invites" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_members_insert" AFTER INSERT ON "organization_members" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_members_update" AFTER UPDATE ON "organization_members" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_members_delete" AFTER DELETE ON "organization_members" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_sso_insert" AFTER INSERT ON "organization_sso" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_sso_update" AFTER UPDATE ON "organization_sso" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organization_sso_delete" AFTER DELETE ON "organization_sso" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organizations_insert" AFTER INSERT ON "organizations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organizations_update" AFTER UPDATE ON "organizations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_organizations_delete" AFTER DELETE ON "organizations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_s3_buckets_insert" AFTER INSERT ON "s3_buckets" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_s3_buckets_update" AFTER UPDATE ON "s3_buckets" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_s3_buckets_delete" AFTER DELETE ON "s3_buckets" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_sessions_insert" AFTER INSERT ON "sessions" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_sessions_update" AFTER UPDATE ON "sessions" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_sessions_delete" AFTER DELETE ON "sessions" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_shared_videos_insert" AFTER INSERT ON "shared_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_shared_videos_update" AFTER UPDATE ON "shared_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_shared_videos_delete" AFTER DELETE ON "shared_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_signed_baas_insert" AFTER INSERT ON "signed_baas" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_signed_baas_update" AFTER UPDATE ON "signed_baas" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_signed_baas_delete" AFTER DELETE ON "signed_baas" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_space_members_insert" AFTER INSERT ON "space_members" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_space_members_update" AFTER UPDATE ON "space_members" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_space_members_delete" AFTER DELETE ON "space_members" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_space_videos_insert" AFTER INSERT ON "space_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_space_videos_update" AFTER UPDATE ON "space_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_space_videos_delete" AFTER DELETE ON "space_videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_spaces_insert" AFTER INSERT ON "spaces" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_spaces_update" AFTER UPDATE ON "spaces" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_spaces_delete" AFTER DELETE ON "spaces" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_storage_integrations_insert" AFTER INSERT ON "storage_integrations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_storage_integrations_update" AFTER UPDATE ON "storage_integrations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_storage_integrations_delete" AFTER DELETE ON "storage_integrations" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_storage_objects_insert" AFTER INSERT ON "storage_objects" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_storage_objects_update" AFTER UPDATE ON "storage_objects" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_storage_objects_delete" AFTER DELETE ON "storage_objects" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_users_insert" AFTER INSERT ON "users" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_users_update" AFTER UPDATE ON "users" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_users_delete" AFTER DELETE ON "users" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_verification_tokens_insert" AFTER INSERT ON "verification_tokens" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_verification_tokens_update" AFTER UPDATE ON "verification_tokens" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_verification_tokens_delete" AFTER DELETE ON "verification_tokens" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_edits_insert" AFTER INSERT ON "video_edits" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_edits_update" AFTER UPDATE ON "video_edits" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_edits_delete" AFTER DELETE ON "video_edits" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_processing_jobs_insert" AFTER INSERT ON "video_processing_jobs" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_processing_jobs_update" AFTER UPDATE ON "video_processing_jobs" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_processing_jobs_delete" AFTER DELETE ON "video_processing_jobs" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_uploads_insert" AFTER INSERT ON "video_uploads" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_uploads_update" AFTER UPDATE ON "video_uploads" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_uploads_delete" AFTER DELETE ON "video_uploads" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_viewer_grants_insert" AFTER INSERT ON "video_viewer_grants" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_viewer_grants_update" AFTER UPDATE ON "video_viewer_grants" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_video_viewer_grants_delete" AFTER DELETE ON "video_viewer_grants" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_videos_insert" AFTER INSERT ON "videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_videos_update" AFTER UPDATE ON "videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER "cap_revision_videos_delete" AFTER DELETE ON "videos" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END;
