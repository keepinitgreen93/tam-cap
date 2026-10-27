// This file is used to run database migrations in the docker builds or other self hosting environments.
// It is not suitable (a.k.a DEADLY) for serverless environments where the server will be restarted on each request.
//

import {
	BucketAlreadyOwnedByYou,
	CreateBucketCommand,
	PutBucketPolicyCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { migrateDb } from "@cap/database/migrate";
import { buildEnv, serverEnv } from "@cap/env";
import { validateCloudflareRuntime } from "./lib/cloudflare-runtime";

export async function register() {
	if (process.env.CAP_RUNTIME === "cloudflare") {
		try {
			validateCloudflareRuntime(process.env);
			serverEnv();
			const { getWorld } = await import("workflow/runtime");
			const { createD1BridgeBinding } = await import(
				"@cap/database/cloudflare/bridge"
			);
			const [database] = await Promise.all([
				createD1BridgeBinding()
					.prepare("SELECT 1 AS ok")
					.first<{ ok: number }>(),
				getWorld().getDeploymentId(),
			]);
			if (database?.ok !== 1) throw new Error("D1 readiness probe failed");
			console.info("[cloudflare-runtime] D1 and durable workflow ready");
		} catch (error) {
			console.error("Cloudflare runtime configuration failed", error);
			process.exit(1);
		}
		return;
	}

	if (process.env.NEXT_PUBLIC_IS_CAP) return;

	// Exit, not throw: Next.js catches a throwing register() and serves 500s.
	try {
		serverEnv();
	} catch {
		console.error("🚨 Environment validation failed, exiting");
		process.exit(1);
	}

	console.log("Waiting 5 seconds to run migrations");
	// Function to trigger migrations with retry logic
	const triggerMigrations = async (retryCount = 0, maxRetries = 3) => {
		try {
			await runMigrations();
		} catch (error) {
			console.error(
				`🚨 Error triggering migrations (attempt ${retryCount + 1}):`,
				error,
			);
			if (retryCount < maxRetries - 1) {
				console.log(
					`🔄 Retrying in 5 seconds... (${retryCount + 1}/${maxRetries})`,
				);
				setTimeout(() => triggerMigrations(retryCount + 1, maxRetries), 5000);
			} else {
				console.error(`🚨 All ${maxRetries} migration attempts failed.`);
				process.exit(1); // Exit with error code if all attempts fail
			}
		}
	};
	// Add a timeout to trigger migrations after 5 seconds on server start
	setTimeout(() => triggerMigrations(), 5000);
	setTimeout(() => createS3Bucket(), 5000);
}

async function createS3Bucket() {
	const s3Client = new S3Client({
		endpoint: serverEnv().S3_INTERNAL_ENDPOINT,
		region: serverEnv().CAP_AWS_REGION,
		credentials: {
			accessKeyId: serverEnv().CAP_AWS_ACCESS_KEY ?? "",
			secretAccessKey: serverEnv().CAP_AWS_SECRET_KEY ?? "",
		},
		forcePathStyle: serverEnv().S3_PATH_STYLE,
	});

	await s3Client
		.send(new CreateBucketCommand({ Bucket: serverEnv().CAP_AWS_BUCKET }))
		.then(() => {
			console.log("Created S3 bucket");
			return s3Client.send(
				new PutBucketPolicyCommand({
					Bucket: serverEnv().CAP_AWS_BUCKET,
					Policy: JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: "*",
								Action: ["s3:GetObject"],
								Resource: [`arn:aws:s3:::${serverEnv().CAP_AWS_BUCKET}/*`],
							},
						],
					}),
				}),
			);
		})
		.then(() => {
			console.log("Configured S3 buckeet");
		})
		.catch((e) => {
			if (e instanceof BucketAlreadyOwnedByYou) {
				console.log("Found existing S3 bucket");
				return;
			}
		});
}

async function runMigrations() {
	const isDockerBuild = buildEnv.NEXT_PUBLIC_DOCKER_BUILD === "true";
	if (isDockerBuild) {
		try {
			console.log("🔍 DB migrations triggered");
			console.log("💿 Running DB migrations...");

			await migrateDb();

			console.log("💿 Migrations run successfully!");
		} catch (error) {
			console.error("🚨 MIGRATION_FAILED", { error });
			throw error;
		}
	}
}
