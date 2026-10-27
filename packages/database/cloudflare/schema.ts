import type {
	Agent,
	AiGenerationLanguage,
	Comment,
	Folder,
	ImageUpload,
	Organisation,
	PublicCollection,
	S3Bucket,
	Space,
	Storage,
	User,
	Video,
} from "@cap/web-domain";
import { sql } from "drizzle-orm";
import { relations } from "drizzle-orm/relations";
import {
	check,
	customType,
	foreignKey,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
	VideoCallToAction,
	VideoEditSpec,
	VideoMetadata,
} from "../types/index.ts";
export type AuthApiKeySource = "desktop" | "extension" | "mobile" | "unknown";
type GoogleDriveStorageQuotaCache = {
	limit?: string | null;
	usage?: string | null;
	usageInDrive?: string | null;
	usageInDriveTrash?: string | null;
	fetchedAt: string;
};
const nanoId = customType<{ data: string; notNull: true }>({
	dataType: () => "text",
});
const nanoIdRequired = (name: string) => text(name).notNull();
const nanoIdNullable = customType<{ data: string; notNull: false }>({
	dataType: () => "text",
});
const encryptedText = customType<{ data: string; notNull: true }>({
	dataType: () => "text",
});
const encryptedTextNullable = customType<{ data: string; notNull: false }>({
	dataType: () => "text",
});
const emailText = customType<{ data: string; driverData: string }>({
	dataType: () => "text COLLATE NOCASE",
});
export const users = sqliteTable(
	"users",
	{
		id: nanoId("id").notNull().primaryKey().$type<User.UserId>(),
		name: text("name"),
		lastName: text("lastName"),
		email: emailText("email").notNull(),
		emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
		image: text("image").$type<ImageUpload.ImageUrlOrKey>(),
		stripeCustomerId: text("stripeCustomerId"),
		stripeSubscriptionId: text("stripeSubscriptionId"),
		thirdPartyStripeSubscriptionId: text("thirdPartyStripeSubscriptionId"),
		stripeSubscriptionStatus: text("stripeSubscriptionStatus"),
		stripeSubscriptionPriceId: text("stripeSubscriptionPriceId"),
		preferences: text("preferences", { mode: "json" })
			.$type<{
				notifications: {
					pauseComments: boolean;
					pauseReplies: boolean;
					pauseViews: boolean;
					pauseReactions: boolean;
					pauseAnonViews?: boolean;
				};
				trackedEvents?: {
					user_signed_up?: boolean;
				};
			} | null>()
			.default(null),
		activeOrganizationId: nanoId(
			"activeOrganizationId",
		).$type<Organisation.OrganisationId>(),
		created_at: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updated_at: integer("updated_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		onboardingSteps: text("onboardingSteps", { mode: "json" }).$type<{
			welcome?: boolean;
			organizationSetup?: boolean;
			customDomain?: boolean;
			inviteTeam?: boolean;
			download?: boolean;
		}>(),
		onboarding_completed_at: integer("onboarding_completed_at", {
			mode: "timestamp_ms",
		}),
		customBucket: nanoIdNullable("customBucket"),
		inviteQuota: integer("inviteQuota").notNull().default(1),
		defaultOrgId:
			nanoIdNullable("defaultOrgId").$type<Organisation.OrganisationId>(),
		authSessionVersion: integer("authSessionVersion").notNull().default(0),
		marketingOrigin: text("marketingOrigin").notNull().default("unknown"),
	},
	(table) => ({
		emailIndex: uniqueIndex("users_email_idx").on(table.email),
	}),
);
export const loopsSyncJobs = sqliteTable(
	"loops_sync_jobs",
	{
		userId: nanoId("userId").notNull().primaryKey().$type<User.UserId>(),
		revision: integer("revision").notNull().default(1),
		nextAttemptAt: integer("nextAttemptAt", { mode: "timestamp_ms" }).notNull(),
		leaseToken: text("leaseToken"),
		leaseUntil: integer("leaseUntil", { mode: "timestamp_ms" }),
		failures: integer("failures").notNull().default(0),
		lastError: text("lastError"),
		profileHash: text("profileHash"),
		teammateJoinedAt: integer("teammateJoinedAt", { mode: "timestamp_ms" }),
		syncedEmail: emailText("syncedEmail"),
		lastSyncedAt: integer("lastSyncedAt", { mode: "timestamp_ms" }),
	},
	(table) => ({
		dueIndex: index("loops_sync_jobs_loops_sync_due_idx").on(
			table.nextAttemptAt,
		),
	}),
);
export const accounts = sqliteTable(
	"accounts",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull(),
		type: text("type").notNull(),
		provider: text("provider").notNull(),
		providerAccountId: text("providerAccountId").notNull(),
		access_token: text("access_token"),
		expires_in: integer("expires_in"),
		id_token: text("id_token"),
		refresh_token: text("refresh_token"),
		refresh_token_expires_in: integer("refresh_token_expires_in"),
		scope: text("scope"),
		token_type: text("token_type"),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date())
			.notNull(),
		tempColumn: text("tempColumn"),
	},
	(table) => ({
		userIdIndex: index("accounts_user_id_idx").on(table.userId),
		providerAccountIdIndex: index("accounts_provider_account_id_idx").on(
			table.providerAccountId,
		),
	}),
);
export const sessions = sqliteTable(
	"sessions",
	{
		id: nanoId("id").notNull().primaryKey(),
		sessionToken: text("sessionToken").notNull(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
		created_at: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updated_at: integer("updated_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		sessionTokenIndex: uniqueIndex("sessions_session_token_idx").on(
			table.sessionToken,
		),
		userIdIndex: index("sessions_user_id_idx").on(table.userId),
	}),
);
export const verificationTokens = sqliteTable("verification_tokens", {
	identifier: text("identifier").primaryKey().notNull(),
	token: text("token").unique().notNull(),
	expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
	created_at: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	updated_at: integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`)
		.$onUpdate(() => new Date()),
});
export const organizations = sqliteTable(
	"organizations",
	{
		id: nanoId("id")
			.notNull()
			.primaryKey()
			.$type<Organisation.OrganisationId>(),
		name: text("name").notNull(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		metadata: text("metadata", { mode: "json" }),
		tombstoneAt: integer("tombstoneAt", { mode: "timestamp_ms" }),
		allowedEmailDomain: text("allowedEmailDomain"),
		defaultVideoVisibility: text("defaultVideoVisibility").$type<"private">(),
		customDomain: text("customDomain"),
		domainVerified: integer("domainVerified", { mode: "timestamp_ms" }),
		settings: text("settings", { mode: "json" }).$type<{
			disableSummary?: boolean;
			disableCaptions?: boolean;
			disableChapters?: boolean;
			disableReactions?: boolean;
			disableTranscript?: boolean;
			disableComments?: boolean;
			hideShareableLinkCapLogo?: boolean;
			shareableLinkUseOrganizationIcon?: boolean;
			aiGenerationLanguage?: AiGenerationLanguage;
			defaultPlaybackSpeed?: number;
		}>(),
		iconUrl: text("iconUrl").$type<ImageUpload.ImageUrlOrKey>(),
		shareableLinkIconUrl: text(
			"shareableLinkIconUrl",
		).$type<ImageUpload.ImageUrlOrKey>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		workosOrganizationId: text("workosOrganizationId"),
		workosConnectionId: text("workosConnectionId"),
	},
	(table) => ({
		ownerIdTombstoneIndex: index("organizations_owner_id_tombstone_idx").on(
			table.ownerId,
			table.tombstoneAt,
		),
		customDomainIndex: index("organizations_custom_domain_idx").on(
			table.customDomain,
		),
		workosOrganizationIdIndex: uniqueIndex(
			"organizations_workos_organization_id_idx",
		).on(table.workosOrganizationId),
	}),
);
export const organizationSso = sqliteTable(
	"organization_sso",
	{
		organizationId: nanoId("organizationId")
			.notNull()
			.primaryKey()
			.$type<Organisation.OrganisationId>(),
		purchasedByUserId: nanoId("purchasedByUserId")
			.notNull()
			.$type<User.UserId>(),
		stripeCustomerId: text("stripeCustomerId"),
		stripeSubscriptionId: text("stripeSubscriptionId"),
		stripePriceId: text("stripePriceId"),
		status: text("status").notNull().default("unpaid"),
		paidThrough: integer("paidThrough", { mode: "timestamp_ms" }),
		currentPeriodEnd: integer("currentPeriodEnd", { mode: "timestamp_ms" }),
		cancelAtPeriodEnd: integer("cancelAtPeriodEnd", { mode: "boolean" })
			.notNull()
			.default(false),
		checkoutAttemptId: text("checkoutAttemptId"),
		checkoutCurrency: text("checkoutCurrency"),
		checkoutPriceId: text("checkoutPriceId"),
		checkoutSessionId: text("checkoutSessionId"),
		checkoutStartedAt: integer("checkoutStartedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		stripeSubscriptionIdIndex: uniqueIndex(
			"organization_sso_sso_stripe_subscription_id_idx",
		).on(table.stripeSubscriptionId),
	}),
);
export type OrganisationMemberRole = "owner" | "admin" | "member";
export const organizationMembers = sqliteTable(
	"organization_members",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		role: text("role").notNull().$type<OrganisationMemberRole>(),
		hasProSeat: integer("hasProSeat", { mode: "boolean" })
			.default(false)
			.notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		organizationIdIndex: index("organization_members_organization_id_idx").on(
			table.organizationId,
		),
		userIdOrganizationIdIndex: index(
			"organization_members_user_id_organization_id_idx",
		).on(table.userId, table.organizationId),
	}),
);
export const integrationInstallations = sqliteTable(
	"integration_installations",
	{
		id: nanoId("id").notNull().primaryKey(),
		provider: text("provider").notNull(),
		externalId: text("externalId").notNull(),
		displayName: text("displayName").notNull(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		installedByUserId: nanoId("installedByUserId")
			.notNull()
			.$type<User.UserId>(),
		encryptedCredentials: encryptedText("encryptedCredentials").notNull(),
		metadata: text("metadata", { mode: "json" })
			.notNull()
			.$type<Record<string, unknown>>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		providerExternalIdIndex: uniqueIndex(
			"integration_installations_provider_external_id_idx",
		).on(table.provider, table.externalId),
		organizationProviderDisplayNameIndex: index(
			"integration_installations_organization_provider_display_name_idx",
		).on(table.organizationId, table.provider, table.displayName),
	}),
);
export const organizationInvites = sqliteTable(
	"organization_invites",
	{
		id: nanoId("id").notNull().primaryKey(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		invitedEmail: emailText("invitedEmail").notNull(),
		invitedByUserId: nanoId("invitedByUserId").notNull().$type<User.UserId>(),
		role: text("role").notNull().$type<OrganisationMemberRole>(),
		status: text("status").notNull().default("pending"),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
	},
	(table) => ({
		organizationIdIndex: index("organization_invites_organization_id_idx").on(
			table.organizationId,
		),
		invitedEmailIndex: index("organization_invites_invited_email_idx").on(
			table.invitedEmail,
		),
		invitedByUserIdIndex: index(
			"organization_invites_invited_by_user_id_idx",
		).on(table.invitedByUserId),
		statusIndex: index("organization_invites_status_idx").on(table.status),
	}),
);
export const folders = sqliteTable(
	"folders",
	{
		id: nanoId("id").notNull().primaryKey().$type<Folder.FolderId>(),
		name: text("name").notNull(),
		color: text("color", { enum: ["normal", "blue", "red", "yellow"] })
			.notNull()
			.default("normal"),
		public: integer("public", { mode: "boolean" }).notNull().default(false),
		settings: text("settings", { mode: "json" }).$type<{
			publicPage?: PublicCollection.PublicPageSettings;
		}>(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		createdById: nanoId("createdById").notNull().$type<User.UserId>(),
		parentId: nanoIdNullable("parentId").$type<Folder.FolderId>(),
		spaceId: nanoIdNullable("spaceId").$type<Space.SpaceIdOrOrganisationId>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		organizationIdIndex: index("folders_organization_id_idx").on(
			table.organizationId,
		),
		createdByIdIndex: index("folders_created_by_id_idx").on(table.createdById),
		parentIdIndex: index("folders_parent_id_idx").on(table.parentId),
		spaceIdIndex: index("folders_space_id_idx").on(table.spaceId),
		publicParentIdIndex: index("folders_public_parent_id_idx").on(
			table.public,
			table.parentId,
		),
		publicSpaceParentIdIndex: index("folders_public_space_parent_id_idx").on(
			table.public,
			table.spaceId,
			table.parentId,
		),
	}),
);
export const videos = sqliteTable(
	"videos",
	{
		id: nanoId("id").notNull().primaryKey().$type<Video.VideoId>(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		orgId: nanoIdRequired("orgId").$type<Organisation.OrganisationId>(),
		name: text("name").notNull().default("My Video"),
		bucket: nanoIdNullable("bucket").$type<S3Bucket.S3BucketId>(),
		storageIntegrationId: nanoIdNullable("storageIntegrationId")
			.references(() => storageIntegrations.id, { onDelete: "restrict" })
			.$type<Storage.StorageIntegrationId>(),
		duration: real("duration"),
		width: integer("width"),
		height: integer("height"),
		fps: integer("fps"),
		metadata: text("metadata", { mode: "json" }).$type<VideoMetadata>(),
		public: integer("public", { mode: "boolean" }).notNull().default(true),
		settings: text("settings", { mode: "json" }).$type<{
			disableSummary?: boolean;
			disableCaptions?: boolean;
			disableChapters?: boolean;
			disableReactions?: boolean;
			disableTranscript?: boolean;
			disableComments?: boolean;
			defaultPlaybackSpeed?: number;
			callToAction?: VideoCallToAction;
		}>(),
		transcriptionStatus: text("transcriptionStatus").$type<
			"PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED" | "NO_AUDIO"
		>(),
		source: text("source", { mode: "json" })
			.$type<
				| {
						type: "MediaConvert";
				  }
				| {
						type: "local";
				  }
				| {
						type: "desktopMP4";
						outputKey?: string;
						audioLevelOutputKey?: string;
						audioLevelSourceKey?: string;
						thumbnailKey?: string;
						previewKey?: string;
				  }
				| {
						type: "desktopSegments";
				  }
				| {
						type: "webMP4";
						outputKey?: string;
						thumbnailKey?: string;
						previewKey?: string;
						audioLevelOutputKey?: string;
						audioLevelSourceKey?: string;
				  }
			>()
			.notNull()
			.default({ type: "MediaConvert" }),
		folderId: nanoIdNullable("folderId").$type<Folder.FolderId>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		effectiveCreatedAt: integer("effectiveCreatedAt", {
			mode: "timestamp_ms",
		}).generatedAlwaysAs(
			sql`coalesce(round(unixepoch(json_extract(metadata, '$.customCreatedAt'), 'subsec') * 1000), createdAt)`,
			{ mode: "stored" },
		),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		password: encryptedTextNullable("password"),
		xStreamInfo: text("xStreamInfo"),
		firstViewEmailSentAt: integer("firstViewEmailSentAt", {
			mode: "timestamp_ms",
		}),
		isScreenshot: integer("isScreenshot", { mode: "boolean" })
			.notNull()
			.default(false),
		awsRegion: text("awsRegion"),
		awsBucket: text("awsBucket"),
		videoStartTime: text("videoStartTime"),
		audioStartTime: text("audioStartTime"),
		jobId: text("jobId"),
		jobStatus: text("jobStatus"),
		skipProcessing: integer("skipProcessing", { mode: "boolean" })
			.notNull()
			.default(false),
	},
	(table) => [
		index("videos_owner_id_idx").on(table.ownerId),
		index("videos_owner_updated_id_idx").on(
			table.ownerId,
			table.updatedAt,
			table.id,
		),
		index("videos_is_public_idx").on(table.public),
		index("videos_folder_id_idx").on(table.folderId),
		index("videos_storage_integration_id_idx").on(table.storageIntegrationId),
		index("videos_org_owner_folder_idx").on(
			table.orgId,
			table.ownerId,
			table.folderId,
		),
		index("videos_org_owner_folder_effective_idx").on(
			table.orgId,
			table.ownerId,
			table.folderId,
			table.effectiveCreatedAt,
		),
		index("videos_org_effective_created_idx").on(
			table.orgId,
			table.effectiveCreatedAt,
		),
		index("videos_screenshot_transcription_created_idx").on(
			table.isScreenshot,
			table.transcriptionStatus,
			table.createdAt,
		),
	],
);
export const videoEdits = sqliteTable("video_edits", {
	videoId: nanoId("videoId")
		.notNull()
		.primaryKey()
		.$type<Video.VideoId>()
		.references(() => videos.id, { onDelete: "cascade" }),
	sourceKey: text("sourceKey").notNull(),
	editSpec: text("editSpec", { mode: "json" }).notNull().$type<VideoEditSpec>(),
	createdAt: integer("createdAt", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
		.notNull()
		.default(sql`(unixepoch() * 1000)`)
		.$onUpdate(() => new Date()),
});
export const sharedVideos = sqliteTable(
	"shared_videos",
	{
		id: nanoId("id").notNull().primaryKey(),
		videoId: nanoId("videoId").notNull().$type<Video.VideoId>(),
		folderId: nanoIdNullable("folderId").$type<Folder.FolderId>(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		sharedByUserId: nanoId("sharedByUserId").notNull().$type<User.UserId>(),
		sharedAt: integer("sharedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => ({
		folderIdIndex: index("shared_videos_folder_id_idx").on(table.folderId),
		organizationIdIndex: index("shared_videos_organization_id_idx").on(
			table.organizationId,
		),
		sharedByUserIdIndex: index("shared_videos_shared_by_user_id_idx").on(
			table.sharedByUserId,
		),
		videoIdOrganizationIdIndex: index(
			"shared_videos_video_id_organization_id_idx",
		).on(table.videoId, table.organizationId),
		videoIdFolderIdIndex: index("shared_videos_video_id_folder_id_idx").on(
			table.videoId,
			table.folderId,
		),
	}),
);
export const videoViewerGrants = sqliteTable(
	"video_viewer_grants",
	{
		id: nanoId("id").notNull().primaryKey(),
		videoId: nanoId("videoId")
			.notNull()
			.$type<Video.VideoId>()
			.references(() => videos.id, { onDelete: "cascade" }),
		email: emailText("email").notNull(),
		invitedByUserId: nanoId("invitedByUserId").notNull().$type<User.UserId>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		revokedAt: integer("revokedAt", { mode: "timestamp_ms" }),
	},
	(table) => ({
		videoEmailUnique: uniqueIndex("video_viewer_grants_video_email_idx").on(
			table.videoId,
			table.email,
		),
	}),
);
export const comments = sqliteTable(
	"comments",
	{
		id: nanoId("id").notNull().primaryKey().$type<Comment.CommentId>(),
		type: text("type", { enum: ["emoji", "text", "video", "audio"] }).notNull(),
		content: text("content").notNull(),
		timestamp: real("timestamp"),
		authorId: nanoId("authorId").notNull().$type<User.UserId>(),
		videoId: nanoId("videoId").notNull().$type<Video.VideoId>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		parentCommentId:
			nanoIdNullable("parentCommentId").$type<Comment.CommentId>(),
		mediaKey: text("mediaKey"),
		mediaDuration: real("mediaDuration"),
		mediaMeta: text("mediaMeta", { mode: "json" }).$type<Comment.MediaMeta>(),
	},
	(table) => ({
		videoTypeCreatedIndex: index("comments_video_type_created_idx").on(
			table.videoId,
			table.type,
			table.createdAt,
			table.id,
		),
		authorIdIndex: index("comments_author_id_idx").on(table.authorId),
		parentCommentIdIndex: index("comments_parent_comment_id_idx").on(
			table.parentCommentId,
		),
	}),
);
export const notifications = sqliteTable(
	"notifications",
	{
		id: nanoId("id").notNull().primaryKey(),
		orgId: nanoId("orgId").notNull().$type<Organisation.OrganisationId>(),
		recipientId: nanoId("recipientId").notNull().$type<User.UserId>(),
		type: text("type")
			.notNull()
			.$type<"view" | "comment" | "reply" | "reaction" | "anon_view">(),
		data: text("data", { mode: "json" })
			.$type<{
				videoId?: string;
				authorId?: string;
				comment?: {
					id: string;
					content: string;
				};
				anonName?: string;
				location?: string | null;
			}>()
			.notNull(),
		videoId: text("videoId"),
		dedupKey: text("dedupKey"),
		readAt: integer("readAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => ({
		orgIdIndex: index("notifications_org_id_idx").on(table.orgId),
		typeIndex: index("notifications_type_idx").on(table.type),
		readAtIndex: index("notifications_read_at_idx").on(table.readAt),
		createdAtIndex: index("notifications_created_at_idx").on(table.createdAt),
		recipientReadIndex: index("notifications_recipient_read_idx").on(
			table.recipientId,
			table.readAt,
		),
		recipientCreatedIndex: index("notifications_recipient_created_idx").on(
			table.recipientId,
			table.createdAt,
		),
		dedupKeyUnique: uniqueIndex("notifications_dedup_key_idx").on(
			table.dedupKey,
		),
		typeRecipientCreatedIndex: index(
			"notifications_type_recipient_created_idx",
		).on(table.type, table.recipientId, table.createdAt),
		typeRecipientVideoCreatedIndex: index(
			"notifications_type_recipient_video_created_idx",
		).on(table.type, table.recipientId, table.videoId, table.createdAt),
		videoIdIndex: index("notifications_video_id_idx").on(table.videoId),
	}),
);
export type MessengerAgent = "Millie";
export type MessengerConversationMode = "agent" | "human";
export type MessengerMessageRole = "user" | "agent" | "admin";
export const messengerConversations = sqliteTable(
	"messenger_conversations",
	{
		id: nanoId("id").notNull().primaryKey(),
		agent: text("agent", { enum: ["Millie"] })
			.notNull()
			.$type<MessengerAgent>(),
		mode: text("mode", { enum: ["agent", "human"] })
			.notNull()
			.default("agent")
			.$type<MessengerConversationMode>(),
		userId: nanoIdNullable("userId").$type<User.UserId>(),
		anonymousId: text("anonymousId"),
		takeoverByUserId: nanoIdNullable("takeoverByUserId").$type<User.UserId>(),
		takeoverAt: integer("takeoverAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		lastMessageAt: integer("lastMessageAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => ({
		userLastMessageIndex: index(
			"messenger_conversations_user_last_message_idx",
		).on(table.userId, table.lastMessageAt),
		anonymousLastMessageIndex: index(
			"messenger_conversations_anonymous_last_message_idx",
		).on(table.anonymousId, table.lastMessageAt),
		modeLastMessageIndex: index(
			"messenger_conversations_mode_last_message_idx",
		).on(table.mode, table.lastMessageAt),
		updatedAtIndex: index("messenger_conversations_updated_at_idx").on(
			table.updatedAt,
		),
	}),
);
export const messengerMessages = sqliteTable(
	"messenger_messages",
	{
		id: nanoId("id").notNull().primaryKey(),
		conversationId: nanoId("conversationId")
			.notNull()
			.references(() => messengerConversations.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["user", "agent", "admin"] })
			.notNull()
			.$type<MessengerMessageRole>(),
		content: text("content").notNull(),
		userId: nanoIdNullable("userId").$type<User.UserId>(),
		anonymousId: text("anonymousId"),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => ({
		conversationCreatedAtIndex: index(
			"messenger_messages_conversation_created_at_idx",
		).on(table.conversationId, table.createdAt),
		roleCreatedAtIndex: index("messenger_messages_role_created_at_idx").on(
			table.role,
			table.createdAt,
		),
	}),
);
export const messengerSupportEmails = sqliteTable(
	"messenger_support_emails",
	{
		id: nanoId("id").notNull().primaryKey(),
		conversationId: nanoId("conversationId").notNull(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		userEmail: emailText("userEmail").notNull(),
		subject: text("subject").notNull(),
		message: text("message").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => ({
		conversationForeignKey: foreignKey({
			name: "support_email_conversation_fk",
			columns: [table.conversationId],
			foreignColumns: [messengerConversations.id],
		}).onDelete("cascade"),
		userCreatedAtIndex: index(
			"messenger_support_emails_support_email_user_created_at_idx",
		).on(table.userId, table.createdAt),
		conversationCreatedAtIndex: index(
			"messenger_support_emails_support_email_conversation_created_at_idx",
		).on(table.conversationId, table.createdAt),
	}),
);
export const signedBaas = sqliteTable(
	"signed_baas",
	{
		id: nanoId("id").notNull().primaryKey(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		status: text("status").notNull().default("pending"),
		stripeSubscriptionId: text("stripeSubscriptionId"),
		entityName: text("entityName").notNull(),
		entityType: text("entityType").notNull(),
		entityAddress: text("entityAddress").notNull(),
		signerName: text("signerName").notNull(),
		signerTitle: text("signerTitle").notNull(),
		noticesEmail: emailText("noticesEmail").notNull(),
		signatureData: text("signatureData").notNull(),
		signedAt: integer("signedAt", { mode: "timestamp_ms" }),
		emailSentAt: integer("emailSentAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		organizationIdIndex: uniqueIndex(
			"signed_baas_signed_baa_organization_id_idx",
		).on(table.organizationId),
		stripeSubscriptionIdIndex: index(
			"signed_baas_signed_baa_stripe_subscription_idx",
		).on(table.stripeSubscriptionId),
	}),
);
export const s3Buckets = sqliteTable(
	"s3_buckets",
	{
		id: nanoId("id").notNull().primaryKey().$type<S3Bucket.S3BucketId>(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		organizationId:
			nanoIdNullable("organizationId").$type<Organisation.OrganisationId>(),
		region: encryptedText("region").notNull(),
		endpoint: encryptedTextNullable("endpoint"),
		bucketName: encryptedText("bucketName").notNull(),
		accessKeyId: encryptedText("accessKeyId").notNull(),
		secretAccessKey: encryptedText("secretAccessKey").notNull(),
		provider: text("provider").notNull().default("aws"),
		active: integer("active", { mode: "boolean" }).notNull().default(true),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		ownerOrganizationIndex: index("s3_buckets_owner_organization_idx").on(
			table.ownerId,
			table.organizationId,
		),
		organizationIdIndex: index("s3_buckets_organization_id_idx").on(
			table.organizationId,
		),
		organizationActiveIndex: index("s3_buckets_organization_active_idx").on(
			table.organizationId,
			table.active,
			table.updatedAt,
		),
	}),
);
export const storageIntegrations = sqliteTable(
	"storage_integrations",
	{
		id: nanoId("id")
			.notNull()
			.primaryKey()
			.$type<Storage.StorageIntegrationId>(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		organizationId:
			nanoIdNullable("organizationId").$type<Organisation.OrganisationId>(),
		provider: text("provider").notNull().$type<Storage.StorageProvider>(),
		displayName: text("displayName").notNull(),
		status: text("status")
			.notNull()
			.default("active")
			.$type<Storage.StorageIntegrationStatus>(),
		active: integer("active", { mode: "boolean" }).notNull().default(false),
		encryptedConfig: encryptedText("encryptedConfig").notNull(),
		googleDriveAccessToken: encryptedTextNullable("googleDriveAccessToken"),
		googleDriveAccessTokenExpiresAt: integer(
			"googleDriveAccessTokenExpiresAt",
			{ mode: "timestamp_ms" },
		),
		googleDriveTokenRefreshLeaseId: text("googleDriveTokenRefreshLeaseId"),
		googleDriveTokenRefreshLeaseExpiresAt: integer(
			"googleDriveTokenRefreshLeaseExpiresAt",
			{ mode: "timestamp_ms" },
		),
		googleDriveStorageQuotaCache: text("googleDriveStorageQuotaCache", {
			mode: "json",
		}).$type<GoogleDriveStorageQuotaCache>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		ownerProviderIndex: index("storage_integrations_owner_provider_idx").on(
			table.ownerId,
			table.provider,
		),
		ownerActiveIndex: index("storage_integrations_owner_active_idx").on(
			table.ownerId,
			table.active,
		),
		organizationProviderIndex: index(
			"storage_integrations_organization_provider_idx",
		).on(table.organizationId, table.provider),
		organizationActiveIndex: index(
			"storage_integrations_organization_active_idx",
		).on(table.organizationId, table.active, table.status),
	}),
);
export const storageObjects = sqliteTable(
	"storage_objects",
	{
		id: nanoId("id").notNull().primaryKey().$type<Storage.StorageObjectId>(),
		integrationId: nanoId("integrationId")
			.notNull()
			.references(() => storageIntegrations.id, { onDelete: "restrict" })
			.$type<Storage.StorageIntegrationId>(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		videoId: nanoIdNullable("videoId").$type<Video.VideoId>(),
		objectKey: text("objectKey").notNull(),
		objectKeyHash: text("objectKeyHash").notNull(),
		providerObjectId: text("providerObjectId").notNull(),
		uploadSessionUrl: encryptedTextNullable("uploadSessionUrl"),
		uploadStatus: text("uploadStatus")
			.notNull()
			.default("pending")
			.$type<"pending" | "complete" | "error">(),
		contentType: text("contentType"),
		contentLength: integer("contentLength"),
		metadata: text("metadata", {
			mode: "json",
		}).$type<Storage.StorageObjectMetadata>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		contentLengthNonnegative: check(
			"storage_objects_contentLength_nonnegative",
			sql`${table.contentLength} >= 0`,
		),

		integrationKeyHashIndex: uniqueIndex(
			"storage_objects_integration_key_hash_idx",
		).on(table.integrationId, table.objectKeyHash),
		integrationStatusIndex: index("storage_objects_integration_status_idx").on(
			table.integrationId,
			table.uploadStatus,
		),
		integrationObjectKeyPrefixIndex: index(
			"storage_objects_integration_object_key_prefix_idx",
		).on(table.integrationId, table.objectKey),
		videoIdIndex: index("storage_objects_video_id_idx").on(table.videoId),
		ownerIdIndex: index("storage_objects_owner_id_idx").on(table.ownerId),
	}),
);
export const notificationsRelations = relations(notifications, ({ one }) => ({
	org: one(organizations, {
		fields: [notifications.orgId],
		references: [organizations.id],
	}),
	recipient: one(users, {
		fields: [notifications.recipientId],
		references: [users.id],
	}),
}));
export const authApiKeys = sqliteTable(
	"auth_api_keys",
	{
		id: text("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		source: text("source")
			.notNull()
			.default("unknown")
			.$type<AuthApiKeySource>(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => ({
		userIdCreatedAtIndex: index("auth_api_keys_user_id_created_at_idx").on(
			table.userId,
			table.createdAt,
		),
	}),
);
export const agentApiKeys = sqliteTable(
	"agent_api_keys",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		tokenHash: text("tokenHash").notNull(),
		name: text("name").notNull().default("Cap CLI"),
		scopes: text("scopes", { mode: "json" })
			.notNull()
			.$type<Agent.AgentScope[]>(),
		expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
		revokedAt: integer("revokedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastUsedAt: integer("lastUsedAt", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("agent_api_keys_token_hash_idx").on(table.tokenHash),
		index("agent_api_keys_user_created_at_idx").on(
			table.userId,
			table.createdAt,
		),
		index("agent_api_keys_expires_at_idx").on(table.expiresAt),
	],
);
export const agentApiIdempotency = sqliteTable(
	"agent_api_idempotency",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		operation: text("operation").notNull(),
		keyHash: text("keyHash").notNull(),
		requestHash: text("requestHash").notNull(),
		state: text("state", { enum: ["pending", "complete"] })
			.notNull()
			.default("pending"),
		statusCode: integer("statusCode"),
		response: text("response", { mode: "json" }).$type<unknown>(),
		expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex("agent_api_idempotency_user_operation_key_idx").on(
			table.userId,
			table.operation,
			table.keyHash,
		),
		index("agent_api_idempotency_expires_at_idx").on(table.expiresAt),
	],
);
export const agentApiAuthorizationCodes = sqliteTable(
	"agent_api_authorization_codes",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		codeHash: text("codeHash").notNull(),
		codeChallenge: text("codeChallenge").notNull(),
		redirectUri: text("redirectUri").notNull(),
		scopes: text("scopes", { mode: "json" })
			.notNull()
			.$type<Agent.AgentScope[]>(),
		expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
		consumedAt: integer("consumedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("agent_api_authorization_codes_code_hash_idx").on(
			table.codeHash,
		),
		index("agent_api_authorization_codes_expires_at_idx").on(table.expiresAt),
		index("agent_api_authorization_codes_user_created_at_idx").on(
			table.userId,
			table.createdAt,
		),
	],
);
export const mcpOAuthClients = sqliteTable(
	"mcp_oauth_clients",
	{
		id: nanoId("id").notNull().primaryKey(),
		clientId: text("clientId").notNull(),
		clientName: text("clientName").notNull(),
		redirectUris: text("redirectUris", { mode: "json" })
			.notNull()
			.$type<string[]>(),
		activatedAt: integer("activatedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("mcp_oauth_clients_client_id_idx").on(table.clientId),
		index("mcp_oauth_clients_inactive_created_at_idx").on(
			table.activatedAt,
			table.createdAt,
		),
	],
);
export const mcpOAuthRegistrationQuotas = sqliteTable(
	"mcp_oauth_registration_quotas",
	{
		windowId: text("windowId").notNull().primaryKey(),
		registrations: integer("registrations").notNull().default(0),
		expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("mcp_oauth_registration_quotas_expires_at_idx").on(table.expiresAt),
	],
);
export const mcpOAuthCodes = sqliteTable(
	"mcp_oauth_codes",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		clientId: text("clientId").notNull(),
		codeHash: text("codeHash").notNull(),
		codeChallenge: text("codeChallenge").notNull(),
		redirectUri: text("redirectUri").notNull(),
		resource: text("resource").notNull(),
		expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
		consumedAt: integer("consumedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("mcp_oauth_codes_code_hash_idx").on(table.codeHash),
		index("mcp_oauth_codes_expires_at_idx").on(table.expiresAt),
	],
);
export const mcpOAuthTokens = sqliteTable(
	"mcp_oauth_tokens",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		clientId: text("clientId").notNull(),
		familyId: nanoId("familyId").notNull(),
		resource: text("resource").notNull(),
		accessHash: text("accessHash").notNull(),
		refreshHash: text("refreshHash").notNull(),
		accessExpiresAt: integer("accessExpiresAt", {
			mode: "timestamp_ms",
		}).notNull(),
		refreshExpiresAt: integer("refreshExpiresAt", {
			mode: "timestamp_ms",
		}).notNull(),
		revokedAt: integer("revokedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("mcp_oauth_tokens_access_hash_idx").on(table.accessHash),
		uniqueIndex("mcp_oauth_tokens_refresh_hash_idx").on(table.refreshHash),
		index("mcp_oauth_tokens_family_id_idx").on(table.familyId),
		index("mcp_oauth_tokens_client_active_idx").on(
			table.clientId,
			table.revokedAt,
			table.refreshExpiresAt,
		),
		index("mcp_oauth_tokens_refresh_expires_at_idx").on(table.refreshExpiresAt),
	],
);
export const agentApiOperations = sqliteTable(
	"agent_api_operations",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		kind: text("kind", {
			enum: [
				"duplicate_cap",
				"delete_cap",
				"import_loom",
				"delete_organization",
				"set_organization_domain",
				"remove_organization_domain",
				"verify_organization_domain",
				"transfer_org_content",
			],
		}).notNull(),
		resourceId: nanoId("resourceId").notNull(),
		resultResourceId: nanoIdNullable("resultResourceId"),
		state: text("state", { enum: ["queued", "running", "succeeded", "failed"] })
			.notNull()
			.default("queued"),
		payload: text("payload", { mode: "json" }).notNull().$type<unknown>(),
		result: text("result", { mode: "json" }).$type<unknown>(),
		errorCode: text("errorCode"),
		errorMessage: text("errorMessage"),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		completedAt: integer("completedAt", { mode: "timestamp_ms" }),
	},
	(table) => [
		index("agent_api_operations_user_created_at_idx").on(
			table.userId,
			table.createdAt,
		),
		index("agent_api_operations_state_updated_at_idx").on(
			table.state,
			table.updatedAt,
		),
		index("agent_api_operations_resource_id_idx").on(table.resourceId),
	],
);
export const commentsRelations = relations(comments, ({ one }) => ({
	author: one(users, {
		fields: [comments.authorId],
		references: [users.id],
	}),
	video: one(videos, {
		fields: [comments.videoId],
		references: [videos.id],
	}),
	parentComment: one(comments, {
		fields: [comments.parentCommentId],
		references: [comments.id],
	}),
}));
export const messengerConversationsRelations = relations(
	messengerConversations,
	({ one, many }) => ({
		user: one(users, {
			fields: [messengerConversations.userId],
			references: [users.id],
		}),
		messages: many(messengerMessages),
		supportEmails: many(messengerSupportEmails),
	}),
);
export const messengerMessagesRelations = relations(
	messengerMessages,
	({ one }) => ({
		conversation: one(messengerConversations, {
			fields: [messengerMessages.conversationId],
			references: [messengerConversations.id],
		}),
		user: one(users, {
			fields: [messengerMessages.userId],
			references: [users.id],
		}),
	}),
);
export const messengerSupportEmailsRelations = relations(
	messengerSupportEmails,
	({ one }) => ({
		conversation: one(messengerConversations, {
			fields: [messengerSupportEmails.conversationId],
			references: [messengerConversations.id],
		}),
		user: one(users, {
			fields: [messengerSupportEmails.userId],
			references: [users.id],
		}),
	}),
);
export const usersRelations = relations(users, ({ many, one }) => ({
	accounts: many(accounts),
	sessions: many(sessions),
	organizationMembers: many(organizationMembers),
	videos: many(videos),
	sharedVideos: many(sharedVideos),
	customBucket: one(s3Buckets),
	storageIntegrations: many(storageIntegrations),
	spaces: many(spaces),
	spaceMembers: many(spaceMembers),
	messengerConversations: many(messengerConversations),
	messengerMessages: many(messengerMessages),
	messengerSupportEmails: many(messengerSupportEmails),
	integrationInstallations: many(integrationInstallations),
}));
export const accountsRelations = relations(accounts, ({ one }) => ({
	user: one(users, {
		fields: [accounts.userId],
		references: [users.id],
	}),
}));
export const s3BucketsRelations = relations(s3Buckets, ({ one }) => ({
	owner: one(users, {
		fields: [s3Buckets.ownerId],
		references: [users.id],
	}),
	organization: one(organizations, {
		fields: [s3Buckets.organizationId],
		references: [organizations.id],
	}),
}));
export const storageIntegrationsRelations = relations(
	storageIntegrations,
	({ one, many }) => ({
		owner: one(users, {
			fields: [storageIntegrations.ownerId],
			references: [users.id],
		}),
		organization: one(organizations, {
			fields: [storageIntegrations.organizationId],
			references: [organizations.id],
		}),
		objects: many(storageObjects),
	}),
);
export const storageObjectsRelations = relations(storageObjects, ({ one }) => ({
	integration: one(storageIntegrations, {
		fields: [storageObjects.integrationId],
		references: [storageIntegrations.id],
	}),
	video: one(videos, {
		fields: [storageObjects.videoId],
		references: [videos.id],
	}),
}));
export const organizationsRelations = relations(
	organizations,
	({ one, many }) => ({
		owner: one(users, {
			fields: [organizations.ownerId],
			references: [users.id],
		}),
		organizationMembers: many(organizationMembers),
		sharedVideos: many(sharedVideos),
		organizationInvites: many(organizationInvites),
		spaces: many(spaces),
		s3Buckets: many(s3Buckets),
		storageIntegrations: many(storageIntegrations),
		integrationInstallations: many(integrationInstallations),
	}),
);
export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, {
		fields: [sessions.userId],
		references: [users.id],
	}),
}));
export const verificationTokensRelations = relations(
	verificationTokens,
	() => ({}),
);
export const organizationMembersRelations = relations(
	organizationMembers,
	({ one }) => ({
		user: one(users, {
			fields: [organizationMembers.userId],
			references: [users.id],
		}),
		organization: one(organizations, {
			fields: [organizationMembers.organizationId],
			references: [organizations.id],
		}),
	}),
);
export const integrationInstallationsRelations = relations(
	integrationInstallations,
	({ one }) => ({
		organization: one(organizations, {
			fields: [integrationInstallations.organizationId],
			references: [organizations.id],
		}),
		installedByUser: one(users, {
			fields: [integrationInstallations.installedByUserId],
			references: [users.id],
		}),
	}),
);
export const organizationInvitesRelations = relations(
	organizationInvites,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationInvites.organizationId],
			references: [organizations.id],
		}),
		invitedByUser: one(users, {
			fields: [organizationInvites.invitedByUserId],
			references: [users.id],
		}),
	}),
);
export const videosRelations = relations(videos, ({ one, many }) => ({
	owner: one(users, {
		fields: [videos.ownerId],
		references: [users.id],
	}),
	sharedVideos: many(sharedVideos),
	spaceVideos: many(spaceVideos),
	edit: one(videoEdits, {
		fields: [videos.id],
		references: [videoEdits.videoId],
	}),
	folder: one(folders, {
		fields: [videos.folderId],
		references: [folders.id],
	}),
	storageIntegration: one(storageIntegrations, {
		fields: [videos.storageIntegrationId],
		references: [storageIntegrations.id],
	}),
}));
export const videoEditsRelations = relations(videoEdits, ({ one }) => ({
	video: one(videos, {
		fields: [videoEdits.videoId],
		references: [videos.id],
	}),
}));
export const sharedVideosRelations = relations(sharedVideos, ({ one }) => ({
	video: one(videos, {
		fields: [sharedVideos.videoId],
		references: [videos.id],
	}),
	organization: one(organizations, {
		fields: [sharedVideos.organizationId],
		references: [organizations.id],
	}),
	sharedByUser: one(users, {
		fields: [sharedVideos.sharedByUserId],
		references: [users.id],
	}),
}));
export const spaces = sqliteTable(
	"spaces",
	{
		id: nanoId("id")
			.notNull()
			.primaryKey()
			.$type<Space.SpaceIdOrOrganisationId>(),
		primary: integer("primary", { mode: "boolean" }).notNull().default(false),
		name: text("name").notNull(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		createdById: nanoId("createdById").notNull().$type<User.UserId>(),
		iconUrl: text("iconUrl").$type<ImageUpload.ImageUrlOrKey>(),
		description: text("description"),
		settings: text("settings", { mode: "json" }).$type<{
			disableSummary?: boolean;
			disableCaptions?: boolean;
			disableChapters?: boolean;
			disableReactions?: boolean;
			disableTranscript?: boolean;
			disableComments?: boolean;
			publicPage?: PublicCollection.PublicPageSettings;
		}>(),
		password: encryptedTextNullable("password"),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
		privacy: text("privacy", { enum: ["Public", "Private"] })
			.notNull()
			.default("Private"),
		public: integer("public", { mode: "boolean" }).notNull().default(false),
	},
	(table) => ({
		organizationIdIndex: index("spaces_organization_id_idx").on(
			table.organizationId,
		),
		createdByIdIndex: index("spaces_created_by_id_idx").on(table.createdById),
		publicOrganizationIdIndex: index("spaces_public_organization_id_idx").on(
			table.public,
			table.organizationId,
		),
	}),
);
export const spaceMembers = sqliteTable(
	"space_members",
	{
		id: nanoId("id").notNull().primaryKey(),
		spaceId: nanoId("spaceId").notNull().$type<Space.SpaceIdOrOrganisationId>(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		role: text("role").notNull().default("member").$type<"admin" | "member">(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => ({
		userIdIndex: index("space_members_user_id_idx").on(table.userId),
		spaceIdUserIdUnique: unique("space_members_space_id_user_id_unique").on(
			table.spaceId,
			table.userId,
		),
	}),
);
export const spaceVideos = sqliteTable(
	"space_videos",
	{
		id: nanoId("id").notNull().primaryKey(),
		spaceId: nanoId("spaceId").notNull().$type<Space.SpaceIdOrOrganisationId>(),
		folderId: nanoIdNullable("folderId").$type<Folder.FolderId>(),
		videoId: nanoId("videoId").notNull().$type<Video.VideoId>(),
		addedById: nanoId("addedById").notNull().$type<User.UserId>(),
		addedAt: integer("addedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => ({
		folderIdIndex: index("space_videos_folder_id_idx").on(table.folderId),
		videoIdIndex: index("space_videos_video_id_idx").on(table.videoId),
		addedByIdIndex: index("space_videos_added_by_id_idx").on(table.addedById),
		spaceIdVideoIdIndex: index("space_videos_space_id_video_id_idx").on(
			table.spaceId,
			table.videoId,
		),
		spaceIdFolderIdIndex: index("space_videos_space_id_folder_id_idx").on(
			table.spaceId,
			table.folderId,
		),
	}),
);
export const spacesRelations = relations(spaces, ({ one, many }) => ({
	organization: one(organizations, {
		fields: [spaces.organizationId],
		references: [organizations.id],
	}),
	createdBy: one(users, {
		fields: [spaces.createdById],
		references: [users.id],
	}),
	spaceMembers: many(spaceMembers),
	spaceVideos: many(spaceVideos),
}));
export const spaceMembersRelations = relations(spaceMembers, ({ one }) => ({
	space: one(spaces, {
		fields: [spaceMembers.spaceId],
		references: [spaces.id],
	}),
	user: one(users, {
		fields: [spaceMembers.userId],
		references: [users.id],
	}),
}));
export const spaceVideosRelations = relations(spaceVideos, ({ one }) => ({
	space: one(spaces, {
		fields: [spaceVideos.spaceId],
		references: [spaces.id],
	}),
	video: one(videos, {
		fields: [spaceVideos.videoId],
		references: [videos.id],
	}),
	addedBy: one(users, {
		fields: [spaceVideos.addedById],
		references: [users.id],
	}),
}));
export const foldersRelations = relations(folders, ({ one, many }) => ({
	organization: one(organizations, {
		fields: [folders.organizationId],
		references: [organizations.id],
	}),
	createdBy: one(users, {
		fields: [folders.createdById],
		references: [users.id],
	}),
	parentFolder: one(folders, {
		fields: [folders.parentId],
		references: [folders.id],
		relationName: "parentChild",
	}),
	childFolders: many(folders, { relationName: "parentChild" }),
	videos: many(videos),
}));
export const videoUploads = sqliteTable(
	"video_uploads",
	{
		videoId: nanoId("video_id").primaryKey().notNull().$type<Video.VideoId>(),
		uploaded: integer("uploaded")
			.notNull()
			.$defaultFn(() => 0),
		total: integer("total")
			.notNull()
			.$defaultFn(() => 0),
		startedAt: integer("started_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		mode: text("mode", { enum: ["singlepart", "multipart"] }),
		phase: text("phase")
			.$type<
				| "uploading"
				| "processing"
				| "generating_thumbnail"
				| "complete"
				| "error"
			>()
			.notNull()
			.default("uploading"),
		processingProgress: integer("processing_progress").notNull().default(0),
		processingMessage: text("processing_message"),
		processingError: text("processing_error"),
		rawFileKey: text("raw_file_key"),
	},
	(table) => [
		check("video_uploads_uploaded_nonnegative", sql`${table.uploaded} >= 0`),
		check("video_uploads_total_nonnegative", sql`${table.total} >= 0`),

		index("video_uploads_phase_updated_at_video_id_idx").on(
			table.phase,
			table.updatedAt,
			table.videoId,
		),
		index("video_uploads_started_at_idx").on(table.startedAt),
	],
);
export const videoProcessingJobs = sqliteTable(
	"video_processing_jobs",
	{
		videoId: nanoId("video_id").primaryKey().notNull().$type<Video.VideoId>(),
		ownerId: nanoId("owner_id").notNull().$type<User.UserId>(),
		generation: text("generation").notNull(),
		manifestSha256: text("manifest_sha256"),
		state: text("state")
			.$type<
				| "committing"
				| "queued"
				| "processing"
				| "retry"
				| "verified"
				| "source-blocked"
			>()
			.notNull()
			.default("committing"),
		attemptId: text("attempt_id"),
		attemptCount: integer("attempt_count").notNull().default(0),
		leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
		nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }).notNull(),
		workflowRunId: text("workflow_run_id"),
		remoteJobId: text("remote_job_id"),
		source: text("source", { mode: "json" }).$type<unknown>(),
		verification: text("verification", { mode: "json" }).$type<unknown>(),
		output: text("output", { mode: "json" }).$type<unknown>(),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("video_processing_jobs_processing_state_retry_video_idx").on(
			table.state,
			table.nextRetryAt,
			table.videoId,
		),
		index("video_processing_jobs_processing_state_lease_video_idx").on(
			table.state,
			table.leaseExpiresAt,
			table.videoId,
		),
	],
);
export const mediaProcessingBudgets = sqliteTable(
	"media_processing_budgets",
	{
		id: text("id").primaryKey().notNull(),
		reservedBytes: integer("reserved_bytes").notNull().default(0),
		limitBytes: integer("limit_bytes").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		check(
			"media_processing_budgets_reservedBytes_nonnegative",
			sql`${table.reservedBytes} >= 0`,
		),
		check(
			"media_processing_budgets_limitBytes_nonnegative",
			sql`${table.limitBytes} >= 0`,
		),

		index("media_processing_budgets_media_budget_expiry_idx").on(
			table.expiresAt,
		),
	],
);
export const importedVideos = sqliteTable(
	"imported_videos",
	{
		id: nanoId("id").notNull(),
		orgId: nanoIdNullable("orgId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		source: text("source", { enum: ["loom"] }).notNull(),
		sourceId: text("source_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.source, table.sourceId] }),
		index("imported_videos_id_idx").on(table.id),
	],
);
export const loomMigrationRequests = sqliteTable(
	"loom_migration_requests",
	{
		id: nanoId("id").notNull().primaryKey(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		activeOrganizationId: nanoIdNullable(
			"activeOrganizationId",
		).$type<Organisation.OrganisationId>(),
		requestedByUserId: nanoId("requestedByUserId")
			.notNull()
			.$type<User.UserId>(),
		workspaceName: text("workspaceName"),
		customerNote: text("customerNote"),
		customerReply: text("customerReply"),
		invitedAt: integer("invitedAt", { mode: "timestamp_ms" }),
		status: text("status", {
			enum: ["pending", "in_progress", "needs_information", "completed"],
		})
			.notNull()
			.default("pending"),
		capMessage: text("capMessage"),
		expectedVideoCount: integer("expectedVideoCount"),
		importedVideoCount: integer("importedVideoCount").notNull().default(0),
		queuedVideoCount: integer("queuedVideoCount").notNull().default(0),
		activeImportCount: integer("activeImportCount").notNull().default(0),
		activeImportLeaseToken: text("activeImportLeaseToken"),
		activeImportLeaseUntil: integer("activeImportLeaseUntil", {
			mode: "timestamp_ms",
		}),
		lastOperatorUserId:
			nanoIdNullable("lastOperatorUserId").$type<User.UserId>(),
		lastOperatorAt: integer("lastOperatorAt", { mode: "timestamp_ms" }),
		completedAt: integer("completedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		uniqueIndex("loom_migration_requests_loom_migration_active_org_idx").on(
			table.activeOrganizationId,
		),
		index("loom_migration_requests_loom_migration_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("loom_migration_requests_loom_migration_status_created_idx").on(
			table.status,
			table.createdAt,
		),
	],
);
export const loomMigrationImports = sqliteTable(
	"loom_migration_imports",
	{
		videoId: nanoId("videoId").notNull().primaryKey().$type<Video.VideoId>(),
		requestId: nanoId("requestId").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("loom_migration_imports_loom_migration_imports_request_idx").on(
			table.requestId,
		),
	],
);
export const developerApps = sqliteTable(
	"developer_apps",
	{
		id: nanoId("id").notNull().primaryKey(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		name: text("name").notNull(),
		environment: text("environment", {
			enum: ["development", "production"],
		}).notNull(),
		logoUrl: text("logoUrl"),
		deletedAt: integer("deletedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("developer_apps_owner_deleted_idx").on(
			table.ownerId,
			table.deletedAt,
		),
	],
);
export const developerAppDomains = sqliteTable(
	"developer_app_domains",
	{
		id: nanoId("id").notNull().primaryKey(),
		appId: nanoId("appId")
			.notNull()
			.references(() => developerApps.id),
		domain: text("domain").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		unique("developer_app_domains_app_domain_unique").on(
			table.appId,
			table.domain,
		),
	],
);
export const developerApiKeys = sqliteTable(
	"developer_api_keys",
	{
		id: nanoId("id").notNull().primaryKey(),
		appId: nanoId("appId")
			.notNull()
			.references(() => developerApps.id),
		keyType: text("keyType", { enum: ["public", "secret"] }).notNull(),
		keyPrefix: text("keyPrefix").notNull(),
		keyHash: text("keyHash").notNull(),
		encryptedKey: encryptedText("encryptedKey").notNull(),
		lastUsedAt: integer("lastUsedAt", { mode: "timestamp_ms" }),
		revokedAt: integer("revokedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("developer_api_keys_key_hash_idx").on(table.keyHash),
		index("developer_api_keys_app_key_type_idx").on(table.appId, table.keyType),
	],
);
export const developerVideos = sqliteTable(
	"developer_videos",
	{
		id: nanoId("id").notNull().primaryKey(),
		appId: nanoId("appId")
			.notNull()
			.references(() => developerApps.id),
		externalUserId: text("externalUserId"),
		name: text("name").notNull().default("Untitled"),
		duration: real("duration"),
		width: integer("width"),
		height: integer("height"),
		fps: integer("fps"),
		s3Key: text("s3Key"),
		transcriptionStatus: text("transcriptionStatus", {
			enum: ["PROCESSING", "COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO"],
		}),
		metadata: text("metadata", { mode: "json" }),
		deletedAt: integer("deletedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("developer_videos_app_created_idx").on(table.appId, table.createdAt),
		index("developer_videos_app_user_idx").on(
			table.appId,
			table.externalUserId,
		),
		index("developer_videos_app_deleted_idx").on(table.appId, table.deletedAt),
	],
);
export const developerCreditAccounts = sqliteTable(
	"developer_credit_accounts",
	{
		id: nanoId("id").notNull().primaryKey(),
		appId: nanoId("appId")
			.notNull()
			.references(() => developerApps.id),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		balanceMicroCredits: integer("balanceMicroCredits").notNull().default(0),
		stripeCustomerId: text("stripeCustomerId"),
		stripePaymentMethodId: text("stripePaymentMethodId"),
		autoTopUpEnabled: integer("autoTopUpEnabled", { mode: "boolean" })
			.notNull()
			.default(false),
		autoTopUpThresholdMicroCredits: integer("autoTopUpThresholdMicroCredits")
			.notNull()
			.default(0),
		autoTopUpAmountCents: integer("autoTopUpAmountCents").notNull().default(0),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
			.$onUpdate(() => new Date()),
	},
	(table) => [
		check(
			"developer_credit_accounts_balanceMicroCredits_nonnegative",
			sql`${table.balanceMicroCredits} >= 0`,
		),
		check(
			"developer_credit_accounts_autoTopUpThresholdMicroCredits_nonnegative",
			sql`${table.autoTopUpThresholdMicroCredits} >= 0`,
		),

		uniqueIndex("developer_credit_accounts_app_id_unique").on(table.appId),
	],
);
export type DeveloperCreditTransactionType =
	| "topup"
	| "video_create"
	| "storage_daily"
	| "refund"
	| "adjustment";
export type DeveloperCreditReferenceType =
	| "developer_video"
	| "stripe_payment_intent"
	| "manual";
export const developerCreditTransactions = sqliteTable(
	"developer_credit_transactions",
	{
		id: nanoId("id").notNull().primaryKey(),
		accountId: nanoId("accountId").notNull(),
		type: text("type", {
			enum: ["topup", "video_create", "storage_daily", "refund", "adjustment"],
		})
			.notNull()
			.$type<DeveloperCreditTransactionType>(),
		amountMicroCredits: integer("amountMicroCredits").notNull(),
		balanceAfterMicroCredits: integer("balanceAfterMicroCredits").notNull(),
		referenceId: text("referenceId"),
		referenceType: text("referenceType", {
			enum: ["developer_video", "stripe_payment_intent", "manual"],
		}).$type<DeveloperCreditReferenceType>(),
		metadata: text("metadata", { mode: "json" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		check(
			"developer_credit_transactions_balanceAfterMicroCredits_nonnegative",
			sql`${table.balanceAfterMicroCredits} >= 0`,
		),

		foreignKey({
			name: "dev_credit_txn_account_fk",
			columns: [table.accountId],
			foreignColumns: [developerCreditAccounts.id],
		}),
		index("developer_credit_transactions_account_type_created_idx").on(
			table.accountId,
			table.type,
			table.createdAt,
		),
		index("developer_credit_transactions_account_ref_dedup_idx").on(
			table.accountId,
			table.referenceId,
			table.referenceType,
		),
	],
);
export const developerDailyStorageSnapshots = sqliteTable(
	"developer_daily_storage_snapshots",
	{
		id: nanoId("id").notNull().primaryKey(),
		appId: nanoId("appId")
			.notNull()
			.references(() => developerApps.id),
		snapshotDate: text("snapshotDate").notNull(),
		totalDurationMinutes: real("totalDurationMinutes").notNull().default(0),
		videoCount: integer("videoCount").notNull().default(0),
		microCreditsCharged: integer("microCreditsCharged").notNull().default(0),
		processedAt: integer("processedAt", { mode: "timestamp_ms" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		check(
			"developer_daily_storage_snapshots_microCreditsCharged_nonnegative",
			sql`${table.microCreditsCharged} >= 0`,
		),

		unique("developer_daily_storage_snapshots_app_date_unique").on(
			table.appId,
			table.snapshotDate,
		),
	],
);
export const developerAppsRelations = relations(
	developerApps,
	({ one, many }) => ({
		owner: one(users, {
			fields: [developerApps.ownerId],
			references: [users.id],
		}),
		domains: many(developerAppDomains),
		apiKeys: many(developerApiKeys),
		videos: many(developerVideos),
		creditAccount: one(developerCreditAccounts, {
			fields: [developerApps.id],
			references: [developerCreditAccounts.appId],
		}),
		storageSnapshots: many(developerDailyStorageSnapshots),
	}),
);
export const developerAppDomainsRelations = relations(
	developerAppDomains,
	({ one }) => ({
		app: one(developerApps, {
			fields: [developerAppDomains.appId],
			references: [developerApps.id],
		}),
	}),
);
export const developerApiKeysRelations = relations(
	developerApiKeys,
	({ one }) => ({
		app: one(developerApps, {
			fields: [developerApiKeys.appId],
			references: [developerApps.id],
		}),
	}),
);
export const developerVideosRelations = relations(
	developerVideos,
	({ one }) => ({
		app: one(developerApps, {
			fields: [developerVideos.appId],
			references: [developerApps.id],
		}),
	}),
);
export const developerCreditAccountsRelations = relations(
	developerCreditAccounts,
	({ one, many }) => ({
		app: one(developerApps, {
			fields: [developerCreditAccounts.appId],
			references: [developerApps.id],
		}),
		owner: one(users, {
			fields: [developerCreditAccounts.ownerId],
			references: [users.id],
		}),
		transactions: many(developerCreditTransactions),
	}),
);
export const developerCreditTransactionsRelations = relations(
	developerCreditTransactions,
	({ one }) => ({
		account: one(developerCreditAccounts, {
			fields: [developerCreditTransactions.accountId],
			references: [developerCreditAccounts.id],
		}),
	}),
);
export const developerDailyStorageSnapshotsRelations = relations(
	developerDailyStorageSnapshots,
	({ one }) => ({
		app: one(developerApps, {
			fields: [developerDailyStorageSnapshots.appId],
			references: [developerApps.id],
		}),
	}),
);
