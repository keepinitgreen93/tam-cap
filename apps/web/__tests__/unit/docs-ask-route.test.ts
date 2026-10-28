import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModelSelection } from "@/lib/ai/provider";
import { applicationHeaders } from "../../../../infra/cloudflare/request-headers";

const getAiProviderChainMock = vi.hoisted(() => vi.fn());
const isAiConfiguredMock = vi.hoisted(() => vi.fn());
const isRateLimitedMock = vi.hoisted(() => vi.fn());
const getAllDocsMock = vi.hoisted(() => vi.fn());
const buildDocsAskContextMock = vi.hoisted(() => vi.fn());
const buildDocsAskSystemPromptMock = vi.hoisted(() => vi.fn());
const authMocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	requireWorkspaceAccount: vi.fn(),
	Denied: class WorkspaceAccountRequiredError extends Error {},
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: authMocks.getCurrentUser,
}));
vi.mock("@cap/database/cloudflare/access", () => ({
	requireWorkspaceAccount: authMocks.requireWorkspaceAccount,
	WorkspaceAccountRequiredError: authMocks.Denied,
}));
vi.mock("@cap/database/cloudflare/application", () => ({ db: () => ({}) }));
vi.mock("@cap/database/cloudflare/atomic", () => ({
	atomic: async (
		_database: unknown,
		plan: (snapshot: unknown) => Promise<unknown>,
	) => plan({}),
}));

vi.mock("@/lib/ai/provider", () => ({
	getAiProviderChain: getAiProviderChainMock,
	isAiConfigured: isAiConfiguredMock,
}));

vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: isRateLimitedMock,
	RATE_LIMIT_IDS: { DOCS_ASK: "docs-ask" },
}));

vi.mock("@/utils/docs", () => ({
	getAllDocs: getAllDocsMock,
}));

vi.mock("@/lib/docs-ask", () => ({
	buildDocsAskContext: buildDocsAskContextMock,
	buildDocsAskSystemPrompt: buildDocsAskSystemPromptMock,
}));

