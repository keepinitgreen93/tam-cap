CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`providerAccountId` text NOT NULL,
	`access_token` text,
	`expires_in` integer,
	`id_token` text,
	`refresh_token` text,
	`refresh_token_expires_in` integer,
	`scope` text,
	`token_type` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`tempColumn` text
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`userId`);--> statement-breakpoint
CREATE INDEX `accounts_provider_account_id_idx` ON `accounts` (`providerAccountId`);--> statement-breakpoint
CREATE TABLE `agent_api_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`codeHash` text NOT NULL,
	`codeChallenge` text NOT NULL,
	`redirectUri` text NOT NULL,
	`scopes` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`consumedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_api_authorization_codes_code_hash_idx` ON `agent_api_authorization_codes` (`codeHash`);--> statement-breakpoint
CREATE INDEX `agent_api_authorization_codes_expires_at_idx` ON `agent_api_authorization_codes` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `agent_api_authorization_codes_user_created_at_idx` ON `agent_api_authorization_codes` (`userId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `agent_api_idempotency` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`operation` text NOT NULL,
	`keyHash` text NOT NULL,
	`requestHash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`statusCode` integer,
	`response` text,
	`expiresAt` integer NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_api_idempotency_user_operation_key_idx` ON `agent_api_idempotency` (`userId`,`operation`,`keyHash`);--> statement-breakpoint
CREATE INDEX `agent_api_idempotency_expires_at_idx` ON `agent_api_idempotency` (`expiresAt`);--> statement-breakpoint
CREATE TABLE `agent_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`tokenHash` text NOT NULL,
	`name` text DEFAULT 'Cap CLI' NOT NULL,
	`scopes` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`revokedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`lastUsedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_api_keys_token_hash_idx` ON `agent_api_keys` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `agent_api_keys_user_created_at_idx` ON `agent_api_keys` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `agent_api_keys_expires_at_idx` ON `agent_api_keys` (`expiresAt`);--> statement-breakpoint
