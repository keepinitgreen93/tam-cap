import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
	developerVideos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeVideoFps } from "@/lib/video-metadata";

export async function reserveDeveloperUpload(
	database: CloudflareDatabase,
	input: {
		appId: string;
		videoId: string;
		uploadId: string;
		amount: number;
		durationSeconds: number;
		totalBytes: number;
	},
) {
	const id = nanoId();
	return atomic<
		"missing" | "insufficient" | "reserved" | "complete" | "conflict"
	>(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader
				.select({ id: developerVideos.id })
				.from(developerVideos)
				.innerJoin(developerApps, eq(developerVideos.appId, developerApps.id))
				.where(
					and(
						eq(developerVideos.id, input.videoId),
						eq(developerApps.id, input.appId),
						isNull(developerApps.deletedAt),
						isNull(developerVideos.deletedAt),
					),
				)
				.limit(1),
		);
		const [account] = await snapshot.read((reader) =>
			reader
				.select()
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.appId, input.appId))
				.limit(1),
		);
		if (!video || !account) return { statements: [], result: "missing" };
		const [receipt] = await snapshot.read((reader) =>
			reader
				.select()
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, account.id),
						eq(developerCreditTransactions.type, "video_create"),
						eq(developerCreditTransactions.referenceId, input.videoId),
						eq(developerCreditTransactions.referenceType, "developer_video"),
					),
				)
				.limit(1),
		);
		if (receipt) {
			const metadata = receipt.metadata;
			if (
				!metadata ||
				typeof metadata !== "object" ||
				!("uploadId" in metadata) ||
				metadata.uploadId !== input.uploadId ||
				!("durationSeconds" in metadata) ||
				metadata.durationSeconds !== input.durationSeconds ||
				!("totalBytes" in metadata) ||
				metadata.totalBytes !== input.totalBytes
			)
				return { statements: [], result: "conflict" };
			return {
				statements: [],
				result:
					"complete" in metadata && metadata.complete === true
						? "complete"
						: "reserved",
			};
		}
		if (
			!Number.isSafeInteger(input.amount) ||
			input.amount < 0 ||
			!Number.isSafeInteger(input.totalBytes) ||
			input.totalBytes < 0
		)
			throw new Error("Invalid developer usage amount");
		if (account.balanceMicroCredits < input.amount)
			return { statements: [], result: "insufficient" };
		const balance = account.balanceMicroCredits - input.amount;
		return {
			statements: [
				database
					.update(developerCreditAccounts)
					.set({ balanceMicroCredits: balance })
					.where(eq(developerCreditAccounts.id, account.id)),
				database.insert(developerCreditTransactions).values({
					id,
					accountId: account.id,
					type: "video_create",
					amountMicroCredits: -input.amount,
					balanceAfterMicroCredits: balance,
					referenceId: input.videoId,
					referenceType: "developer_video",
					metadata: {
						uploadId: input.uploadId,
						durationSeconds: input.durationSeconds,
						totalBytes: input.totalBytes,
						complete: false,
					},
				}),
			],
			result: "reserved",
		};
	});
}