const testUsage = {
	inputTokens: {
		total: 1,
		noCache: 1,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: {
		total: 1,
		text: 1,
		reasoning: undefined,
	},
};

const streamFromDeltas = (deltas: string[]) =>
	convertArrayToReadableStream([
		{ type: "stream-start" as const, warnings: [] },
		{ type: "text-start" as const, id: "1" },
		...deltas.map((delta) => ({
			type: "text-delta" as const,
			id: "1",
			delta,
		})),
		{ type: "text-end" as const, id: "1" },
		{
			type: "finish" as const,
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: testUsage,
		},
	]);

const makeSelection = (
	model: MockLanguageModelV4,
	overrides: Partial<AiModelSelection> = {},
): AiModelSelection => ({
	provider: "groq",
	modelId: "test-model",
	model: () => model,
	supportsStreaming: true,
	supportsTemperature: true,
	defaultMaxOutputTokens: 2000,
	...overrides,
});

const makeRequest = (body: unknown) =>
	new Request("http://localhost/api/docs/ask", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as NextRequest;

describe("docs ask route", () => {
	beforeEach(() => {
		vi.stubEnv("CAP_RUNTIME", "");
		authMocks.getCurrentUser.mockReset();
		authMocks.requireWorkspaceAccount.mockReset();
		authMocks.getCurrentUser.mockResolvedValue({ id: "workspace-user" });
		authMocks.requireWorkspaceAccount.mockResolvedValue({
			id: "workspace-user",
		});
		isAiConfiguredMock.mockReturnValue(true);
		isRateLimitedMock.mockResolvedValue(false);
		getAllDocsMock.mockReturnValue([]);
		buildDocsAskContextMock.mockReturnValue({ context: "" });
		buildDocsAskSystemPromptMock.mockReturnValue("system prompt");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.unstubAllEnvs());

	it("streams the model output as plain text", async () => {
		const model = new MockLanguageModelV4({
			doStream: { stream: streamFromDeltas(["Hello ", "world!"]) },
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.text()).resolves.toBe("Hello world!");
		expect(authMocks.getCurrentUser).not.toHaveBeenCalled();
	});

	it("falls through to the next provider when streaming setup fails", async () => {
		const failingModel = new MockLanguageModelV4({
			doStream: async () => {
				throw new Error("primary provider down");
			},
		});
		const workingModel = new MockLanguageModelV4({
			doStream: { stream: streamFromDeltas(["Hello ", "world!"]) },
		});
		getAiProviderChainMock.mockReturnValue([
			makeSelection(failingModel),
			makeSelection(workingModel, { provider: "openai" }),
		]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("Hello world!");
	});

	it("returns 503 when no AI provider is configured", async () => {
		isAiConfiguredMock.mockReturnValue(false);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: "Ask AI is not available right now. Try searching instead.",
		});
		// The gate must ask about the streaming role — a generation-only
		// configuration must not let requests through to an empty chain.
		expect(isAiConfiguredMock).toHaveBeenCalledWith("chat-streaming");
	});

	it("returns 502 when every provider fails", async () => {
		const failingModel = new MockLanguageModelV4({
			doStream: async () => {
				throw new Error("provider down");
			},
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(failingModel)]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: "Ask AI is having trouble right now. Try again shortly.",
		});
	});

	it("rejects questions that are too short", async () => {
		getAiProviderChainMock.mockReturnValue([]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(makeRequest({ question: "hi" }));

		expect(response.status).toBe(400);
	});

	it("requires a session before Cloudflare docs AI work", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		authMocks.getCurrentUser.mockResolvedValue(null);
		getAiProviderChainMock.mockClear();
		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(makeRequest({ question: "How do I record?" }));
		expect(response.status).toBe(401);
		expect(authMocks.requireWorkspaceAccount).not.toHaveBeenCalled();
		expect(getAiProviderChainMock).not.toHaveBeenCalled();
	});

	it("denies viewer-only or revoked workspace access before Cloudflare AI", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		authMocks.requireWorkspaceAccount.mockRejectedValue(new authMocks.Denied());
		getAiProviderChainMock.mockClear();
		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(makeRequest({ question: "How do I record?" }));
		expect(response.status).toBe(403);
		expect(getAiProviderChainMock).not.toHaveBeenCalled();
	});

	it("retains Cloudflare docs AI for an authenticated workspace member", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		const model = new MockLanguageModelV4({
			doStream: { stream: streamFromDeltas(["Team answer"]) },
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);
		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(makeRequest({ question: "How do I record?" }));
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("Team answer");
		expect(authMocks.requireWorkspaceAccount).toHaveBeenCalledWith(
			{},
			"workspace-user",
		);
	});

	it("rejects cross-site cookie requests before the Cloudflare account lookup", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		const incoming = makeRequest({ question: "How do I record?" });
		incoming.headers.set("sec-fetch-site", "cross-site");
		const { POST } = await import("@/app/api/docs/ask/route");
		expect((await POST(incoming)).status).toBe(401);
		expect(authMocks.getCurrentUser).not.toHaveBeenCalled();
	});

	it("bounds streamed request bytes before JSON parsing or provider execution", async () => {
		getAiProviderChainMock.mockClear();
		let canceled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(40_000));
			},
			cancel() {
				canceled = true;
			},
		});
		const incoming = new Request(
			"http://localhost/api/docs/ask",
			Object.assign(
				{ method: "POST", headers: { "content-length": "1" }, body: stream },
				{ duplex: "half" },
			),
		) as NextRequest;
		const { POST } = await import("@/app/api/docs/ask/route");
		expect((await POST(incoming)).status).toBe(413);
		expect(canceled).toBe(true);
		expect(getAiProviderChainMock).not.toHaveBeenCalled();
	});

	it("rejects malformed UTF-8 before provider execution", async () => {
		getAiProviderChainMock.mockClear();
		const incoming = new Request("http://localhost/api/docs/ask", {
			method: "POST",
			body: new Uint8Array([0xff]),
		}) as NextRequest;
		const { POST } = await import("@/app/api/docs/ask/route");
		expect((await POST(incoming)).status).toBe(400);
		expect(getAiProviderChainMock).not.toHaveBeenCalled();
	});

	it("retains only the bounded recent conversation before model execution", async () => {
		const model = new MockLanguageModelV4({
			doStream: { stream: streamFromDeltas(["Bounded answer"]) },
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);
		const history = Array.from({ length: 20 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: index === 19 ? "z".repeat(5000) : `Turn ${index}`,
		}));
		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record?", history }),
		);
		expect(response.status).toBe(200);
		await response.text();
		const prompt = model.doStreamCalls[0]?.prompt;
		expect(prompt).toHaveLength(14);
		expect(JSON.stringify(prompt)).not.toContain("Turn 7");
		expect(JSON.stringify(prompt)).toContain("Turn 8");
		expect(JSON.stringify(prompt)).toContain("z".repeat(4000));
		expect(JSON.stringify(prompt)).not.toContain("z".repeat(4001));
	});

	it("keeps one Cloudflare client's AI budget across spoofed forwarding prefixes", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		const model = new MockLanguageModelV4({
			doStream: async () => ({ stream: streamFromDeltas(["Team answer"]) }),
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);
		const { POST } = await import("@/app/api/docs/ask/route");
		const statuses = [];
		for (let index = 0; index < 11; index++) {
			const incoming = makeRequest({ question: "How do I record?" });
			incoming.headers.set("cf-connecting-ip", "203.0.113.45");
			incoming.headers.set("x-forwarded-for", `198.51.100.${index + 1}`);
			const response = await POST(
				new Request(incoming, {
					headers: applicationHeaders(incoming),
				}) as NextRequest,
			);
			statuses.push(response.status);
			await response.text();
		}
		expect(statuses).toEqual([...Array(10).fill(200), 429]);
		expect(model.doStreamCalls).toHaveLength(10);
	});
});
