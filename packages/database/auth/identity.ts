import { domainToASCII } from "node:url";

export function normalizeEmail(value: string): string {
	const parts = value.trim().normalize("NFC").split("@");
	if (parts.length !== 2) throw new Error("Invalid email address");
	const local = parts[0]?.toLowerCase().normalize("NFC") ?? "";
	const rawDomain = parts[1]?.toLowerCase() ?? "";
	if (/[\p{Cc}\p{Cf}\s/@:#?\\<>()[\],;"]/u.test(rawDomain))
		throw new Error("Invalid email address");
	const domain = domainToASCII(rawDomain);
	if (
		!local ||
		new TextEncoder().encode(local).byteLength > 64 ||
		/[\p{Cc}\p{Cf}\s<>()[\]\\,;:"]/u.test(local) ||
		local.startsWith(".") ||
		local.endsWith(".") ||
		local.includes("..") ||
		!domain ||
		!domain.includes(".") ||
		domain.length > 253 ||
		domain
			.split(".")
			.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	)
		throw new Error("Invalid email address");
	const email = `${local}@${domain}`;
	if (new TextEncoder().encode(email).byteLength > 255)
		throw new Error("Email address exceeds 255 characters");
	return email;
}

export function cloudflareAccessPolicy() {
	if (process.env.CAP_RUNTIME !== "cloudflare")
		throw new Error(
			"Cloudflare access policy requires CAP_RUNTIME=cloudflare.",
		);
	if (process.env.CAP_INVITE_ONLY === "false")
		throw new Error("Cloudflare team registration must remain invite-only.");
	return {
		ownerEmail: normalizeEmail(
			process.env.CAP_OWNER_EMAIL ?? "hello@trulyauthenticmarketing.com",
		),
		inviteOnly: true as const,
	};
}
