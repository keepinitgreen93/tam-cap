import {
	type AutomaticCleanupRequest,
	finishAutomaticVideoCleanup,
	prepareAutomaticVideoCleanup,
} from "@/lib/automatic-video-cleanup";
import { editVideoWorkflow } from "@/workflows/edit-video";

export async function automaticVideoCleanupWorkflow(
	request: AutomaticCleanupRequest,
) {
	"use workflow";
	try {
		const edit = await prepareCleanup(request);
		if (!edit) return { skipped: true };
		await editVideoWorkflow(edit);
		await finishCleanup(request, "complete");
		return { success: true };
	} catch (error) {
		await finishCleanup(request, "error");
		throw error;
	}
}

async function prepareCleanup(request: AutomaticCleanupRequest) {
	"use step";
	return prepareAutomaticVideoCleanup(request);
}

async function finishCleanup(
	request: AutomaticCleanupRequest,
	status: "complete" | "error",
) {
	"use step";
	await finishAutomaticVideoCleanup(request, status);
}

prepareCleanup.maxRetries = 4;
