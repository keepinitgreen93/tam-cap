import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videoUploads } from "@cap/database/cloudflare/schema";
import type { VideoProcessingRun } from "@cap/database/types";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { processVideoWorkflow } from "@/workflows/process-video";
import {
	claimVideoProcessing,
	updateProcessingDispatch,
} from "./video-processing-state";
import { isVideoStorageKey } from "./video-storage-key";

export type VideoProcessingStartStatus =
	| "started"
	| "already-processing"
	| "already-complete";

export async function setVideoProcessingError(
	videoId: Video.VideoId,
	processingMessage: string,
	error: unknown,
): Promise<void> {
	const database = db();
	const now = new Date();
	await atomic(database, async (snapshot) => {
		const video = await requireWritableVideo(snapshot, videoId);
		if (video.metadata?.processingRun)
			return { statements: [], result: undefined };
		return {
			statements: [
				database
					.update(videoUploads)
					.set({
						phase: "error",
						processingProgress: 0,
						processingMessage,
						processingError:
							error instanceof Error ? error.message : String(error),
						updatedAt: now,
					})
					.where(eq(videoUploads.videoId, videoId)),
			],
			result: undefined,
		};
	});
}

export async function transitionVideoToProcessing(input: {
	videoId: Video.VideoId;
	rawFileKey: string;
	processingMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
	expectedUpdatedAt?: Date;
	expectedProcessingToken?: string | null;
}): Promise<VideoProcessingStartStatus> {
	const database = db();
	const now = new Date();
	return atomic<VideoProcessingStartStatus>(database, async (snapshot) => {
		const video = await requireWritableVideo(snapshot, input.videoId);
		if (!isVideoStorageKey(video, input.rawFileKey))
			throw new Error("Processing source does not belong to this video");
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, input.videoId))
				.limit(1),
		);
		if (!upload) throw new Error("No upload record found");
		if (
			input.forceRestart &&
			(!input.expectedUpdatedAt ||
				input.expectedUpdatedAt.getTime() !== upload.updatedAt.getTime())
		)
			return { statements: [], result: "already-processing" };
		if (!input.forceRestart && upload.phase === "complete")
			return { statements: [], result: "already-complete" };
		if (
			!input.forceRestart &&
			(upload.phase === "processing" || upload.phase === "generating_thumbnail")
		)
			return { statements: [], result: "already-processing" };
		return {
			statements: [
				database
					.update(videoUploads)
					.set({
						...(input.mode ? { mode: input.mode } : {}),
						phase: "processing",
						processingProgress: 0,
						processingMessage: input.processingMessage,
						processingError: null,
						rawFileKey: input.rawFileKey,
						updatedAt: now,
					})
					.where(eq(videoUploads.videoId, input.videoId)),
			],
			result: "started",
		};
	});
}

async function redispatchProcessingRun(
	videoId: Video.VideoId,
	run: VideoProcessingRun,
) {
	if (!run.workflowRunId || !run.workflowQueue) return false;
	const workflow = getRun(run.workflowRunId);
	if (!(await workflow.exists)) return false;
	const status = await workflow.status;
	if (status !== "pending" && status !== "running") return false;
	if (status === "pending")
		await getWorld().queue(
			run.workflowQueue,
			{ runId: run.workflowRunId },
			{ deploymentId: run.deploymentId },
		);
	await updateProcessingDispatch(db(), videoId, run.token, {
		dispatch: "accepted",
	});
	return true;
}

export async function startVideoProcessingWorkflow(input: {
	videoId: Video.VideoId;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	processingMessage: string;
	startFailureMessage: string;
	mode?: "singlepart" | "multipart";
	forceRestart?: boolean;
	expectedUpdatedAt?: Date;
	expectedProcessingToken?: string | null;
}): Promise<VideoProcessingStartStatus> {
	const claimed = await claimVideoProcessing(db(), input);
	if (!claimed.dispatch || !claimed.run) return claimed.status;
	const run = claimed.run;
	try {
		if (await redispatchProcessingRun(input.videoId, run)) return "started";
		const world = getWorld();
		const observedWorld: ReturnType<typeof getWorld> = {
			...world,
			queue: async (name, message, options) => {
				if (!("runId" in message))
					throw new Error("Processing workflow run ID is missing");
				const active = await updateProcessingDispatch(
					db(),
					input.videoId,
					run.token,
					{
						dispatch: "pending",
						workflowRunId: message.runId,
						workflowQueue: name,
						deploymentId: options?.deploymentId,
					},
				);
				if (!active)
					throw new Error("Processing workflow was superseded before dispatch");
				return world.queue(name, message, options);
			},
		};
		const workflow = await start(
			processVideoWorkflow,
			[
				{
					videoId: input.videoId,
					userId: input.userId,
					rawFileKey: input.rawFileKey,
					bucketId: input.bucketId,
					processingToken: run.token,
				},
			],
			{ world: observedWorld },
		);
		await updateProcessingDispatch(db(), input.videoId, run.token, {
			dispatch: "accepted",
			workflowRunId: workflow.runId,
		});
		return "started";
	} catch (error) {
		await updateProcessingDispatch(db(), input.videoId, run.token, {
			dispatch: "uncertain",
		});
		throw new Error(input.startFailureMessage, { cause: error });
	}
}
