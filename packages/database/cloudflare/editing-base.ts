import { z } from "zod";

const editingBaseSchema = z
	.object({
		version: z.literal(1),
		id: z.string().uuid(),
		sourceKey: z.string().min(1),
		duration: z.number().finite().positive().nullable(),
	})
	.strict();

export function getVideoEditingBase(video: {
	id: string;
	ownerId: string;
	metadata?: unknown;
}) {
	if (video.metadata === null || video.metadata === undefined) return null;
	if (typeof video.metadata !== "object" || Array.isArray(video.metadata))
		throw Error("Video editing base is invalid");
	if (
		!Object.hasOwn(video.metadata, "editingBase") ||
		!("editingBase" in video.metadata)
	)
		return null;
	const base = editingBaseSchema.safeParse(video.metadata.editingBase);
	if (
		!base.success ||
		![video.ownerId, video.id].every((value) =>
			/^[A-Za-z0-9_-]{1,64}$/.test(value),
		) ||
		!base.data.sourceKey.startsWith(
			`${video.ownerId}/${video.id}/.recording/`,
		) ||
		!base.data.sourceKey.endsWith(".mp4") ||
		!/^[A-Za-z0-9_./-]+$/.test(base.data.sourceKey) ||
		base.data.sourceKey.includes("\\") ||
		base.data.sourceKey
			.split("/")
			.some((part) => !part || part === "." || part === "..")
	)
		throw Error("Video editing base is invalid");
	return base.data;
}
