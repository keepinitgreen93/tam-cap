import { db } from "@cap/database/legacy";
import { spaceMembers } from "@cap/database/legacy/schema";
import { sql } from "drizzle-orm";

export async function runSpaceMemberRoleBackfill() {
	await db()
		.update(spaceMembers)
		.set({ role: "admin" })
		.where(sql`LOWER(${spaceMembers.role}) = 'admin'`);
}
