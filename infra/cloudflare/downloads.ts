const artifactKey =
	/^(?:manifest\.json|v\d+\.\d+\.\d+(?:[-.][a-z0-9]+)*\/TAMCap-(?:Windows-x64-setup\.exe|macOS-(?:arm64|x64)\.dmg|Chrome\.zip|checksums\.txt))$/;

export async function downloadArtifact(
	request: Request,
	path: string,
	bucket: R2Bucket,
	preview: boolean,
) {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	const key = path.slice("/downloads/".length);
	if (!artifactKey.test(key)) return new Response("Not found", { status: 404 });
	let object: R2Object | R2ObjectBody | null;
	try {
		object =
			request.method === "HEAD"
				? await bucket.head(key)
				: await bucket.get(key);
	} catch {
		return new Response("Downloads temporarily unavailable", { status: 503 });
	}
	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("ETag", object.httpEtag);
	headers.set("Content-Length", String(object.size));
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Content-Disposition",
		`attachment; filename="${key.split("/").at(-1)}"`,
	);
	headers.set(
		"Cache-Control",
		preview
			? "private, no-store"
			: key === "manifest.json"
				? "public, max-age=60"
				: "public, max-age=31536000, immutable",
	);
	const body = request.method === "HEAD" ? null : (object as R2ObjectBody).body;
	if (request.headers.get("if-none-match") === object.httpEtag) {
		await body?.cancel();
		headers.delete("Content-Length");
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { headers });
}
