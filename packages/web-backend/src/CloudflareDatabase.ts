import { db } from "@cap/database/cloudflare/application";
import { DatabaseError } from "@cap/web-domain";
import { Effect } from "effect";

export type CloudflareDbClient = ReturnType<typeof db>;

export class CloudflareDatabase extends Effect.Service<CloudflareDatabase>()(
	"CloudflareDatabase",
	{
		effect: Effect.gen(function* () {
			return {
				use: <T>(callback: (database: CloudflareDbClient) => Promise<T>) =>
					Effect.tryPromise({
						try: () => callback(db()),
						catch: (cause) => new DatabaseError({ cause }),
					}),
			};
		}),
	},
) {}
