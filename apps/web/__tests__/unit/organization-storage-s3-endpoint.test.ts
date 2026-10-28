import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import {
	organizations,
	s3Buckets,
	users,
} from "@cap/database/cloudflare/schema";
import type { Organisation } from "@cap/web-domain";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";

const state = vi.hoisted(() => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" as string | undefined },
	NODE_ENV: "production",
	serverEnv: {
		NEXTAUTH_SECRET: "synthetic-secret",
		CAP_AWS_BUCKET: "synthetic-default",
		CAP_AWS_REGION: "auto",
		S3_INTERNAL_ENDPOINT: "https://synthetic.r2.cloudflarestorage.com",
		GOOGLE_CLIENT_ID: "",
		GOOGLE_CLIENT_SECRET: "",
	},
	driveAuthUrl: vi.fn(() => "https://accounts.google.com/synthetic"),
	s3Configs: [] as Array<Record<string, unknown>>,
	send: vi.fn(async () => ({})),
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
}));

vi.mock("@cap/env", () => ({
	get buildEnv() {
		return state.buildEnv;
	},
	get NODE_ENV() {
		return state.NODE_ENV;
	},
	serverEnv: () => state.serverEnv,
}));

vi.mock("@aws-sdk/client-s3", () => ({
	HeadBucketCommand: class {
		constructor(readonly input: unknown) {}
	},
	S3Client: class {
		constructor(config: Record<string, unknown>) {
			state.s3Configs.push(config);
		}
		send = state.send;
	},
}));

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Test database unavailable");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "usr_synthetic" }),
}));
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (value: string) => `enc:${value}`,
	decrypt: async (value: string) => value.replace(/^enc:/, ""),
}));

vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", () => ({
	getGoogleDriveAuthUrl: state.driveAuthUrl,
}));
vi.mock("@cap/web-domain", () => ({
	S3Bucket: { S3BucketId: { make: (id: string) => id } },
	Storage: { StorageIntegrationId: { make: (id: string) => id } },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: async () => undefined,
}));

import {
	connectOrganizationGoogleDrive,
	getOrganizationStorageSettings,
	saveOrganizationS3Config,
	testOrganizationS3Config,
} from "@/actions/organization/storage";
import { blockedS3EndpointMessage } from "@/lib/s3-endpoint-policy";

const input = (endpoint: string) => ({
	organizationId: "org_synthetic" as Organisation.OrganisationId,
	provider: "aws",
	accessKeyId: "AKIASYNTHETIC",
	secretAccessKey: "synthetic-secret",
	endpoint,
	bucketName: "synthetic-bucket",
	region: "us-east-1",
});

