import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
	approveDesktopSignIn,
	desktopSignInChallenge,
	limitDesktopSignIn,
	pollDesktopSignIn,
	startDesktopSignIn,
} from "./desktop-sign-in.ts";
import { authApiKeys, desktopSignInRequests, organizations } from "./schema.ts";
import { createCloudflareUser } from "./team.ts";
import { createTestDatabase } from "./test-runtime.ts";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createCloudflareUser>>;
const verifier = () => randomBytes(32).toString("base64url");

before(async () => {
	fixture = await createTestDatabase();
	owner = await createCloudflareUser(
		fixture.database,
		{ email: "desktop-owner@example.invalid", emailVerified: new Date() },
		{ ownerEmail: "desktop-owner@example.invalid", inviteOnly: true },
	);
});
after(async () => fixture?.dispose());

test("desktop credentials require proof and approval and can only be consumed once under concurrency", async () => {
	const proof = verifier();
	const request = await startDesktopSignIn(
		fixture.database,
		desktopSignInChallenge(proof),
	);
	assert.deepEqual(
		await pollDesktopSignIn(fixture.database, request.requestId, proof),
		{ status: "pending" },
	);
	await assert.rejects(
		pollDesktopSignIn(fixture.database, request.requestId, verifier()),
		/invalid_request/,
	);
	await approveDesktopSignIn(fixture.database, request.requestId, owner.id);
	await fixture.database
		.update(desktopSignInRequests)
		.set({ lastPolledAt: null })
		.where(eq(desktopSignInRequests.id, request.requestId));
	const results = await Promise.allSettled([
		pollDesktopSignIn(fixture.database, request.requestId, proof),
		pollDesktopSignIn(fixture.database, request.requestId, proof),
	]);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
	const complete = results.find((result) => result.status === "fulfilled");
	assert.ok(
		complete?.status === "fulfilled" && complete.value.status === "complete",
	);
	assert.equal(complete.value.user_id, owner.id);
	assert.equal((await fixture.database.select().from(authApiKeys)).length, 1);
	await assert.rejects(
		pollDesktopSignIn(fixture.database, request.requestId, proof),
		/invalid_request/,
	);
});

test("expiry, rapid polling and invalid approval do not mint credentials", async () => {
	const proof = verifier();
	const request = await startDesktopSignIn(
		fixture.database,
		desktopSignInChallenge(proof),
	);
	await pollDesktopSignIn(fixture.database, request.requestId, proof);
	await assert.rejects(
		pollDesktopSignIn(fixture.database, request.requestId, proof),
		/slow_down/,
	);
	await fixture.database
		.update(desktopSignInRequests)
		.set({ expiresAt: new Date(0) })
		.where(eq(desktopSignInRequests.id, request.requestId));
	await assert.rejects(
		approveDesktopSignIn(fixture.database, request.requestId, owner.id),
		/invalid_request/,
	);
	await assert.rejects(
		pollDesktopSignIn(fixture.database, request.requestId, proof),
		/invalid_request/,
	);
	assert.equal((await fixture.database.select().from(authApiKeys)).length, 1);
});

test("start and poll rate quotas stay bounded under concurrent calls", async () => {
	const results = await Promise.allSettled(
		Array.from({ length: 4 }, () =>
			limitDesktopSignIn(fixture.database, "test-address", 2),
		),
	);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		2,
	);
});

test("workspace access is checked again when consuming approved sign-in", async () => {
	const proof = verifier();
	const request = await startDesktopSignIn(
		fixture.database,
		desktopSignInChallenge(proof),
	);
	await approveDesktopSignIn(fixture.database, request.requestId, owner.id);
	assert.ok(owner.activeOrganizationId);
	await fixture.database
		.update(organizations)
		.set({ tombstoneAt: new Date() })
		.where(eq(organizations.id, owner.activeOrganizationId));
	await assert.rejects(
		pollDesktopSignIn(fixture.database, request.requestId, proof),
		/Workspace membership is required/,
	);
	assert.equal((await fixture.database.select().from(authApiKeys)).length, 1);
});
