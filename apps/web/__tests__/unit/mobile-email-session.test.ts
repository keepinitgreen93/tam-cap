import {
	authApiKeys,
	verificationTokens,
} from "@cap/database/cloudflare/schema";
import { createCloudflareUser } from "@cap/database/cloudflare/team";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createCloudflareUser>>;
const readTokens = () => fixture.database.select().from(verificationTokens);
const readKeys = () => fixture.database.select().from(authApiKeys);

import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

type TokenRow = { identifier: string; token: string; expires: Date };

const mocks = vi.hoisted(() => ({
	isRateLimited: vi.fn<(ruleId: string, opts?: unknown) => Promise<boolean>>(),
	sendEmail: vi.fn<(input: { react: { code: string } }) => Promise<void>>(),
	emailStatus: { configured: true } as
		| { configured: true }
		| { configured: false; reason: string },
	isCap: undefined as string | undefined,
	tokenRow: null as TokenRow | null,
	selectBarrier: null as null | { size: number; waiting: (() => void)[] },
	apiKeys: [] as string[],
	dispose: async () => {},
}));

vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: mocks.isRateLimited,
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: mocks.sendEmail,
	getEmailDeliveryStatus: () => mocks.emailStatus,
}));
vi.mock("@cap/env", async (importOriginal) => {
	const original = await importOriginal<typeof import("@cap/env")>();
	return {
		...original,
		buildEnv: {
			...original.buildEnv,
			get NEXT_PUBLIC_IS_CAP() {
				return mocks.isCap;
			},
		},
	};
});
vi.mock("@cap/database/emails/otp-email", () => ({
	OTPEmail: (props: { code: string; email: string }) => props,
}));
vi.mock("@/lib/account-deletion-request", () => ({
	createAccountDeletionRequest: vi.fn(),
	createMobileContentReport: vi.fn(),
	hasPendingAccountDeletion: vi.fn(async () => false),
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: () => ({
		adapter: {
			createUser: vi.fn(async ({ email }: { email: string }) => ({
				id: owner.id,
				email,
			})),
			getUserByEmail: vi.fn(async (email: string) => ({
				id: owner.id,
				email,
			})),
			updateUser: vi.fn(async ({ id }: { id: string }) => ({ id })),
		},
	}),
}));

