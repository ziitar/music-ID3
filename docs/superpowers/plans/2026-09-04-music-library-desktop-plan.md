# Music Library Desktop Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows Electron application that recursively manages local music metadata and CUE sheets, generates candidate CUE files for suspected whole-disc audio, and supports confirmed metadata lookup/write through MusicBrainz, CTDB, NetEase Cloud Music, and QQ Music.

**Architecture:** Electron main process owns filesystem, TagLib, CUE, network, and encrypted Cookie operations. A secure preload exposes typed IPC methods to a React/Vite renderer, which implements the three-pane library UI. Services are split by responsibility and all remote providers implement one adapter contract.

**Tech Stack:** Electron, React, TypeScript, Vite, `node-taglib-sharp`, `cue-parser` 0.3.0, `chardet`/`iconv-lite`, `electron-builder`, Vitest, React Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-music-library-desktop-design.md`

## Global Constraints

- Windows desktop target; provide NSIS installer and portable build.
- Recursively scan `mp3`, `flac`, `m4a`, `mp4`, `ogg`, `opus`, `wav`, `ape`, and `wv`.
- Suspected whole-disc condition is no associated CUE and duration greater than 15 minutes; file size is informational only.
- Suspected files default to candidate CUE workflow and have a normal-audio override.
- Audio files are never backed up; overwriting a CUE creates a same-directory `.bak` first.
- Only explicitly selected metadata fields are overwritten; clearing requires explicit selection and confirmation.
- Cookie strings are manually entered, encrypted with Electron `safeStorage`, and never written to logs or renderer state.
- MusicBrainz read-only access requires no login/API key, but requests must include a meaningful User-Agent and rate limiting.
- Online failures never block local scanning or local editing.
- Upstream NetEase/QQ code must include source, version, license, and modification notices.

---

### Task 1: Bootstrap Electron, React, and TypeScript

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `electron/main.ts`
- Create: `electron/preload.ts`
- Create: `src/styles.css`
- Create: `tests/smoke/app-config.test.ts`

**Interfaces:**
- Produces scripts `dev`, `build`, `test`, `test:e2e`, `package:win`.
- Produces a BrowserWindow loading the Vite renderer in development and built assets in production.

- [ ] **Step 1: Write the failing app configuration test**

```ts
import { describe, expect, it } from "vitest";
import { supportedAudioExtensions, wholeTrackThresholdMs } from "../../shared/config";

