import { z } from "zod";

export const silenceAnalysisSchema = z
	.object({
		version: z.literal(1),
		profile: z.literal("pcm-quiet-v1"),
		durationMs: z.number().int().positive().finite(),
		audioTracks: z.number().int().positive(),
		ranges: z
			.array(
				z.object({
					startMs: z.number().int().nonnegative().finite(),
					endMs: z.number().int().positive().finite(),
				}),
			)
			.max(1_000_000),
	})
	.superRefine((value, context) => {
		let previousEnd = 0;
		for (const range of value.ranges) {
			if (
				range.startMs < previousEnd ||
				range.endMs <= range.startMs ||
				range.endMs > value.durationMs
			)
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Invalid silence range timing",
				});
			previousEnd = range.endMs;
		}
	});

export type SilenceAnalysis = z.infer<typeof silenceAnalysisSchema>;

export const silenceClaimSchema = z.object({
	revision: z.string().regex(/^[a-f0-9]{64}$/),
	requestId: z.string().uuid(),
	requestedAt: z.number().int().positive(),
	runId: z.string().nullable(),
	status: z.enum(["processing", "ready", "error"]),
});

export type SilenceClaim = z.infer<typeof silenceClaimSchema>;

export function readSilenceClaim(metadata: unknown): SilenceClaim | null {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("silenceAnalysis" in metadata)
	)
		return null;
	const result = silenceClaimSchema.safeParse(metadata.silenceAnalysis);
	return result.success ? result.data : null;
}

export function silenceClaimIsActive(claim: SilenceClaim, now = Date.now()) {
	return (
		claim.status === "processing" &&
		now >= claim.requestedAt &&
		now - claim.requestedAt <
			(claim.runId ? 6 * 60 * 60 * 1000 + 300_000 : 60_000)
	);
}