vi.mock("@/lib/server", async () => {
	const { CloudflareDatabase, Videos } = await import("@cap/web-backend");
	const { HttpAuthMiddleware } = await import("@cap/web-domain");
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer } = await import("effect");
	const database = Layer.succeed(
		CloudflareDatabase,
		CloudflareDatabase.make({
			use: (callback) => Effect.promise(() => callback(fixture.database)),
		}),
	);
	const videos = Layer.succeed(
		Videos,
		{} as Context.Tag.Service<typeof Videos>,
	);
	const auth = Layer.succeed(HttpAuthMiddleware, Effect.die("unused"));
	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				| Context.Tag.Identifier<typeof CloudflareDatabase>
				| Context.Tag.Identifier<typeof Videos>
				| Context.Tag.Identifier<typeof HttpAuthMiddleware>
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.provideMerge(database),
				Layer.provideMerge(videos),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

describe("mobile email sessions", () => {
	let POST: typeof import("@/app/api/mobile/[...route]/route").POST;

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_PROVIDER: "d1",
			CAP_RUNTIME: "cloudflare",
			CAP_OWNER_EMAIL: "person@example.com",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			RESEND_API_KEY: "synthetic",
			NODE_ENV: "test",
		});
		fixture = await createTestDatabase();
		owner = await createCloudflareUser(
			fixture.database,
			{ email: "person@example.com", emailVerified: new Date() },
			{ ownerEmail: "person@example.com", inviteOnly: true },
		);
		({ POST } = await import("@/app/api/mobile/[...route]/route"));
	});

	beforeEach(async () => {
		await fixture.database.batch([
			fixture.database.delete(verificationTokens),
			fixture.database.delete(authApiKeys),
		]);
		mocks.isRateLimited.mockReset().mockResolvedValue(false);
		mocks.sendEmail.mockReset().mockResolvedValue(undefined);
		mocks.emailStatus = { configured: true };
		mocks.isCap = undefined;
		mocks.tokenRow = null;
		mocks.selectBarrier = null;
		mocks.apiKeys = [];
	});

	afterAll(async () => {
		await mocks.dispose();
		await fixture.dispose();
	});
	afterEach(() => vi.unstubAllEnvs());

	const post = (path: string, body: unknown) =>
		POST(
			new Request(`http://localhost/api/mobile/session/email/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	const requestCode = async (email = "person@example.com") => {
		const response = await post("request", { email });
		expect(response.status).toBe(200);
		const code = mocks.sendEmail.mock.calls.at(-1)?.[0].react.code;
		if (!code) throw new Error("No code was sent");
		return code;
	};

	const wrongCode = (code: string) => (code === "123456" ? "654321" : "123456");

	it.each([undefined, "", "false"])(
		"logs a usable self-host code with NEXT_PUBLIC_IS_CAP=%j and email disabled",
		async (isCap) => {
			mocks.isCap = isCap;
			mocks.emailStatus = {
				configured: false,
				reason: "Email is not configured",
			};
			vi.stubEnv("NODE_ENV", "production");
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const response = await post("request", { email: "person@example.com" });
			expect(response.status).toBe(200);
			expect(mocks.sendEmail).not.toHaveBeenCalled();
			const codeLine = log.mock.calls.find(([line]) =>
				/^Code: \d{6}$/.test(line),
			);
			expect(codeLine).toBeDefined();
			const code = String(codeLine?.[0]).slice("Code: ".length);
			expect(
				(await post("verify", { email: "person@example.com", code })).status,
			).toBe(200);
		},
	);

	it("fails on Cap Cloud without printing a code when email is disabled", async () => {
		mocks.emailStatus = {
			configured: false,
			reason: "Email is not configured",
		};
		mocks.isCap = "true";
		vi.stubEnv("NODE_ENV", "production");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const response = await post("request", { email: "person@example.com" });
		expect(response.status).toBe(500);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(
			log.mock.calls.some(([line]) => /^Code: \d{6}$/.test(String(line))),
		).toBe(false);
	});

	it("sends a code and signs in with it", async () => {
		const code = await requestCode(" Person@Example.com ");

		const response = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			type: "api_key",
			userId: owner.id,
		});
		expect(await readTokens()).toHaveLength(0);
		expect(mocks.isRateLimited.mock.calls.map(([ruleId]) => ruleId)).toEqual([
			"rl_auth_otp_send",
			"rl_auth_otp_verify",
		]);
	});

	it("uses one bucket per normalized email", async () => {
		await requestCode(" Person@Example.com ");
		await requestCode("person@example.com");

		const [first, second] = mocks.isRateLimited.mock.calls.map(
			([, opts]) => (opts as { key: string }).key,
		);
		expect(first).toMatch(/^email-code-send:[0-9a-f]{64}$/);
		expect(second).toBe(first);
	});

	it("returns 429 without sending when code requests are limited", async () => {
		mocks.isRateLimited.mockResolvedValue(true);

		const response = await post("request", { email: "person@example.com" });

		expect(response.status).toBe(429);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(await readTokens()).toHaveLength(0);
	});

	it("returns 429 and keeps the code when verification is limited", async () => {
		const code = await requestCode();
		mocks.isRateLimited.mockResolvedValue(true);

		const response = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(response.status).toBe(429);
		expect(await readTokens()).toHaveLength(1);
		expect(await readKeys()).toEqual([]);
	});

	it("invalidates the code after a wrong attempt", async () => {
		const code = await requestCode();

		const wrong = await post("verify", {
			email: "person@example.com",
			code: wrongCode(code),
		});
		const retry = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(wrong.status).toBe(403);
		expect(retry.status).toBe(403);
		expect(await readKeys()).toEqual([]);
	});

	it("rejects an expired code", async () => {
		const code = await requestCode();
		await fixture.database
			.update(verificationTokens)
			.set({ expires: new Date(Date.now() - 1000) });

		const response = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(response.status).toBe(403);
		expect(await readTokens()).toHaveLength(0);
	});

	it("lets only one of two concurrent verifications use a code", async () => {
		const code = await requestCode();

		const responses = await Promise.all([
			post("verify", { email: "person@example.com", code }),
			post("verify", { email: "person@example.com", code }),
		]);

		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 403,
		]);
		expect(await readKeys()).toHaveLength(1);
	});
	it("does not issue a code to an uninvited self-hosted account", async () => {
		const response = await post("request", { email: "uninvited@example.com" });
		expect(response.status).toBe(403);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(await readTokens()).toHaveLength(0);
	});
});