describe("organization storage S3 endpoint policy", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
		await fixture.database.insert(users).values({
			id: "usr_synthetic" as typeof users.$inferInsert.id,
			email: "operator@example.com",
			activeOrganizationId:
				"org_synthetic" as typeof organizations.$inferInsert.id,
		});
		await fixture.database.insert(organizations).values({
			id: "org_synthetic" as typeof organizations.$inferInsert.id,
			ownerId: "usr_synthetic" as typeof users.$inferInsert.id,
			name: "Org",
		});
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		state.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		state.NODE_ENV = "production";
		state.s3Configs.length = 0;
		state.send.mockClear();
		state.serverEnv.GOOGLE_CLIENT_ID = "";
		state.serverEnv.GOOGLE_CLIENT_SECRET = "";
		state.driveAuthUrl.mockClear();
		await fixture.database.delete(s3Buckets);
	});

	it("reports the deployment's R2 separately from an optional organization bucket", async () => {
		state.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		const settings = await getOrganizationStorageSettings(
			input("").organizationId,
		);
		expect(settings).toMatchObject({
			defaultStorage: { configured: true, provider: "Cloudflare R2" },
			googleDriveConfigured: false,
			s3: null,
		});
		expect(JSON.stringify(settings)).not.toContain("synthetic-default");
		expect(JSON.stringify(settings)).not.toContain("synthetic-secret");
	});

	it("returns a setup message without starting OAuth when Drive credentials are missing", async () => {
		await expect(
			connectOrganizationGoogleDrive(input("").organizationId),
		).resolves.toEqual({
			error:
				"Google Drive is not configured on this Cap deployment. Ask your administrator to configure Google OAuth.",
		});
		expect(state.driveAuthUrl).not.toHaveBeenCalled();
		state.serverEnv.GOOGLE_CLIENT_ID = "synthetic-client";
		await expect(
			connectOrganizationGoogleDrive(input("").organizationId),
		).resolves.toHaveProperty("error");
		state.serverEnv.GOOGLE_CLIENT_SECRET = "synthetic-client-secret";
		await expect(
			connectOrganizationGoogleDrive(input("").organizationId),
		).resolves.toEqual({ url: "https://accounts.google.com/synthetic" });
		expect(state.driveAuthUrl).toHaveBeenCalledOnce();
	});

	it.each([
		"http://169.254.169.254",
		"http://127.0.0.1:9000",
		"http://localhost:9000",
		"http://[::1]:9000",
	])("refuses to save %s on Cap Cloud", async (endpoint) => {
		await expect(saveOrganizationS3Config(input(endpoint))).resolves.toEqual({
			error: blockedS3EndpointMessage,
		});
		expect(await fixture.database.select().from(s3Buckets)).toHaveLength(0);
	});

	it.each([
		"http://169.254.169.254",
		"http://10.0.0.5",
		"http://minio.localhost",
	])("refuses to test %s on Cap Cloud", async (endpoint) => {
		await expect(testOrganizationS3Config(input(endpoint))).resolves.toEqual({
			error: blockedS3EndpointMessage,
		});
		expect(state.s3Configs).toHaveLength(0);
		expect(state.send).not.toHaveBeenCalled();
	});

	it("returns safe S3 validation and connection errors without throwing masked action errors", async () => {
		await expect(
			saveOrganizationS3Config({ ...input(""), bucketName: "" }),
		).resolves.toEqual({ error: "Bucket name and region are required" });
		await expect(
			testOrganizationS3Config({ ...input(""), region: "" }),
		).resolves.toEqual({ error: "Bucket name and region are required" });
		const missingCredentials = {
			...input("https://8.8.8.8"),
			accessKeyId: "",
			secretAccessKey: "",
		};
		await expect(saveOrganizationS3Config(missingCredentials)).resolves.toEqual(
			{
				error: "Access key ID and secret access key are required",
			},
		);
		await expect(testOrganizationS3Config(missingCredentials)).resolves.toEqual(
			{
				error: "Access key ID and secret access key are required",
			},
		);
		state.send.mockRejectedValueOnce(
			Object.assign(new Error("synthetic provider secret"), {
				name: "AccessDenied",
			}),
		);
		await expect(
			testOrganizationS3Config(input("https://8.8.8.8")),
		).resolves.toEqual({
			error:
				"Access denied. Please check your credentials and bucket permissions.",
		});
	});

	it("saves public and default endpoints on Cap Cloud", async () => {
		await expect(
			saveOrganizationS3Config(input("https://8.8.8.8")),
		).resolves.toEqual({ success: true });
		await expect(saveOrganizationS3Config(input(""))).resolves.toEqual({
			success: true,
		});
		expect(await fixture.database.select().from(s3Buckets)).toHaveLength(2);
	});

	it("tests public endpoints through public-only agents on Cap Cloud", async () => {
		await expect(
			testOrganizationS3Config(input("https://8.8.8.8")),
		).resolves.toEqual({ success: true });

		expect(state.s3Configs).toHaveLength(1);
		const requestHandler = state.s3Configs[0]?.requestHandler as {
			httpAgent?: unknown;
			httpsAgent?: unknown;
		};
		expect(requestHandler.httpAgent).toBeInstanceOf(HttpAgent);
		expect(requestHandler.httpsAgent).toBeInstanceOf(HttpsAgent);
		expect(state.send).toHaveBeenCalledTimes(1);
	});

	it.each([
		["self-hosted", undefined, "production"],
		["development", "true", "development"],
	])("allows local endpoints on %s deployments", async (_, isCap, nodeEnv) => {
		state.buildEnv.NEXT_PUBLIC_IS_CAP = isCap;
		state.NODE_ENV = nodeEnv;

		await expect(
			saveOrganizationS3Config(input("http://localhost:9000")),
		).resolves.toEqual({ success: true });
		await expect(
			testOrganizationS3Config(input("http://192.168.1.10:9000")),
		).resolves.toEqual({ success: true });

		expect(await fixture.database.select().from(s3Buckets)).toHaveLength(1);
		expect(state.s3Configs).toHaveLength(1);
		expect(state.s3Configs[0]?.endpoint).toBe("http://192.168.1.10:9000");
		expect(state.s3Configs[0]?.requestHandler).toBeUndefined();
	});
});