export async function finishDeveloperUpload(
	database: CloudflareDatabase,
	input: {
		appId: string;
		videoId: string;
		uploadId: string;
		duration: number;
		width?: number;
		height?: number;
		fps?: number;
	},
) {
	return atomic(database, async (snapshot) => {
		const [row] = await snapshot.read((reader) =>
			reader
				.select({ receipt: developerCreditTransactions })
				.from(developerCreditTransactions)
				.innerJoin(
					developerCreditAccounts,
					eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
				)
				.innerJoin(
					developerApps,
					eq(developerCreditAccounts.appId, developerApps.id),
				)
				.innerJoin(
					developerVideos,
					eq(developerCreditTransactions.referenceId, developerVideos.id),
				)
				.where(
					and(
						eq(developerApps.id, input.appId),
						eq(developerVideos.appId, input.appId),
						eq(developerVideos.id, input.videoId),
						eq(developerCreditTransactions.type, "video_create"),
						isNull(developerApps.deletedAt),
						isNull(developerVideos.deletedAt),
					),
				)
				.limit(1),
		);
		const metadata = row?.receipt.metadata;
		if (
			!row ||
			!metadata ||
			typeof metadata !== "object" ||
			!("uploadId" in metadata) ||
			metadata.uploadId !== input.uploadId
		)
			throw new Error("Developer upload reservation is no longer valid");
		return {
			statements: [
				database
					.update(developerVideos)
					.set({
						duration: input.duration,
						width: input.width,
						height: input.height,
						fps: normalizeVideoFps(input.fps),
					})
					.where(eq(developerVideos.id, input.videoId)),
				database
					.update(developerCreditTransactions)
					.set({ metadata: { ...metadata, complete: true } })
					.where(eq(developerCreditTransactions.id, row.receipt.id)),
			],
			result: undefined,
		};
	});
}

export async function recordDeveloperStorageDay(
	database: CloudflareDatabase,
	appId: string,
	date: string,
	chargeCredits: boolean,
) {
	const snapshotId = nanoId();
	const transactionId = nanoId();
	const now = new Date();
	return atomic(database, async (snapshot) => {
		const [app] = await snapshot.read((reader) =>
			reader
				.select({ id: developerApps.id })
				.from(developerApps)
				.where(
					and(eq(developerApps.id, appId), isNull(developerApps.deletedAt)),
				)
				.limit(1),
		);
		if (!app) return { statements: [], result: false };
		const [existing] = await snapshot.read((reader) =>
			reader
				.select()
				.from(developerDailyStorageSnapshots)
				.where(
					and(
						eq(developerDailyStorageSnapshots.appId, appId),
						eq(developerDailyStorageSnapshots.snapshotDate, date),
					),
				)
				.limit(1),
		);
		if (existing?.processedAt) return { statements: [], result: false };
		const [stats] = await snapshot.read((reader) =>
			reader
				.select({
					minutes:
						sql<number>`coalesce(sum(${developerVideos.duration}) / 60.0, 0)`.mapWith(
							Number,
						),
					count: sql<number>`count(*)`.mapWith(Number),
				})
				.from(developerVideos)
				.where(
					and(
						eq(developerVideos.appId, appId),
						isNull(developerVideos.deletedAt),
					),
				),
		);
		const minutes = stats?.minutes ?? 0;
		if (minutes <= 0) return { statements: [], result: false };
		const amount = chargeCredits ? Math.floor((minutes * 333) / 100) : 0;
		const [account] = await snapshot.read((reader) =>
			reader
				.select()
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.appId, appId))
				.limit(1),
		);
		if (!account || account.balanceMicroCredits < amount)
			return { statements: [], result: false };
		const balance = account.balanceMicroCredits - amount;
		const values = {
			totalDurationMinutes: minutes,
			videoCount: stats?.count ?? 0,
			microCreditsCharged: amount,
			processedAt: now,
		};
		return {
			statements: [
				database
					.update(developerCreditAccounts)
					.set({ balanceMicroCredits: balance })
					.where(eq(developerCreditAccounts.id, account.id)),
				database.insert(developerCreditTransactions).values({
					id: transactionId,
					accountId: account.id,
					type: "storage_daily",
					amountMicroCredits: -amount,
					balanceAfterMicroCredits: balance,
					referenceId: date,
					referenceType: "manual",
					metadata: {
						snapshotDate: date,
						totalDurationMinutes: minutes,
						videoCount: values.videoCount,
					},
				}),
				existing
					? database
							.update(developerDailyStorageSnapshots)
							.set(values)
							.where(eq(developerDailyStorageSnapshots.id, existing.id))
					: database
							.insert(developerDailyStorageSnapshots)
							.values({ id: snapshotId, appId, snapshotDate: date, ...values }),
			],
			result: true,
		};
	});
}
