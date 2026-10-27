import { db } from "@cap/database/cloudflare/application";
import type { videos } from "@cap/database/cloudflare/schema";
import {
	releaseTranscriptionRun,
	updateTranscriptionDispatch,
} from "@cap/database/cloudflare/transcription-state";
import type { TranscriptionRun } from "@cap/database/types";
import type { User, Video } from "@cap/web-domain";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";

export type TranscriptionPayload = {
	videoId: string;
	userId: string;
	runId: string;
	aiGenerationEnabled: boolean;
	earlyFromSegments?: boolean;
};

export async function resumeTranscriptionDispatch(
	videoId: Video.VideoId,
	run: TranscriptionRun,
): Promise<boolean> {
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
	await updateTranscriptionDispatch(db(), videoId, run.id, {
		dispatch: "accepted",
	});
	return true;
}

export async function dispatchTranscriptionRun(
	workflow: (payload: TranscriptionPayload) => Promise<unknown>,
	video: typeof videos.$inferSelect,
	aiGenerationEnabled: boolean,
	earlyFromSegments = false,
) {
	const run = video.metadata?.transcriptionRun;
	if (!run) throw new Error("Transcription claim is missing");
	if (await resumeTranscriptionDispatch(video.id, run)) return;
	const world = getWorld();
	let attempted = false;
	const observedWorld: ReturnType<typeof getWorld> = {
		...world,
		queue: async (name, message, options) => {
			if (!("runId" in message))
				throw new Error("Transcription workflow run ID is missing");
			const current = await updateTranscriptionDispatch(
				db(),
				video.id,
				run.id,
				{
					dispatch: "pending",
					workflowRunId: message.runId,
					workflowQueue: name,
					deploymentId: options?.deploymentId,
				},
			);
			if (!current)
				throw new Error("Transcription was superseded before dispatch");
			attempted = true;
			return world.queue(name, message, options);
		},
	};
	try {
		const started = await start(
			workflow,
			[
				{
					videoId: video.id,
					userId: video.ownerId,
					runId: run.id,
					aiGenerationEnabled,
					...(earlyFromSegments ? { earlyFromSegments: true } : {}),
				},
			],
			{ world: observedWorld },
		);
		await updateTranscriptionDispatch(db(), video.id, run.id, {
			dispatch: "accepted",
			workflowRunId: started.runId,
		});
	} catch (error) {
		await updateTranscriptionDispatch(db(), video.id, run.id, {
			dispatch: attempted ? "uncertain" : "rejected",
		});
		if (!attempted)
			await releaseTranscriptionRun(db(), {
				videoId: video.id as Video.VideoId,
				ownerId: video.ownerId as User.UserId,
				runId: run.id,
			});
		throw error;
	}
}
