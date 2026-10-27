import { createAnalyticsRepository } from "@cap/database/cloudflare/analytics/repository";
import { analyticsEvents } from "@cap/database/cloudflare/analytics/schema";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAnalyticsTestDatabase } from "../../../../packages/database/cloudflare/analytics/test-runtime";

let fixture: Awaited<ReturnType<typeof createAnalyticsTestDatabase>>;
let repository: ReturnType<typeof createAnalyticsRepository>;
const now = new Date();
const hour = 60 * 60 * 1000;
const base = new Date(Math.floor(now.getTime() / hour) * hour - 2 * hour);
const scope = {
	organizationId: "organization",
	from: new Date(base.getTime() - hour),
	to: now,
};
beforeAll(async () => {
	fixture = await createAnalyticsTestDatabase();
	repository = createAnalyticsRepository(
		fixture.database,
		"analytics-test-secret",
	);
});
afterAll(async () => fixture.dispose());

it("deduplicates retries and counts sessions independently by video and tenant", async () => {
	const event = {
		organizationId: "organization",
		videoId: "video-one",
		sessionId: "session-a",
		occurredAt: base,
		country: "US",
		city: "New York",
		browser: "Chrome",
		device: "desktop",
		os: "Windows",
	};
	expect(
		(
			await Promise.all([
				repository.recordView(event),
				repository.recordView(event),
			])
		).sort(),
	).toEqual([false, true]);
	await repository.recordView({
		...event,
		occurredAt: new Date(base.getTime() + 60000),
	});
	await repository.recordView({ ...event, videoId: "video-two" });
	await repository.recordView({
		...event,
		sessionId: "session-b",
		occurredAt: new Date(base.getTime() + hour),
		country: "CA",
		city: "Toronto",
		browser: "Safari",
	});
	await repository.recordView({
		...event,
		organizationId: "other-organization",
		sessionId: "other",
	});
	expect(
		(await repository.countViews(scope)).sort((a, b) =>
			a.videoId.localeCompare(b.videoId),
		),
	).toEqual([
		{ videoId: "video-one", views: 2 },
		{ videoId: "video-two", views: 1 },
	]);
	expect(await repository.countViews({ ...scope, videoIds: [] })).toEqual([]);
	expect(await repository.viewSeries(scope, "hour")).toEqual([
		{ bucket: base.toISOString().replace(".000Z", "Z"), views: 1 },
		{
			bucket: new Date(base.getTime() + hour)
				.toISOString()
				.replace(".000Z", "Z"),
			views: 1,
		},
	]);
	expect(await repository.breakdown(scope, "country")).toEqual([
		{ name: "CA", views: 1 },
		{ name: "US", views: 1 },
	]);
	expect(await repository.topCaps(scope)).toEqual([
		{ videoId: "video-one", views: 2 },
		{ videoId: "video-two", views: 1 },
	]);
});

it("keeps Unicode geography and stores no raw session identifier or IP", async () => {
	await repository.recordView({
		organizationId: "unicode",
		videoId: "video",
		sessionId: "private-session",
		occurredAt: base,
		country: "DE",
		region: "Bayern",
		city: "München",
	});
	expect(
		await repository.cityBreakdown({ ...scope, organizationId: "unicode" }),
	).toEqual([{ name: "München", country: "DE", views: 1 }]);
	const rows = await fixture.database.select().from(analyticsEvents);
	expect(JSON.stringify(rows)).not.toContain("private-session");
	expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.sessionHash))).toBe(
		true,
	);
	const columns = await fixture.binding
		.prepare("PRAGMA table_info(analytics_events)")
		.all<{ name: string }>();
	expect(
		columns.results.some((row) =>
			/ip_address|user_agent|session_id/.test(row.name),
		),
	).toBe(false);
});

it("filters expired data before cleanup and deletes it in bounded batches", async () => {
	const expired = new Date(now.getTime() - 91 * 24 * hour);
	await fixture.database.insert(analyticsEvents).values({
		id: "a".repeat(64),
		organizationId: "expired",
		videoId: "video",
		sessionHash: "b".repeat(64),
		occurredAt: expired,
		expiresAt: new Date(expired.getTime() + 90 * 24 * hour),
	});
	expect(
		await repository.countViews({
			organizationId: "expired",
			from: expired,
			to: now,
		}),
	).toEqual([]);
	expect(await repository.cleanup(now)).toBe(1);
});

it("writes no revision or metadata state in the separate primary binding", async () => {
	await fixture.metadataBinding
		.prepare("CREATE TABLE metadata_revision (value INTEGER NOT NULL)")
		.run();
	await fixture.metadataBinding
		.prepare("INSERT INTO metadata_revision (value) VALUES (42)")
		.run();
	await repository.recordView({
		organizationId: "isolated",
		videoId: "video",
		sessionId: "session",
		occurredAt: base,
	});
	expect(
		await fixture.metadataBinding
			.prepare("SELECT value FROM metadata_revision")
			.first("value"),
	).toBe(42);
	await expect(
		fixture.metadataBinding
			.prepare("SELECT count(*) FROM analytics_events")
			.first(),
	).rejects.toThrow();
});

it("deletes only the selected organization's analytics", async () => {
	await repository.deleteOrganization("organization");
	expect(await repository.countViews(scope)).toEqual([]);
	expect(
		await repository.countViews({
			...scope,
			organizationId: "other-organization",
		}),
	).toEqual([{ videoId: "video-one", views: 1 }]);
});