describe("app configuration", () => {
  it("declares the supported formats and 15 minute threshold", () => {
    expect(supportedAudioExtensions).toContain(".flac");
    expect(supportedAudioExtensions).toContain(".mp3");
    expect(wholeTrackThresholdMs).toBe(15 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run `npm test -- tests/smoke/app-config.test.ts` and verify it fails because the project files do not exist.**
- [ ] **Step 3: Initialize the project and install the exact runtime/dev dependencies**

```powershell
npm init -y
npm install electron react react-dom node-taglib-sharp cue-parser iconv-lite
npm install -D typescript vite @vitejs/plugin-react electron-builder concurrently wait-on vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event playwright
```

- [ ] **Step 4: Add `shared/config.ts`, Vite, TypeScript, Electron entrypoints, and the minimal React shell.** Configure `contextIsolation: true`, `nodeIntegration: false`, and preload loading.
- [ ] **Step 5: Add scripts and Vitest configuration, then run `npm test -- tests/smoke/app-config.test.ts` and verify it passes.**
- [ ] **Step 6: Run `npm run build` and verify both renderer and Electron TypeScript outputs are generated.**
- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts index.html src electron shared tests
git commit -m "build: bootstrap electron react app"
```

### Task 2: Shared Contracts, Secure IPC, and Cookie Store

**Files:**
- Create: `shared/types.ts`
- Create: `shared/ipc.ts`
- Create: `electron/ipc/register-ipc.ts`
- Create: `electron/services/cookie-store.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Create: `tests/unit/cookie-store.test.ts`
- Create: `tests/unit/ipc-contracts.test.ts`

**Interfaces:**
- `window.musicId3.selectDirectory(): Promise<string | undefined>`
- `window.musicId3.scanDirectory(path: string): Promise<ScanStarted>`
- `window.musicId3.readAudio(path: string): Promise<AudioMetadata>`
- `window.musicId3.writeAudio(path: string, patch: MetadataPatch): Promise<WriteResult>`
- `window.musicId3.readCue(path: string): Promise<CueDocumentState>`
- `window.musicId3.saveCue(input: SaveCueInput): Promise<SaveCueResult>`
- `window.musicId3.searchMetadata(source: MetadataSource, query: string): Promise<MetadataCandidate[]>`
- `window.musicId3.setProviderCookie(source: CookieSource, value: string): Promise<void>`
- `window.musicId3.testProviderCookie(source: CookieSource): Promise<CookieTestResult>`

- [ ] **Step 1: Write failing tests for safe Cookie round-trip and redaction**

```ts
it("encrypts a provider cookie and returns it only through the store", async () => {
  const store = createCookieStore({ safeStorage: fakeSafeStorage(), userDataPath: tempDir });
  await store.set("qq", "uin=o123; skey=secret");
  expect(await store.get("qq")).toBe("uin=o123; skey=secret");
  expect(await store.redacted("qq")).toBe("configured");
  expect(await readFile(store.filePath())).not.toContain("skey=secret");
});
```

- [ ] **Step 2: Run the two unit test files and verify they fail with missing contracts/store.**
- [ ] **Step 3: Define shared discriminated unions for `LibraryItem`, `CommonMetadata`, `CueDocumentState`, `MetadataCandidate`, `MetadataSource`, and IPC result envelopes.**
- [ ] **Step 4: Implement `cookie-store.ts` using `safeStorage.encryptString`/`decryptString`, atomic JSON writes below `app.getPath('userData')`, provider-specific keys, and redacted status.**
- [ ] **Step 5: Implement preload allow-list and main-process IPC registration. Reject unknown channels and never return decrypted Cookies to the renderer.**
- [ ] **Step 6: Run `npm test -- tests/unit/cookie-store.test.ts tests/unit/ipc-contracts.test.ts` and verify they pass.**
- [ ] **Step 7: Commit**

```powershell
git add shared electron tests
git commit -m "feat: add secure ipc and cookie storage"
```

### Task 3: Recursive Scanner and Tag Service

**Files:**
- Create: `electron/services/library-scanner.ts`
- Create: `electron/services/tag-service.ts`
- Create: `electron/services/audio-format.ts`
- Create: `tests/unit/library-scanner.test.ts`
- Create: `tests/unit/tag-service.test.ts`
- Create: `tests/fixtures/README.md`
- Modify: `electron/ipc/register-ipc.ts`

**Interfaces:**
- `scanDirectory(root: string, onItem: (item: LibraryItem) => void): Promise<ScanSummary>`
- `readAudioMetadata(path: string): Promise<AudioMetadata>`
- `writeAudioMetadata(path: string, patch: MetadataPatch): Promise<WriteResult>`
- `isSupportedAudioPath(path: string): boolean`
- `isSuspectedWholeTrack(durationMs: number, hasCue: boolean): boolean`

- [ ] **Step 1: Write failing scanner tests for recursion, case-insensitive extensions, CUE association, missing references, and the 15-minute heuristic.**
- [ ] **Step 2: Run `npm test -- tests/unit/library-scanner.test.ts` and verify failure.**
- [ ] **Step 3: Implement deterministic path walking with `fs.promises.readdir({ withFileTypes: true })`, supported-extension filtering, CUE `FILE` path resolution, and per-item error capture.**
- [ ] **Step 4: Implement the 15-minute status and the `overridden` state without using file size as a hard condition.**
- [ ] **Step 5: Write failing TagLib tests using a checked-in fixture or generated fixture covering common fields and cover extraction.**
- [ ] **Step 6: Implement TagLib mapping for MP3, FLAC/OGG/OPUS/WV, M4A/MP4, WAV, and APE capabilities; reject unsupported fields explicitly.**
- [ ] **Step 7: After writes, reread metadata and return the verified result. Do not create audio backups.**
- [ ] **Step 8: Run both unit suites and commit**

```powershell
git add electron tests
git commit -m "feat: scan library and read write audio tags"
```

### Task 4: CUE Parsing, Encoding, Editing, and Candidate Serialization

**Files:**
- Create: `electron/services/cue-service.ts`
- Create: `electron/services/cue-encoding.ts`
- Create: `electron/services/cue-candidate.ts`
- Create: `shared/cue-time.ts`
- Create: `tests/unit/cue-service.test.ts`
- Create: `tests/unit/cue-encoding.test.ts`
- Create: `tests/unit/cue-candidate.test.ts`
- Modify: `electron/ipc/register-ipc.ts`

**Interfaces:**
- `readCue(path: string): Promise<CueDocumentState>`
- `parseCue(rawText: string, filePath: string): CueDocumentState`
- `serializeCue(document: CueDocument, encoding: CueEncoding): Buffer`
- `saveCue(input: SaveCueInput): Promise<SaveCueResult>`
- `buildCandidateCue(input: CandidateCueInput): CueDocument`
- `framesToCueTime(frames: number): string`

- [ ] **Step 1: Write failing tests for `cue-parser` integration, UTF-8/GBK detection, UTF-8 BOM serialization, `.bak` creation, and offset conversion.**
- [ ] **Step 2: Run the CUE unit suite and verify failure.**
- [ ] **Step 3: Wrap `cue-parser`'s `parser.parse(filename)` result in the shared `CueDocument` model; preserve raw text, comments, and unknown lines alongside structured values.**
- [ ] **Step 4: Implement encoding detection for UTF-8/BOM, GB18030/GBK, Big5, and Shift-JIS using `chardet` plus `iconv-lite`; expose uncertain candidates.**
- [ ] **Step 5: Implement `framesToCueTime` with 75 frames/second and validation of `INDEX 01` monotonicity.**
- [ ] **Step 6: Implement candidate CUE serialization with local `FILE`, `TRACK`, `TITLE`, `PERFORMER`, date metadata, and MusicBrainz offsets relative to the first track.**
- [ ] **Step 7: Implement atomic CUE save; when replacing an existing file, copy it to `<path>.bak` before writing. On failure leave the original untouched.**
- [ ] **Step 8: Run `npm test -- tests/unit/cue-service.test.ts tests/unit/cue-encoding.test.ts tests/unit/cue-candidate.test.ts` and commit**

```powershell
git add electron shared tests
git commit -m "feat: parse edit and generate cue sheets"
```

### Task 5: Metadata Adapters and Provider Cookies

**Files:**
- Create: `electron/services/metadata/adapter.ts`
- Create: `electron/services/metadata/musicbrainz-adapter.ts`
- Create: `electron/services/metadata/ctdb-adapter.ts`
- Create: `electron/services/metadata/netease-adapter.ts`
- Create: `electron/services/metadata/qqmusic-adapter.ts`
- Create: `electron/services/metadata/http-client.ts`
- Create: `tests/unit/metadata-adapters.test.ts`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `electron/ipc/register-ipc.ts`

**Interfaces:**
- `search(query: string): Promise<MetadataCandidate[]>`
- `getDetails(id: string): Promise<MetadataCandidate>`
- `getCover(candidate: MetadataCandidate): Promise<CoverArt | undefined>`
- `scoreCandidate(local: LocalMatchContext, candidate: MetadataCandidate): MatchScore`

- [ ] **Step 1: Write fixture-based failing tests for MusicBrainz JSON mapping, Cover Art Archive URLs, CTDB no-match handling, NetEase mapping, QQ mapping, and Cookie injection.**
- [ ] **Step 2: Run `npm test -- tests/unit/metadata-adapters.test.ts` and verify failure.**
- [ ] **Step 3: Implement a main-process HTTP client with timeout, cancellation, redacted diagnostics, provider rate limits, and optional session cache.**
- [ ] **Step 4: Implement MusicBrainz release search/details with a meaningful User-Agent, no login, release media/discids/recordings includes, and Cover Art Archive lookup.**
- [ ] **Step 5: Implement CTDB as an optional verification adapter; return a non-blocking no-match/error result.**
- [ ] **Step 6: Extract only search and detail/cover logic from the specified NetEase and QQ upstream projects, preserve attribution, and inject decrypted provider Cookies in the request client.**
- [ ] **Step 7: Implement candidate scoring using title/artist similarity, track count, total/per-track duration, Disc ID/TOC, and CTDB verification.**
- [ ] **Step 8: Run adapter tests and commit**

```powershell
git add electron tests THIRD_PARTY_NOTICES.md
git commit -m "feat: add metadata providers and cookie requests"
```

### Task 6: Three-Pane React UI and Editing Workflows

**Files:**
- Create: `src/components/DirectoryTree.tsx`
- Create: `src/components/LibraryList.tsx`
- Create: `src/components/MetadataPanel.tsx`
- Create: `src/components/CueEditor.tsx`
- Create: `src/components/MetadataCandidates.tsx`
- Create: `src/components/SettingsPanel.tsx`
- Create: `src/stores/library-store.ts`
- Create: `src/stores/editor-store.ts`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Create: `tests/ui/library-workflow.test.tsx`

**Interfaces:**
- Renderer consumes only `window.musicId3` methods from Task 2.
- `library-store` exposes `selectRoot`, `appendScanItem`, `selectItem`, `setWholeTrackOverride`, and `refreshItem`.
- `editor-store` exposes `setFieldSelected`, `previewDiff`, `confirmAudioWrite`, `saveCueDraft`, and `searchCandidates`.

- [ ] **Step 1: Write failing UI tests for three-pane rendering, file selection, suspected whole-track guidance, field selection, diff preview, and CUE save confirmation.**
- [ ] **Step 2: Run `npm test -- tests/ui/library-workflow.test.tsx` and verify failure.**
- [ ] **Step 3: Implement the three-pane layout: directory tree left, file list center, details right; keep stable dimensions for toolbars, list rows, icon buttons, and cover preview.**
- [ ] **Step 4: Implement progressive scan updates, filters, format/duration/size/status columns, errors, and missing CUE reference states.**
- [ ] **Step 5: Implement common-tag editor, raw-tag view, cover preview/replace/remove, unsupported-field states, and explicit clear confirmation.**
- [ ] **Step 6: Implement CUE structured/raw modes, encoding selector, validation messages, candidate source/confidence banner, and `.bak` save confirmation.**
- [ ] **Step 7: Implement provider selector, Cookie settings/test/clear controls, candidate list, cover preview, old/new diff, field checkboxes, and final write confirmation.**
- [ ] **Step 8: Run UI tests, manually exercise keyboard navigation and Chinese paths, then commit**

```powershell
git add src tests
git commit -m "feat: add music library editing interface"
```

### Task 7: End-to-End Verification and Failure Handling

**Files:**
- Create: `tests/e2e/library.spec.ts`
- Create: `tests/e2e/cue.spec.ts`
- Create: `tests/e2e/metadata.spec.ts`
- Create: `tests/fixtures/library/`
- Create: `playwright.config.ts`
- Modify: `electron/services/*` only for defects found by tests

**Interfaces:**
- E2E tests launch the packaged/dev Electron app with a fixture directory and mocked provider HTTP responses.

- [ ] **Step 1: Build fixture directories containing supported formats, mixed-case extensions, CUE with missing `FILE`, a valid CUE, and an unassociated audio item over 15 minutes.**
- [ ] **Step 2: Write failing E2E tests for directory selection, progressive scan, metadata details, suspected whole-track override, CUE editing/backup, and provider candidate confirmation.**
- [ ] **Step 3: Run `npm run test:e2e` and verify failures identify missing workflows.**
- [ ] **Step 4: Wire stable test hooks (`data-testid`) without exposing secrets or changing user-facing layout.**
- [ ] **Step 5: Fix defects found by the E2E suite, including Windows path normalization and renderer/main error propagation.**
- [ ] **Step 6: Run unit, UI, and E2E suites together and commit**

```powershell
git add tests electron src
git commit -m "test: verify desktop music workflows"
```

### Task 8: Windows Packaging, CI, and User Documentation

**Files:**
- Modify: `package.json`
- Create: `electron-builder.yml`
- Create: `.github/workflows/windows.yml`
- Create: `README.md`
- Create: `LICENSE`
- Modify: `THIRD_PARTY_NOTICES.md`
- Create: `docs/operations/provider-cookies.md`

**Interfaces:**
- Produces `npm run package:win` with NSIS and portable artifacts in `release/`.
- CI runs lint/typecheck/unit/UI/E2E tests on `windows-latest` and uploads installer artifacts.

- [ ] **Step 1: Write a packaging smoke test that asserts `electron-builder.yml` declares NSIS and portable targets and includes native module rebuild.**
- [ ] **Step 2: Run the smoke test and verify failure before packaging config exists.**
- [ ] **Step 3: Configure electron-builder application ID, Windows targets, unpacked native module handling, and portable output.**
- [ ] **Step 4: Add Windows CI steps for clean install, typecheck, test, E2E, and package artifact upload.**
- [ ] **Step 5: Document directory scanning, tag/CUE backup behavior, provider Cookies, rate limits, unofficial API caveats, privacy, and third-party licenses.**
- [ ] **Step 6: Run `npm run build`, `npm test`, `npm run test:e2e`, and `npm run package:win`; verify installer and portable builds launch.**
- [ ] **Step 7: Commit**

```powershell
git add package.json electron-builder.yml .github README.md LICENSE THIRD_PARTY_NOTICES.md docs
git commit -m "build: package windows app and document providers"
```

## Plan Self-Review

- Spec coverage: scanning and association are covered by Task 3; tags by Task 3; CUE and encoding by Task 4; MusicBrainz/CTDB/NetEase/QQ and Cookies by Task 5; UI by Task 6; failure behavior and Windows paths by Task 7; packaging/open-source notices by Task 8.
- Placeholder scan: no `TODO`, `TBD`, or unspecified implementation step is used.
- Type consistency: shared types and IPC signatures are introduced in Task 2 and consumed by later tasks; provider and CUE interfaces are defined before renderer use.
- Scope: tasks are ordered so each produces a testable increment and later tasks depend only on explicit contracts from earlier tasks.
