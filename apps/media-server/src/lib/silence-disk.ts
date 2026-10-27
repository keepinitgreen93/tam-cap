import { statfs } from "node:fs/promises";

const HEADROOM_BYTES = 512 * 1024 * 1024;

export class SilenceDiskBudget {
	private reserved = 0;
	constructor(
		private readonly availableBytes: (path: string) => Promise<number> = async (
			path,
		) => {
			const stats = await statfs(path);
			return stats.bavail * stats.bsize;
		},
	) {}

	async reserve(path: string, size: number) {
		if (
			!Number.isSafeInteger(size) ||
			size <= 0 ||
			size > 64 * 1024 * 1024 * 1024
		)
			throw new Error("Invalid media size for silence analysis");
		const available = await this.availableBytes(path);
		if (
			!Number.isFinite(available) ||
			available - this.reserved - size < HEADROOM_BYTES
		)
			throw new Error("Insufficient disk space for silence analysis");
		this.reserved += size;
		let remaining = size;
		let released = false;
		return {
			consume: (bytes: number) => {
				if (
					released ||
					!Number.isSafeInteger(bytes) ||
					bytes < 0 ||
					bytes > remaining
				)
					throw new Error("Media size changed during silence analysis");
				remaining -= bytes;
				this.reserved -= bytes;
			},
			check: async () => {
				const free = await this.availableBytes(path);
				if (!Number.isFinite(free) || free - this.reserved < HEADROOM_BYTES)
					throw new Error("Insufficient disk space for silence analysis");
			},
			release: () => {
				if (!released) {
					this.reserved -= remaining;
					remaining = 0;
					released = true;
				}
			},
		};
	}
}

export const silenceDiskBudget = new SilenceDiskBudget();
