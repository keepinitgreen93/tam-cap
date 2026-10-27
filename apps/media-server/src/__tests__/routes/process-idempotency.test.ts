import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import app from "../../app";
import * as jobs from "../../lib/job-manager";

const token = "a9699f1a-fe24-44f9-ac89-63d5744a058c";
const body = {
	videoId: "video",
	userId: "owner",
	videoUrl: "https://storage.example/raw",
	outputPresignedUrl: "https://storage.example/result",
	processingToken: token,
	processingInputKey: "owner/video/raw.webm",
	processingOutputKey: `owner/video/.recording/outputs/process-run/${token}/result.mp4`,
};
const request = (data: unknown) =>
	new Request("http://localhost/video/process", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-media-server-secret": "test-secret",
		},
		body: JSON.stringify(data),
	});
afterEach(() => {
	mock.restore();
	jobs.deleteJob(`process_${token}`);
});
describe("processing attempt idempotency", () => {
	test("returns an existing attempt before capacity admission", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "test-secret";
		const id = `process_${token}`;
		jobs.createJob(id, "video", "owner");
		jobs.updateJob(id, {
			recordingRequestKey: createHash("sha256")
				.update(
					JSON.stringify({
						videoId: body.videoId,
						userId: body.userId,
						inputKey: body.processingInputKey,
						outputKey: body.processingOutputKey,
					}),
				)
				.digest("hex"),
		});
		spyOn(jobs, "canAcceptNewVideoProcess").mockReturnValue(false);
		const response = await app.fetch(request(body));
		expect(response.status).toBe(200);
		expect((await response.json()).jobId).toBe(id);
		const conflict = await app.fetch(
			request({ ...body, processingInputKey: "owner/video/other.webm" }),
		);
		expect(conflict.status).toBe(409);
	});
	test("requires source and isolated output identity for tokenized processing", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "test-secret";
		expect(
			(
				await app.fetch(
					request({ ...body, processingOutputKey: "owner/video/result.mp4" }),
				)
			).status,
		).toBe(400);
	});
});
