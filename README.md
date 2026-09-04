# Music ID3

Music ID3 is a local-first Windows desktop application for inspecting and editing music metadata and CUE sheets. It scans a selected directory recursively and keeps filesystem, tag, CUE, Cookie, and provider access in the Electron main process.

## Library scanning

The scanner recursively discovers CUE files and audio files with these case-insensitive extensions: `.mp3`, `.flac`, `.m4a`, `.mp4`, `.ogg`, `.opus`, `.wav`, `.ape`, and `.wv`. A CUE is associated with the audio paths named by its `FILE` entries. Missing references are reported without stopping the rest of the scan.

An audio file longer than 15 minutes with no associated CUE is marked as a suspected whole-disc track. This is a duration/CUE heuristic; file size is informational and is not part of the decision. Suspected files open the candidate-CUE workflow by default. Choose **Use normal audio editing** to override the state for that scan and use ordinary tag editing.

`node-taglib-sharp` 6.0.3 does not implement WavPack metadata. `.wv` files are still discovered by the library scanner, but their tags and duration cannot be read or written by this release. No second metadata engine is used as a fallback.

## Editing and backups

Only metadata fields selected in the confirmation preview are written. Clearing a value also requires selecting that field and confirming the write. The application rereads audio metadata after a write. Audio files are modified in place and are never backed up, so keep your own backup before editing valuable media.

CUE files support UTF-8, UTF-8 with BOM, GBK, GB18030, Big5, and Shift-JIS. Detection can be ambiguous for legacy encodings; review the selected encoding before saving or converting. Creating a new CUE does not create a backup. Replacing an existing CUE first preserves the prior bytes beside it as `<name>.cue.bak`, then atomically replaces the original.

## Metadata providers

- MusicBrainz supplies release search/details and disc information. Cover Art Archive supplies release artwork. They require no account or API key.
- CUETools Database (CTDB) can validate a whole-disc TOC. Failure or no match does not block candidate generation.
- NetEase Cloud Music and QQ Music use unofficial endpoints adapted from the upstream projects recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). They may change, reject a Cookie, become rate-limited, or stop working without notice. The QQ upstream code carries a learning-only/non-commercial warning; do not use that adapter commercially.

Requests time out after 10 seconds and retry a transient failure once. Minimum dispatch intervals are 1 second for MusicBrainz, 500 ms for CTDB, and 250 ms for NetEase and QQ. Results are cached in memory for the current session (15 minutes for MusicBrainz/Cover Art Archive, 5 minutes for CTDB, NetEase, and QQ) and can be cleared from Settings. There is no persistent response cache. When offline or a provider fails, recursive scanning, tag editing, and CUE editing continue to work; online search simply remains unavailable.

NetEase and QQ Cookies are optional and entered manually. They are persisted separately under Electron's per-user application data directory and encrypted with Electron `safeStorage`; plaintext Cookies are decrypted only in the main process immediately before a request. Music ID3 does not implement provider login and does not store account passwords. See [Provider Cookie operations](docs/operations/provider-cookies.md) for storage, clearing, and troubleshooting details.

Local audio files and CUE files are not uploaded. Provider use does transmit the search text you submit, provider-specific identifiers or disc TOC needed for a lookup, and the relevant provider Cookie when configured. Cover downloads contact the provider-hosted URL. Cookies are not exposed to the renderer or intentionally written to application diagnostics.

## Development

Requirements are Node.js 22.12 or newer and Windows for packaging and desktop E2E verification.

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Start the development application with `npm run dev`.

## Windows packages

Build both x64 distributions on Windows:

```powershell
npm run package:win
```

Artifacts are written to `release/` as `Music-ID3-Setup-<version>-x64.exe` (NSIS installer) and `Music-ID3-Portable-<version>-x64.exe` (portable executable). These unsigned builds may trigger Windows reputation warnings. This repository does not configure code signing or publishing.

## License

Music ID3 is released under the [MIT License](LICENSE). Bundled components and adapted provider logic retain their own terms and notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
