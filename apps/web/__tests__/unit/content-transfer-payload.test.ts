import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
	type ContentTransferPayload,
	MAX_CONTENT_TRANSFER_FOLDERS,
	MAX_CONTENT_TRANSFER_VIDEOS,
} from "@/lib/content-transfer";
import {
	decodeContentTransferPayload,
	encodeContentTransferPayload,
} from "@/lib/content-transfer-payload";

it("fits a ten-thousand-video, two-thousand-folder plan into one bounded bridge request", () => {
	const payload: ContentTransferPayload = {
		version: 1,
		organizationId: "org",
		requestedByUserId: "owner",
		source: { type: "organization" },
		sourceRootFolderId: "f0",
		targetUserId: "target",
		targetEmail: "target@transfer.test",
		createdAt: new Date(0).toISOString(),
		sourceFolderIds: Array.from(
			{ length: MAX_CONTENT_TRANSFER_FOLDERS },
			(_, index) => `f${index}`,
		),
		folderPlan: Array.from(
			{ length: MAX_CONTENT_TRANSFER_FOLDERS },
			(_, index) => ({
				sourceFolderId: `f${index}`,
				sourceParentId: index ? "f0" : null,
				sourcePublic: false,
				destinationFolderId: `d${index}`,
				destinationParentId: index ? "d0" : null,
				name: `Folder ${index}`,
				color: "normal",
				create: true,
			}),
		),
		videoPlan: Array.from(
			{ length: MAX_CONTENT_TRANSFER_VIDEOS },
			(_, index) => ({
				videoId: `v${index}`,
				name: `Recording ${index}`,
				sourceOwnerId: "owner",
				sourceMembershipId: `s${index}`,
				sourceFolderId: `f${index % MAX_CONTENT_TRANSFER_FOLDERS}`,
				destinationFolderId: `d${index % MAX_CONTENT_TRANSFER_FOLDERS}`,
				bucketId: null,
				storageIntegrationId: null,
				sourceUploadPhase: null,
			}),
		),
	};
	expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
		1024 * 1024,
	);
	const encoded = encodeContentTransferPayload(payload);
	expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(900000);
	expect(decodeContentTransferPayload(encoded)).toEqual(payload);
});
it("preserves existing raw operation payloads", () => {
	const raw = { version: 1, source: { type: "organization" } };
	expect(decodeContentTransferPayload(raw)).toBe(raw);
});
it("bounds decompression and rejects malformed stored wrappers", () => {
	expect(() =>
		decodeContentTransferPayload({
			format: "cap-content-transfer-v1",
			encoding: "gzip-base64",
			data: "invalid base64",
		}),
	).toThrow();
	expect(() =>
		decodeContentTransferPayload({
			format: "cap-content-transfer-v1",
			encoding: "gzip-base64",
			data: gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1)).toString("base64"),
		}),
	).toThrow();
});
