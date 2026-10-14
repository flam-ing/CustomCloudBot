# Session voice calls

The voice UI uses the selected conversation ID and title. Speech becomes an ordinary message in that conversation, retaining its context, model selection and the current sender's tool permissions. Forks have separate conversation IDs. The client must retain the same `clientNonce` when retrying a message submission; changing it could execute a requested action twice.

The server reuses existing Groq credentials from the environment, setup providers, or encrypted Vault resources. `GROQ_API_KEY`, numbered keys and imported Groq provider entries work without a separate voice secret or restart after saving through setup. Only the official Groq API endpoint is used. There is no fallback to a different paid provider and no credential is returned to the browser. Usage and availability follow the configured Groq account's limits.

Authenticated API:

- `GET /api/voice`: `{ configured, provider, maxSeconds: 30, maxBytes: 10485760 }`. Configuration means a matching key exists, not that its quota has been tested.
- `POST /api/rooms/:roomId/voice/transcribe`: CSRF-protected multipart `file`; returns `{ text }` and does not submit messages or invoke tools. Membership is checked before and after the request. Supported audio uploads are WebM, Ogg, WAV, MP3 and MP4. Recordings are temporary and deleted after transcription.
- Submit the transcript through the existing `POST /api/rooms/:roomId/messages` route, then read the same room's progress and bot replies.

Transcription uses [`whisper-large-v3-turbo`](https://console.groq.com/docs/speech-to-text) with automatic language detection. Requests are limited to 10 MiB, a 30-second recording, 45 seconds for the upstream request, a bounded response and one active transcription per account. A failed key may rotate to at most two other Groq keys on authentication, rate-limit or provider errors. Cancellation does not retry.

Use the phone icon at the top of a conversation (or in a split pane), then **통화 시작**. The call shows that conversation's title, stays bound to its room when navigating, and offers mute, finish-speaking, hangup, and a per-room call link. Links require existing login and membership and never start the microphone automatically. Speech is submitted after a natural pause; the microphone is stopped while transcribing or playing a response, so the bot does not hear itself. Replies use the device's Korean speech synthesis voice. Recognition failures are shown rather than retried as new commands. Normal chat permissions apply, including owner-only host administration.

The call is a foreground, turn-based voice conversation, not a full-duplex realtime audio model. The page must stay visible; backgrounding, locking, logging out or ending the call stops the microphone and pending transcription. An already accepted server task can continue and its result remains in the same chat. Browser voice calls are not PSTN calls.

The separate [iOS CallKit shell](../ios/README.md) uses this same room UUID and current title for system call UI and Recents. It is source code requiring Xcode, signing and physical-device verification; deploying the website does not install it. Incoming ringing and reliable background native audio are not implemented.
