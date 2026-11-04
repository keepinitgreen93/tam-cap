# AI processing on the self-hosted instance

Audio transcription remains on Cloudflare Whisper. Titles, summaries, chapters and chat can use the explicitly configured OpenRouter endpoint. Other providers are not added as silent fallbacks in the Cloudflare deployment.

To activate OpenRouter, save the API key in an ignored local file and publish it through the protected runtime configuration:

```powershell
./scripts/cloudflare/runtime-secrets.ps1 -Operation Publish -AiProvider OpenRouter -AiModel z-ai/glm-5.3-flash -AiApiKeyPath .secrets/openrouter-api-key.txt
```

Deploy an application image containing OpenRouter support before publishing those settings. The operation preserves the transcription credentials and existing authentication settings, publishes the key through stdin, and reseals the encrypted runtime backup. Verify the running application has adopted the new configuration before retrying generation. OpenRouter requests use low reasoning effort and prefer low latency; GLM-5.3 Flash rejects requests that disable reasoning. To restore the prior Cloudflare text model, use `-Operation Publish -AiProvider Cloudflare`.

The November 3 repair addresses three independent processing issues:

- Whisper sometimes returns real words with identical start and end times. These are retained as one-millisecond display markers with zero confidence, excluded from automatic filler cuts. Other invalid timing ranges still fail validation.
- The editor always exposes its cleanup sidebar. Pending word timings are polled, and silence analysis remains available while transcription is pending or unavailable.
- Windows recording names use dot-separated times. Auto-title replacement recognizes them while preserving manually edited titles.

The background recovery Worker uses manual redirects and rejects redirect responses. Cloudflare rejects `redirect: "error"` when constructing its internal maintenance requests.
