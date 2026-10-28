export const cloudflareWhisperResponse = {
	success: true,
	result: {
		transcription_info: {
			language: "en",
			language_probability: 1,
			duration: 16.3933125,
			duration_after_vad: 16.3933125,
		},
		text: "Hello. Um, this is our team recording test. Uh, we can record, edit, and share this video. This test includes quiet pauses and filler words.",
		word_count: 25,
		segments: [
			{
				start: 0,
				end: 3.78,
				text: " Hello. Um, this is our team recording test.",
				temperature: 0,
				avg_logprob: -0.27477133564832734,
				compression_ratio: 1.2612612612612613,
				no_speech_prob: 0,
				words: [
					{
						word: " Hello.",
						start: 0,
						end: 0.34,
					},
					{
						word: " Um,",
						start: 0.96,
						end: 1.62,
					},
					{
						word: " this",
						start: 1.88,
						end: 2.28,
					},
					{
						word: " is",
						start: 2.28,
						end: 2.44,
					},
					{
						word: " our",
						start: 2.44,
						end: 2.62,
					},
					{
						word: " team",
						start: 2.62,
						end: 2.84,
					},
					{
						word: " recording",
						start: 2.84,
						end: 3.32,
					},
					{
						word: " test.",
						start: 3.32,
						end: 3.78,
					},
				],
				word_count: 8,
			},
			{
				start: 6.26,
				end: 9.8,
				text: " Uh, we can record, edit, and share this video.",
				temperature: 0,
				avg_logprob: -0.27477133564832734,
				compression_ratio: 1.2612612612612613,
				no_speech_prob: 0,
				words: [
					{
						word: " Uh,",
						start: 6.26,
						end: 6.92,
					},
					{
						word: " we",
						start: 7.16,
						end: 7.48,
					},
					{
						word: " can",
						start: 7.48,
						end: 7.68,
					},
					{
						word: " record,",
						start: 7.68,
						end: 8.1,
					},
					{
						word: " edit,",
						start: 8.32,
						end: 8.56,
					},
					{
						word: " and",
						start: 8.72,
						end: 8.94,
					},
					{
						word: " share",
						start: 8.94,
						end: 9.22,
					},
					{
						word: " this",
						start: 9.22,
						end: 9.42,
					},
					{
						word: " video.",
						start: 9.42,
						end: 9.8,
					},
				],
				word_count: 9,
			},
			{
				start: 12.26,
				end: 15.46,
				text: " This test includes quiet pauses and filler words.",
				temperature: 0,
				avg_logprob: -0.27477133564832734,
				compression_ratio: 1.2612612612612613,
				no_speech_prob: 0,
				words: [
					{
						word: " This",
						start: 12.26,
						end: 12.92,
					},
					{
						word: " test",
						start: 12.92,
						end: 13.22,
					},
					{
						word: " includes",
						start: 13.22,
						end: 13.66,
					},
					{
						word: " quiet",
						start: 13.66,
						end: 14.06,
					},
					{
						word: " pauses",
						start: 14.06,
						end: 14.52,
					},
					{
						word: " and",
						start: 14.52,
						end: 14.74,
					},
					{
						word: " filler",
						start: 14.74,
						end: 15.04,
					},
					{
						word: " words.",
						start: 15.04,
						end: 15.46,
					},
				],
				word_count: 8,
			},
		],
		vtt: "WEBVTT\n\n00:00.000 --> 00:00.340\n Hello.\n\n00:00.960 --> 00:01.620\n Um,\n\n00:01.880 --> 00:02.280\n this\n\n00:02.280 --> 00:02.440\n is\n\n00:02.440 --> 00:02.620\n our\n\n00:02.620 --> 00:02.840\n team\n\n00:02.840 --> 00:03.320\n recording\n\n00:03.320 --> 00:03.780\n test.\n\n00:06.260 --> 00:06.920\n Uh,\n\n00:07.160 --> 00:07.480\n we\n\n00:07.480 --> 00:07.680\n can\n\n00:07.680 --> 00:08.100\n record,\n\n00:08.320 --> 00:08.560\n edit,\n\n00:08.720 --> 00:08.940\n and\n\n00:08.940 --> 00:09.220\n share\n\n00:09.220 --> 00:09.420\n this\n\n00:09.420 --> 00:09.800\n video.\n\n00:12.260 --> 00:12.920\n This\n\n00:12.920 --> 00:13.220\n test\n\n00:13.220 --> 00:13.660\n includes\n\n00:13.660 --> 00:14.060\n quiet\n\n00:14.060 --> 00:14.520\n pauses\n\n00:14.520 --> 00:14.740\n and\n\n00:14.740 --> 00:15.040\n filler\n\n00:15.040 --> 00:15.460\n words.\n\n",
		usage: {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			prompt_tokens_details: {
				cached_tokens: 0,
			},
			neurons: 12.740400977182574,
		},
	},
};
