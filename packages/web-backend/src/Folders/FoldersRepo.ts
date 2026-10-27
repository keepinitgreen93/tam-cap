import * as Db from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Folder, type Organisation, type User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Array, Effect, Option } from "effect";
import type { Schema } from "effect/Schema";
import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";
import {
	activeFolder,
	createFolder,
	deleteFolderTree,
	updateFolder,
} from "./persistence.ts";

export type CreateFolderInput = Omit<
	Schema.Type<typeof Folder.Folder>,
	"id" | "createdAt" | "updatedAt"
> & {
	organizationId: Organisation.OrganisationId;
	createdById: User.UserId;
};

export class FoldersRepo extends Effect.Service<FoldersRepo>()("FoldersRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		/**
		 * Gets a `Folder` by its ID.
		 */
		const getById = (
			id: Folder.FolderId,
			filters?: { organizationId?: Organisation.OrganisationId },
		) =>
			db
				.use((db) =>
					db
						.select()
						.from(Db.folders)
						.where(
							Dz.and(
								Dz.eq(Db.folders.id, id),
								activeFolder,
								filters?.organizationId &&
									Dz.eq(Db.folders.organizationId, filters.organizationId),
							),
						),
				)
				.pipe(Effect.map(Array.get(0)));

		const delete_ = (id: Folder.FolderId, userId: User.UserId) =>
			db.use((database) => deleteFolderTree(database, id, userId));

		const create = (data: CreateFolderInput) =>
			Effect.gen(function* () {
				const id = Folder.FolderId.make(nanoId());
				const now = new Date();
				yield* db.use((database) =>
					createFolder(database, {
						...data,
						id,
						createdAt: now,
						updatedAt: now,
						parentId: Option.getOrNull(data.parentId ?? Option.none()),
						spaceId: Option.getOrNull(data.spaceId ?? Option.none()),
					}),
				);
				return id;
			});

		const update = (
			id: Folder.FolderId,
			userId: User.UserId,
			data: Parameters<typeof updateFolder>[3],
		) => db.use((database) => updateFolder(database, id, userId, data));

		return { getById, delete: delete_, create, update };
	}),
	dependencies: [Database.Default],
}) {}
