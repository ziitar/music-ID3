# Music Library Desktop Application Design

Date: 2026-09-04
Status: Design approved in conversation; implementation not started

## 1. Scope

Build a Windows desktop application for personal offline learning and open-source distribution. The application recursively scans a user-selected music directory, reads and writes metadata with `node-taglib-sharp`, reads/displays/edits CUE sheets, generates candidate CUE sheets for suspected whole-disc files, and retrieves metadata from MusicBrainz, CTDB, NetEase Cloud Music, and QQ Music.

The first implementation includes all requested capabilities. Network metadata is best-effort and must never block local file scanning or local tag/CUE editing.

## 2. Architecture

Use Electron + React + TypeScript + Vite.

- Electron main process owns filesystem access, recursive scanning, `node-taglib-sharp`, CUE encoding and persistence, online requests, rate limiting, and Cookie decryption.
- Preload exposes a typed, allow-listed IPC API through `contextBridge`. The renderer has no direct Node.js access.
- React renderer owns the three-pane desktop UI and all transient editing state.
- Metadata providers implement an adapter interface so upstream API changes do not affect local library services.
- No database in the first version. Library state and pending edits are in memory; reopening a directory rescans it.
- Configuration is stored below Electron `app.getPath('userData')`.

Proposed modules:

```text
electron/
  main.ts
  preload.ts
  ipc/
  services/
    library-scanner.ts
    tag-service.ts
    cue-service.ts
    cookie-store.ts
    metadata/
      musicbrainz-adapter.ts
      ctdb-adapter.ts
      netease-adapter.ts
      qqmusic-adapter.ts
renderer/
  views/
    LibraryView
    TrackView
    CueEditorView
    SettingsView
  components/
  stores/
shared/
  types/
```

## 3. Main UI

Use a three-pane layout:

- Left: selected root directory, directory tree, scan progress, and filters.
- Center: current directory's audio/CUE list with format, duration, size, and whole-track state.
- Right: selected item details: cover, common tags, raw tags, CUE editor, or online candidate panel.

Clicking an item updates the right pane without navigating away from the library. Long-running scans and network requests report progress and support cancellation where practical.

## 4. Library Scanning and Association

Recursively scan these audio extensions:

```text
mp3, flac, m4a, mp4, ogg, opus, wav, ape, wv
```

Also scan `.cue` files. The scanner reads file size, duration, common metadata, cover art, and errors without modifying files.

Association rules:

- Resolve `FILE` paths from the CUE relative to the CUE directory.
- Match referenced filenames case-insensitively and support relative paths.
- Keep CUE entries visible when referenced files are missing, with an explicit missing-file state.
- Keep multiple CUE files separate; do not merge them.
- Preserve CUE files containing multiple `FILE` directives.
- Audio files without a CUE remain independent library items.

If an audio file has no associated CUE and its duration is greater than 15 minutes, mark it as `suspected`. File size is displayed and may support matching, but there is no hard size threshold. The user can override this state to `overridden` and process the file as normal audio.

```ts
type LibraryItem =
  | {
      kind: "audio";
      path: string;
      fileName: string;
      extension: string;
      sizeBytes: number;
      durationMs: number;
      metadata: AudioMetadata;
      cover?: CoverArt;
      cuePath?: string;
      wholeTrackStatus: "normal" | "suspected" | "overridden";
    }
  | {
      kind: "cue";
      path: string;
      encoding: CueEncoding;
      rawText: string;
      parsed: CueDocument;
      referencedFiles: string[];
      missingReferencedFiles: string[];
    };
```

## 5. Tag Service

Wrap `node-taglib-sharp` behind a service; renderer code never handles TagLib objects.

Common fields:

```ts
type CommonMetadata = {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  discTotal?: number;
  date?: string;
  genre?: string;
  composer?: string;
  comment?: string;
  lyrics?: string;
  copyright?: string;
  cover?: CoverArt;
};
```

Show both common fields and an advanced raw-tag view. Map by format in the service layer:

- MP3 to ID3v2;
- FLAC, OGG, OPUS, and WV to Vorbis Comments plus picture metadata;
- M4A/MP4 to MP4 atoms;
- WAV and APE according to the capabilities exposed by TagLib.

Only explicitly selected fields are overwritten. Unselected fields remain unchanged. Clearing a field requires an explicit selection and confirmation. Unsupported fields are disabled with an explanation rather than silently dropped. After writing, reread the file and refresh the view. Audio files are not backed up.

## 6. CUE Service

Use npm package `cue-parser` (`0.3.0`, MIT, `justlaputa/cue-parser`) behind a local wrapper. The wrapper isolates its API and leaves room to replace it if needed.

Encoding:

- Detect UTF-8, UTF-8 BOM, GB18030/GBK, Big5, and Shift-JIS.
- Display an uncertain detection as candidate encodings with a preview.
- Default target encoding is UTF-8 with BOM.
- Allow saving in another selected encoding.

Parsing and editing:

- Support `REM`, `PERFORMER`, `TITLE`, `FILE`, `TRACK`, `INDEX`, `PREGAP`, `POSTGAP`, and `SONGWRITER`.
- Preserve unknown directives, comments, and original lines.
- Provide structured editing and raw text editing modes.
- Validate syntax when switching modes and before saving.

Candidate generation:

- Derive an album query from local tags, filename, and directory name.
- Let the user choose a MusicBrainz release candidate.
- Convert MusicBrainz CD offsets (75 frames/second) to CUE `INDEX 01` times relative to the first track offset.
- Reference the local whole-disc file in `FILE`.
- Populate album, artist, date, track titles, track artists, and track numbers.
- Display source, release, Disc ID, and confidence in the editor.
- Mark uncertain candidates as inferred and require confirmation before saving.

Saving:

- New CUE files save directly.
- Overwriting an existing CUE creates a same-directory `.bak` first.
- Validate `FILE`, track numbering, time syntax, and monotonic `INDEX 01` values.
- On failure keep the editor content and leave the original intact.

## 7. Metadata Sources

```ts
interface MetadataAdapter {
  search(query: string): Promise<MetadataCandidate[]>;
  getDetails(id: string): Promise<MetadataCandidate>;
  getCover?(candidate: MetadataCandidate): Promise<CoverArt | undefined>;
}
```

MusicBrainz is the primary release/TOC source. Use it for release date, artist, track list, country, format, Disc ID, and offsets. Use Cover Art Archive for cover art. Use CTDB as optional validation of a local whole-disc rip; CTDB failure or no match never blocks candidate generation.

Extract only search and song-detail/cover logic from the specified NetEase Cloud Music API Enhanced and QQ Music API projects. Keep each implementation in its own adapter, include source/version/license notices, and map results to `MetadataCandidate`.

Normal audio searches default to artist + title. Album/CUE/whole-track searches default to artist + album. Users can edit the query and choose a provider.

Candidate ranking combines title/artist similarity, track count, total and per-track durations, Disc ID/TOC match, and CTDB validation. Show source, release, date, artist, album, track count, matching evidence, and confidence (`high`, `medium`, `low`).

The write flow is always: search -> choose candidate -> preview old/new values -> select fields -> confirm -> write -> reread. Whole-track suspected files go to candidate CUE generation by default; they do not receive ordinary per-track metadata unless the user overrides the state.

## 8. Cookie Storage and Network Behavior

Provide separate settings for NetEase and QQ Music Cookie strings. The user pastes them manually, tests connectivity, or clears them. Do not simulate login or store account passwords.

- Encrypt Cookie strings with Electron `safeStorage` before writing them below `userData`.
- Decrypt only in the main process immediately before an adapter request.
- Inject Cookie through the request header using Electron's network request API.
- Keep source-specific cookies separate.
- Redact cookies from logs, errors, renderer state, and crash reports.
- Apply request timeouts, cancellation, retry limits, and provider-specific rate limits.
- MusicBrainz read-only search/lookup needs no login or API key, but must send a meaningful User-Agent and obey rate limits.

Cache current-session online results in memory. MusicBrainz and Cover Art responses may use an expiring `userData` cache; NetEase and QQ default to session-only caching. Provide a clear-online-cache action.

## 9. Testing and Packaging

Unit tests cover scanning, association, missing references, 15-minute heuristic and override, encoding, `cue-parser` wrapper, offset conversion, tag mapping, Cookie encryption/redaction, and provider response mapping.

Integration fixtures cover TagLib read/write, cover replacement, CUE backup creation, and simulated online success, timeout, rate limiting, and empty results.

Desktop tests cover directory selection, progressive scanning, details, tag diff/write, candidate CUE editing, Cookie settings, Chinese paths, Windows paths, and encoding cases.

Use `electron-builder` for a Windows NSIS installer and a portable build. Rebuild native modules during packaging and build/test on a Windows CI runner.

## 10. Documentation and Legal Notes

Provide `README.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`. Document all extracted upstream sources, versions, licenses, and modification scope. State that NetEase and QQ endpoints are unofficial and may stop working, and that the QQ upstream repository's non-commercial learning warning applies. State that Cookies and local media metadata stay on the user's machine and are not uploaded by this application.

## 11. Acceptance Criteria

- A selected directory recursively lists supported audio and CUE files.
- Clicking an audio file displays common tags, raw tags, duration, size, and cover art.
- Editing selected fields writes successfully and is verified by rereading.
- CUE files display correctly across supported encodings, can be edited, converted, and saved with `.bak` on overwrite.
- Unassociated audio longer than 15 minutes is marked suspected and guides candidate CUE creation, with a normal-audio override.
- MusicBrainz release candidates can generate a preview CUE with calculated `INDEX 01` values.
- NetEase and QQ searches retain encrypted Cookies across restarts and show candidates with cover art and metadata.
- No online failure prevents local scanning or local editing.
- Windows installer and portable builds launch successfully.