CREATE TABLE `agent_api_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`kind` text NOT NULL,
	`resourceId` text NOT NULL,
	`resultResourceId` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`errorCode` text,
	`errorMessage` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completedAt` integer
);
--> statement-breakpoint
CREATE INDEX `agent_api_operations_user_created_at_idx` ON `agent_api_operations` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `agent_api_operations_state_updated_at_idx` ON `agent_api_operations` (`state`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `agent_api_operations_resource_id_idx` ON `agent_api_operations` (`resourceId`);--> statement-breakpoint
CREATE TABLE `auth_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`source` text DEFAULT 'unknown' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_api_keys_user_id_created_at_idx` ON `auth_api_keys` (`userId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`timestamp` real,
	`authorId` text NOT NULL,
	`videoId` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`parentCommentId` text,
	`mediaKey` text,
	`mediaDuration` real,
	`mediaMeta` text
);
--> statement-breakpoint
CREATE INDEX `comments_video_type_created_idx` ON `comments` (`videoId`,`type`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `comments_author_id_idx` ON `comments` (`authorId`);--> statement-breakpoint
CREATE INDEX `comments_parent_comment_id_idx` ON `comments` (`parentCommentId`);--> statement-breakpoint
CREATE TABLE `developer_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`keyType` text NOT NULL,
	`keyPrefix` text NOT NULL,
	`keyHash` text NOT NULL,
	`encryptedKey` text NOT NULL,
	`lastUsedAt` integer,
	`revokedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `developer_api_keys_key_hash_idx` ON `developer_api_keys` (`keyHash`);--> statement-breakpoint
CREATE INDEX `developer_api_keys_app_key_type_idx` ON `developer_api_keys` (`appId`,`keyType`);--> statement-breakpoint
CREATE TABLE `developer_app_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`domain` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `developer_app_domains_app_domain_unique` ON `developer_app_domains` (`appId`,`domain`);--> statement-breakpoint
CREATE TABLE `developer_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`name` text NOT NULL,
	`environment` text NOT NULL,
	`logoUrl` text,
	`deletedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `developer_apps_owner_deleted_idx` ON `developer_apps` (`ownerId`,`deletedAt`);--> statement-breakpoint
CREATE TABLE `developer_credit_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`ownerId` text NOT NULL,
	`balanceMicroCredits` integer DEFAULT 0 NOT NULL,
	`stripeCustomerId` text,
	`stripePaymentMethodId` text,
	`autoTopUpEnabled` integer DEFAULT false NOT NULL,
	`autoTopUpThresholdMicroCredits` integer DEFAULT 0 NOT NULL,
	`autoTopUpAmountCents` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "developer_credit_accounts_balanceMicroCredits_nonnegative" CHECK("developer_credit_accounts"."balanceMicroCredits" >= 0),
	CONSTRAINT "developer_credit_accounts_autoTopUpThresholdMicroCredits_nonnegative" CHECK("developer_credit_accounts"."autoTopUpThresholdMicroCredits" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `developer_credit_accounts_app_id_unique` ON `developer_credit_accounts` (`appId`);--> statement-breakpoint
CREATE TABLE `developer_credit_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`type` text NOT NULL,
	`amountMicroCredits` integer NOT NULL,
	`balanceAfterMicroCredits` integer NOT NULL,
	`referenceId` text,
	`referenceType` text,
	`metadata` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `developer_credit_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "developer_credit_transactions_balanceAfterMicroCredits_nonnegative" CHECK("developer_credit_transactions"."balanceAfterMicroCredits" >= 0)
);
--> statement-breakpoint
CREATE INDEX `developer_credit_transactions_account_type_created_idx` ON `developer_credit_transactions` (`accountId`,`type`,`createdAt`);--> statement-breakpoint
CREATE INDEX `developer_credit_transactions_account_ref_dedup_idx` ON `developer_credit_transactions` (`accountId`,`referenceId`,`referenceType`);--> statement-breakpoint
CREATE TABLE `developer_daily_storage_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`snapshotDate` text NOT NULL,
	`totalDurationMinutes` real DEFAULT 0 NOT NULL,
	`videoCount` integer DEFAULT 0 NOT NULL,
	`microCreditsCharged` integer DEFAULT 0 NOT NULL,
	`processedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "developer_daily_storage_snapshots_microCreditsCharged_nonnegative" CHECK("developer_daily_storage_snapshots"."microCreditsCharged" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `developer_daily_storage_snapshots_app_date_unique` ON `developer_daily_storage_snapshots` (`appId`,`snapshotDate`);--> statement-breakpoint
CREATE TABLE `developer_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`externalUserId` text,
	`name` text DEFAULT 'Untitled' NOT NULL,
	`duration` real,
	`width` integer,
	`height` integer,
	`fps` integer,
	`s3Key` text,
	`transcriptionStatus` text,
	`metadata` text,
	`deletedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `developer_videos_app_created_idx` ON `developer_videos` (`appId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `developer_videos_app_user_idx` ON `developer_videos` (`appId`,`externalUserId`);--> statement-breakpoint
CREATE INDEX `developer_videos_app_deleted_idx` ON `developer_videos` (`appId`,`deletedAt`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'normal' NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`settings` text,
	`organizationId` text NOT NULL,
	`createdById` text NOT NULL,
	`parentId` text,
	`spaceId` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `folders_organization_id_idx` ON `folders` (`organizationId`);--> statement-breakpoint
CREATE INDEX `folders_created_by_id_idx` ON `folders` (`createdById`);--> statement-breakpoint
CREATE INDEX `folders_parent_id_idx` ON `folders` (`parentId`);--> statement-breakpoint
CREATE INDEX `folders_space_id_idx` ON `folders` (`spaceId`);--> statement-breakpoint
CREATE INDEX `folders_public_parent_id_idx` ON `folders` (`public`,`parentId`);--> statement-breakpoint
CREATE INDEX `folders_public_space_parent_id_idx` ON `folders` (`public`,`spaceId`,`parentId`);--> statement-breakpoint
CREATE TABLE `imported_videos` (
	`id` text NOT NULL,
	`orgId` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	PRIMARY KEY(`orgId`, `source`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `imported_videos_id_idx` ON `imported_videos` (`id`);--> statement-breakpoint
CREATE TABLE `integration_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`externalId` text NOT NULL,
	`displayName` text NOT NULL,
	`organizationId` text NOT NULL,
	`installedByUserId` text NOT NULL,
	`encryptedCredentials` text NOT NULL,
	`metadata` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_installations_provider_external_id_idx` ON `integration_installations` (`provider`,`externalId`);--> statement-breakpoint
CREATE INDEX `integration_installations_organization_provider_display_name_idx` ON `integration_installations` (`organizationId`,`provider`,`displayName`);--> statement-breakpoint
CREATE TABLE `loom_migration_imports` (
	`videoId` text PRIMARY KEY NOT NULL,
	`requestId` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `loom_migration_imports_loom_migration_imports_request_idx` ON `loom_migration_imports` (`requestId`);--> statement-breakpoint
CREATE TABLE `loom_migration_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`activeOrganizationId` text,
	`requestedByUserId` text NOT NULL,
	`workspaceName` text,
	`customerNote` text,
	`customerReply` text,
	`invitedAt` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`capMessage` text,
	`expectedVideoCount` integer,
	`importedVideoCount` integer DEFAULT 0 NOT NULL,
	`queuedVideoCount` integer DEFAULT 0 NOT NULL,
	`activeImportCount` integer DEFAULT 0 NOT NULL,
	`activeImportLeaseToken` text,
	`activeImportLeaseUntil` integer,
	`lastOperatorUserId` text,
	`lastOperatorAt` integer,
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loom_migration_requests_loom_migration_active_org_idx` ON `loom_migration_requests` (`activeOrganizationId`);--> statement-breakpoint
CREATE INDEX `loom_migration_requests_loom_migration_org_created_idx` ON `loom_migration_requests` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `loom_migration_requests_loom_migration_status_created_idx` ON `loom_migration_requests` (`status`,`createdAt`);--> statement-breakpoint
CREATE TABLE `loops_sync_jobs` (
	`userId` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`nextAttemptAt` integer NOT NULL,
	`leaseToken` text,
	`leaseUntil` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`profileHash` text,
	`teammateJoinedAt` integer,
	`syncedEmail` text COLLATE NOCASE,
	`lastSyncedAt` integer
);
--> statement-breakpoint
CREATE INDEX `loops_sync_jobs_loops_sync_due_idx` ON `loops_sync_jobs` (`nextAttemptAt`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`clientName` text NOT NULL,
	`redirectUris` text NOT NULL,
	`activatedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_clients_client_id_idx` ON `mcp_oauth_clients` (`clientId`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_clients_inactive_created_at_idx` ON `mcp_oauth_clients` (`activatedAt`,`createdAt`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`clientId` text NOT NULL,
	`codeHash` text NOT NULL,
	`codeChallenge` text NOT NULL,
	`redirectUri` text NOT NULL,
	`resource` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`consumedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_codes_code_hash_idx` ON `mcp_oauth_codes` (`codeHash`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_codes_expires_at_idx` ON `mcp_oauth_codes` (`expiresAt`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_registration_quotas` (
	`windowId` text PRIMARY KEY NOT NULL,
	`registrations` integer DEFAULT 0 NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_registration_quotas_expires_at_idx` ON `mcp_oauth_registration_quotas` (`expiresAt`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`clientId` text NOT NULL,
	`familyId` text NOT NULL,
	`resource` text NOT NULL,
	`accessHash` text NOT NULL,
	`refreshHash` text NOT NULL,
	`accessExpiresAt` integer NOT NULL,
	`refreshExpiresAt` integer NOT NULL,
	`revokedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_tokens_access_hash_idx` ON `mcp_oauth_tokens` (`accessHash`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_tokens_refresh_hash_idx` ON `mcp_oauth_tokens` (`refreshHash`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_family_id_idx` ON `mcp_oauth_tokens` (`familyId`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_client_active_idx` ON `mcp_oauth_tokens` (`clientId`,`revokedAt`,`refreshExpiresAt`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_refresh_expires_at_idx` ON `mcp_oauth_tokens` (`refreshExpiresAt`);--> statement-breakpoint
CREATE TABLE `media_processing_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`limit_bytes` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "media_processing_budgets_reservedBytes_nonnegative" CHECK("media_processing_budgets"."reserved_bytes" >= 0),
	CONSTRAINT "media_processing_budgets_limitBytes_nonnegative" CHECK("media_processing_budgets"."limit_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `media_processing_budgets_media_budget_expiry_idx` ON `media_processing_budgets` (`expires_at`);--> statement-breakpoint
CREATE TABLE `messenger_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`mode` text DEFAULT 'agent' NOT NULL,
	`userId` text,
	`anonymousId` text,
	`takeoverByUserId` text,
	`takeoverAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`lastMessageAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messenger_conversations_user_last_message_idx` ON `messenger_conversations` (`userId`,`lastMessageAt`);--> statement-breakpoint
CREATE INDEX `messenger_conversations_anonymous_last_message_idx` ON `messenger_conversations` (`anonymousId`,`lastMessageAt`);--> statement-breakpoint
CREATE INDEX `messenger_conversations_mode_last_message_idx` ON `messenger_conversations` (`mode`,`lastMessageAt`);--> statement-breakpoint
CREATE INDEX `messenger_conversations_updated_at_idx` ON `messenger_conversations` (`updatedAt`);--> statement-breakpoint
CREATE TABLE `messenger_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`userId` text,
	`anonymousId` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `messenger_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messenger_messages_conversation_created_at_idx` ON `messenger_messages` (`conversationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `messenger_messages_role_created_at_idx` ON `messenger_messages` (`role`,`createdAt`);--> statement-breakpoint
CREATE TABLE `messenger_support_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`userId` text NOT NULL,
	`userEmail` text COLLATE NOCASE NOT NULL,
	`subject` text NOT NULL,
	`message` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `messenger_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messenger_support_emails_support_email_user_created_at_idx` ON `messenger_support_emails` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `messenger_support_emails_support_email_conversation_created_at_idx` ON `messenger_support_emails` (`conversationId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`orgId` text NOT NULL,
	`recipientId` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`videoId` text,
	`dedupKey` text,
	`readAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_org_id_idx` ON `notifications` (`orgId`);--> statement-breakpoint
CREATE INDEX `notifications_type_idx` ON `notifications` (`type`);--> statement-breakpoint
CREATE INDEX `notifications_read_at_idx` ON `notifications` (`readAt`);--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`createdAt`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_read_idx` ON `notifications` (`recipientId`,`readAt`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_created_idx` ON `notifications` (`recipientId`,`createdAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedup_key_idx` ON `notifications` (`dedupKey`);--> statement-breakpoint
CREATE INDEX `notifications_type_recipient_created_idx` ON `notifications` (`type`,`recipientId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `notifications_type_recipient_video_created_idx` ON `notifications` (`type`,`recipientId`,`videoId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `notifications_video_id_idx` ON `notifications` (`videoId`);--> statement-breakpoint
CREATE TABLE `organization_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`invitedEmail` text COLLATE NOCASE NOT NULL,
	`invitedByUserId` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expiresAt` integer
);
--> statement-breakpoint
CREATE INDEX `organization_invites_organization_id_idx` ON `organization_invites` (`organizationId`);--> statement-breakpoint
CREATE INDEX `organization_invites_invited_email_idx` ON `organization_invites` (`invitedEmail`);--> statement-breakpoint
CREATE INDEX `organization_invites_invited_by_user_id_idx` ON `organization_invites` (`invitedByUserId`);--> statement-breakpoint
CREATE INDEX `organization_invites_status_idx` ON `organization_invites` (`status`);--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`organizationId` text NOT NULL,
	`role` text NOT NULL,
	`hasProSeat` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organization_members_organization_id_idx` ON `organization_members` (`organizationId`);--> statement-breakpoint
CREATE INDEX `organization_members_user_id_organization_id_idx` ON `organization_members` (`userId`,`organizationId`);--> statement-breakpoint
CREATE TABLE `organization_sso` (
	`organizationId` text PRIMARY KEY NOT NULL,
	`purchasedByUserId` text NOT NULL,
	`stripeCustomerId` text,
	`stripeSubscriptionId` text,
	`stripePriceId` text,
	`status` text DEFAULT 'unpaid' NOT NULL,
	`paidThrough` integer,
	`currentPeriodEnd` integer,
	`cancelAtPeriodEnd` integer DEFAULT false NOT NULL,
	`checkoutAttemptId` text,
	`checkoutCurrency` text,
	`checkoutPriceId` text,
	`checkoutSessionId` text,
	`checkoutStartedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_sso_sso_stripe_subscription_id_idx` ON `organization_sso` (`stripeSubscriptionId`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ownerId` text NOT NULL,
	`metadata` text,
	`tombstoneAt` integer,
	`allowedEmailDomain` text,
	`defaultVideoVisibility` text,
	`customDomain` text,
	`domainVerified` integer,
	`settings` text,
	`iconUrl` text,
	`shareableLinkIconUrl` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workosOrganizationId` text,
	`workosConnectionId` text
);
--> statement-breakpoint
CREATE INDEX `organizations_owner_id_tombstone_idx` ON `organizations` (`ownerId`,`tombstoneAt`);--> statement-breakpoint
CREATE INDEX `organizations_custom_domain_idx` ON `organizations` (`customDomain`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_workos_organization_id_idx` ON `organizations` (`workosOrganizationId`);--> statement-breakpoint
CREATE TABLE `s3_buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`organizationId` text,
	`region` text NOT NULL,
	`endpoint` text,
	`bucketName` text NOT NULL,
	`accessKeyId` text NOT NULL,
	`secretAccessKey` text NOT NULL,
	`provider` text DEFAULT 'aws' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `s3_buckets_owner_organization_idx` ON `s3_buckets` (`ownerId`,`organizationId`);--> statement-breakpoint
CREATE INDEX `s3_buckets_organization_id_idx` ON `s3_buckets` (`organizationId`);--> statement-breakpoint
CREATE INDEX `s3_buckets_organization_active_idx` ON `s3_buckets` (`organizationId`,`active`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`sessionToken` text NOT NULL,
	`userId` text NOT NULL,
	`expires` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_session_token_idx` ON `sessions` (`sessionToken`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`userId`);--> statement-breakpoint
CREATE TABLE `shared_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`videoId` text NOT NULL,
	`folderId` text,
	`organizationId` text NOT NULL,
	`sharedByUserId` text NOT NULL,
	`sharedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_videos_folder_id_idx` ON `shared_videos` (`folderId`);--> statement-breakpoint
CREATE INDEX `shared_videos_organization_id_idx` ON `shared_videos` (`organizationId`);--> statement-breakpoint
CREATE INDEX `shared_videos_shared_by_user_id_idx` ON `shared_videos` (`sharedByUserId`);--> statement-breakpoint
CREATE INDEX `shared_videos_video_id_organization_id_idx` ON `shared_videos` (`videoId`,`organizationId`);--> statement-breakpoint
CREATE INDEX `shared_videos_video_id_folder_id_idx` ON `shared_videos` (`videoId`,`folderId`);--> statement-breakpoint
CREATE TABLE `signed_baas` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stripeSubscriptionId` text,
	`entityName` text NOT NULL,
	`entityType` text NOT NULL,
	`entityAddress` text NOT NULL,
	`signerName` text NOT NULL,
	`signerTitle` text NOT NULL,
	`noticesEmail` text COLLATE NOCASE NOT NULL,
	`signatureData` text NOT NULL,
	`signedAt` integer,
	`emailSentAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signed_baas_signed_baa_organization_id_idx` ON `signed_baas` (`organizationId`);--> statement-breakpoint
CREATE INDEX `signed_baas_signed_baa_stripe_subscription_idx` ON `signed_baas` (`stripeSubscriptionId`);--> statement-breakpoint
CREATE TABLE `space_members` (
	`id` text PRIMARY KEY NOT NULL,
	`spaceId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `space_members_user_id_idx` ON `space_members` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_members_space_id_user_id_unique` ON `space_members` (`spaceId`,`userId`);--> statement-breakpoint
CREATE TABLE `space_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`spaceId` text NOT NULL,
	`folderId` text,
	`videoId` text NOT NULL,
	`addedById` text NOT NULL,
	`addedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `space_videos_folder_id_idx` ON `space_videos` (`folderId`);--> statement-breakpoint
CREATE INDEX `space_videos_video_id_idx` ON `space_videos` (`videoId`);--> statement-breakpoint
CREATE INDEX `space_videos_added_by_id_idx` ON `space_videos` (`addedById`);--> statement-breakpoint
CREATE INDEX `space_videos_space_id_video_id_idx` ON `space_videos` (`spaceId`,`videoId`);--> statement-breakpoint
CREATE INDEX `space_videos_space_id_folder_id_idx` ON `space_videos` (`spaceId`,`folderId`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`organizationId` text NOT NULL,
	`createdById` text NOT NULL,
	`iconUrl` text,
	`description` text,
	`settings` text,
	`password` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`privacy` text DEFAULT 'Private' NOT NULL,
	`public` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `spaces_organization_id_idx` ON `spaces` (`organizationId`);--> statement-breakpoint
CREATE INDEX `spaces_created_by_id_idx` ON `spaces` (`createdById`);--> statement-breakpoint
CREATE INDEX `spaces_public_organization_id_idx` ON `spaces` (`public`,`organizationId`);--> statement-breakpoint
CREATE TABLE `storage_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`organizationId` text,
	`provider` text NOT NULL,
	`displayName` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`encryptedConfig` text NOT NULL,
	`googleDriveAccessToken` text,
	`googleDriveAccessTokenExpiresAt` integer,
	`googleDriveTokenRefreshLeaseId` text,
	`googleDriveTokenRefreshLeaseExpiresAt` integer,
	`googleDriveStorageQuotaCache` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `storage_integrations_owner_provider_idx` ON `storage_integrations` (`ownerId`,`provider`);--> statement-breakpoint
CREATE INDEX `storage_integrations_owner_active_idx` ON `storage_integrations` (`ownerId`,`active`);--> statement-breakpoint
CREATE INDEX `storage_integrations_organization_provider_idx` ON `storage_integrations` (`organizationId`,`provider`);--> statement-breakpoint
CREATE INDEX `storage_integrations_organization_active_idx` ON `storage_integrations` (`organizationId`,`active`,`status`);--> statement-breakpoint
CREATE TABLE `storage_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`integrationId` text NOT NULL,
	`ownerId` text NOT NULL,
	`videoId` text,
	`objectKey` text NOT NULL,
	`objectKeyHash` text NOT NULL,
	`providerObjectId` text NOT NULL,
	`uploadSessionUrl` text,
	`uploadStatus` text DEFAULT 'pending' NOT NULL,
	`contentType` text,
	`contentLength` integer,
	`metadata` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`integrationId`) REFERENCES `storage_integrations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "storage_objects_contentLength_nonnegative" CHECK("storage_objects"."contentLength" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_objects_integration_key_hash_idx` ON `storage_objects` (`integrationId`,`objectKeyHash`);--> statement-breakpoint
CREATE INDEX `storage_objects_integration_status_idx` ON `storage_objects` (`integrationId`,`uploadStatus`);--> statement-breakpoint
CREATE INDEX `storage_objects_integration_object_key_prefix_idx` ON `storage_objects` (`integrationId`,`objectKey`);--> statement-breakpoint
CREATE INDEX `storage_objects_video_id_idx` ON `storage_objects` (`videoId`);--> statement-breakpoint
CREATE INDEX `storage_objects_owner_id_idx` ON `storage_objects` (`ownerId`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`lastName` text,
	`email` text COLLATE NOCASE NOT NULL,
	`emailVerified` integer,
	`image` text,
	`stripeCustomerId` text,
	`stripeSubscriptionId` text,
	`thirdPartyStripeSubscriptionId` text,
	`stripeSubscriptionStatus` text,
	`stripeSubscriptionPriceId` text,
	`preferences` text DEFAULT 'null',
	`activeOrganizationId` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`onboardingSteps` text,
	`onboarding_completed_at` integer,
	`customBucket` text,
	`inviteQuota` integer DEFAULT 1 NOT NULL,
	`defaultOrgId` text,
	`authSessionVersion` integer DEFAULT 0 NOT NULL,
	`marketingOrigin` text DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`identifier` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_token_unique` ON `verification_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `video_edits` (
	`videoId` text PRIMARY KEY NOT NULL,
	`sourceKey` text NOT NULL,
	`editSpec` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `video_processing_jobs` (
	`video_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`generation` text NOT NULL,
	`manifest_sha256` text,
	`state` text DEFAULT 'committing' NOT NULL,
	`attempt_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`next_retry_at` integer NOT NULL,
	`workflow_run_id` text,
	`remote_job_id` text,
	`source` text,
	`verification` text,
	`output` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `video_processing_jobs_processing_state_retry_video_idx` ON `video_processing_jobs` (`state`,`next_retry_at`,`video_id`);--> statement-breakpoint
CREATE INDEX `video_processing_jobs_processing_state_lease_video_idx` ON `video_processing_jobs` (`state`,`lease_expires_at`,`video_id`);--> statement-breakpoint
CREATE TABLE `video_uploads` (
	`video_id` text PRIMARY KEY NOT NULL,
	`uploaded` integer NOT NULL,
	`total` integer NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`mode` text,
	`phase` text DEFAULT 'uploading' NOT NULL,
	`processing_progress` integer DEFAULT 0 NOT NULL,
	`processing_message` text,
	`processing_error` text,
	`raw_file_key` text,
	CONSTRAINT "video_uploads_uploaded_nonnegative" CHECK("video_uploads"."uploaded" >= 0),
	CONSTRAINT "video_uploads_total_nonnegative" CHECK("video_uploads"."total" >= 0)
);
--> statement-breakpoint
CREATE INDEX `video_uploads_phase_updated_at_video_id_idx` ON `video_uploads` (`phase`,`updated_at`,`video_id`);--> statement-breakpoint
CREATE INDEX `video_uploads_started_at_idx` ON `video_uploads` (`started_at`);--> statement-breakpoint
CREATE TABLE `video_viewer_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`videoId` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`invitedByUserId` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revokedAt` integer,
	FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_viewer_grants_video_email_idx` ON `video_viewer_grants` (`videoId`,`email`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`orgId` text NOT NULL,
	`name` text DEFAULT 'My Video' NOT NULL,
	`bucket` text,
	`storageIntegrationId` text,
	`duration` real,
	`width` integer,
	`height` integer,
	`fps` integer,
	`metadata` text,
	`public` integer DEFAULT true NOT NULL,
	`settings` text,
	`transcriptionStatus` text,
	`source` text DEFAULT '{"type":"MediaConvert"}' NOT NULL,
	`folderId` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`effectiveCreatedAt` integer GENERATED ALWAYS AS (coalesce(round(unixepoch(json_extract(metadata, '$.customCreatedAt'), 'subsec') * 1000), createdAt)) STORED,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`password` text,
	`xStreamInfo` text,
	`firstViewEmailSentAt` integer,
	`isScreenshot` integer DEFAULT false NOT NULL,
	`awsRegion` text,
	`awsBucket` text,
	`videoStartTime` text,
	`audioStartTime` text,
	`jobId` text,
	`jobStatus` text,
	`skipProcessing` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`storageIntegrationId`) REFERENCES `storage_integrations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `videos_owner_id_idx` ON `videos` (`ownerId`);--> statement-breakpoint
CREATE INDEX `videos_owner_updated_id_idx` ON `videos` (`ownerId`,`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `videos_is_public_idx` ON `videos` (`public`);--> statement-breakpoint
CREATE INDEX `videos_folder_id_idx` ON `videos` (`folderId`);--> statement-breakpoint
CREATE INDEX `videos_storage_integration_id_idx` ON `videos` (`storageIntegrationId`);--> statement-breakpoint
CREATE INDEX `videos_org_owner_folder_idx` ON `videos` (`orgId`,`ownerId`,`folderId`);--> statement-breakpoint
CREATE INDEX `videos_org_owner_folder_effective_idx` ON `videos` (`orgId`,`ownerId`,`folderId`,`effectiveCreatedAt`);--> statement-breakpoint
CREATE INDEX `videos_org_effective_created_idx` ON `videos` (`orgId`,`effectiveCreatedAt`);--> statement-breakpoint
CREATE INDEX `videos_screenshot_transcription_created_idx` ON `videos` (`isScreenshot`,`transcriptionStatus`,`createdAt`);