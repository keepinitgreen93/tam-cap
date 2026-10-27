import type { World } from "@workflow/world";
export declare function createWorld(options?: {
	url?: string;
	fetch?: typeof globalThis.fetch;
	onLeaseLost?: () => void;
}): World;
export default createWorld;
