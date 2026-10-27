import {
	claimAiGeneration,
	updateAiGenerationRun,
} from "@cap/database/cloudflare/ai-generation";
import { db } from "@cap/database/cloudflare/application";
import type { Video } from "@cap/web-domain";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { isAiConfigured } from "@/lib/ai/provider";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = { success: boolean; message: string };

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
): Promise<GenerateAiResult> {
	if (!isAiConfigured())
		return { success: false, message: "No AI provider configured" };
	if (!userId || !videoId)
		return { success: false, message: "userId or videoId not supplied" };
	const claim = await claimAiGeneration(db(), videoId, userId);
	if (claim.state === "missing")
		return { success: false, message: "Video does not exist" };
	if (claim.state === "not-ready")
		return { success: false, message: "Transcription not complete" };
	if (claim.state === "complete")
		return { success: true, message: "AI metadata already generated" };
	const { run } = claim;
	const world = getWorld();
	let attempted = false;
	try {
		if (claim.state === "in-progress") {
			if (run.workflowRunId && run.workflowQueue) {
				const workflow = getRun(run.workflowRunId);
				if (await workflow.exists) {
					const status = await workflow.status;
					if (status === "pending")
						await world.queue(
							run.workflowQueue,
							{ runId: run.workflowRunId },
							{ deploymentId: run.deploymentId },
						);
					if (status !== "pending" && status !== "running") {
						await updateAiGenerationRun(db(), videoId, run.id, {
							status: "ERROR",
						});
						return {
							success: false,
							message: "AI generation stopped; retry generation",
						};
					}
				}
			}
			return { success: true, message: "AI generation already in progress" };
		}
		const observedWorld: ReturnType<typeof getWorld> = {
			...world,
			queue: async (name, message, options) => {
				if (!("runId" in message))
					throw new Error("AI workflow identity missing");
				const current = await updateAiGenerationRun(db(), videoId, run.id, {
					run: {
						workflowRunId: message.runId,
						workflowQueue: name,
						deploymentId: options?.deploymentId,
					},
				});
				if (!current)
					throw new Error("AI generation superseded before dispatch");
				attempted = true;
				return world.queue(name, message, options);
			},
		};
		const started = await start(
			generateAiWorkflow,
			[{ videoId, userId, runId: run.id }],
			{ world: observedWorld },
		);
		await updateAiGenerationRun(db(), videoId, run.id, {
			run: { dispatch: "accepted", workflowRunId: started.runId },
		});
		return { success: true, message: "AI generation workflow started" };
	} catch {
		if (claim.state === "in-progress")
			return {
				success: false,
				message: "Failed to resume AI generation workflow",
			};
		await updateAiGenerationRun(db(), videoId, run.id, {
			...(attempted ? {} : { status: "ERROR" as const }),
			run: { dispatch: attempted ? "uncertain" : "rejected" },
		});
		return {
			success: false,
			message: "Failed to start AI generation workflow",
		};
	}
}
