# Final Whole-Branch Review Fix Report

Branch: `feature/music-library-desktop`

Reviewed baseline: `5b465d4 build: package windows app and document providers`

## Status

All 17 actionable findings from the final whole-branch review were addressed: 3 Critical, 9 Important, and 5 Minor. The implementation preserves the established Electron main/preload/renderer boundaries and keeps provider tests offline with local fixture servers and placeholder credentials.

## Finding dispositions

| # | Severity | Finding | Disposition |
| ---: | --- | --- | --- |
| 1 | Critical | Bind an audio confirmation to the diff the user reviewed. | Audio previews now receive an ownership token. Any field or selection change invalidates the displayed diff and token, confirmation recomputes and compares the current diff, and a token is consumed before the asynchronous write begins. Stale or repeated confirmations cannot write. |
| 2 | Critical | Make CUE confirmation single-use. | Every confirmation receives a non-empty token. The renderer consumes it synchronously, IPC validates it, and the CUE service memoizes the path/token result so duplicate delivery cannot perform a second save or replace the original `.bak`. |
| 3 | Critical | Preserve recovery material when backup publication and rollback both fail. | The CUE transaction no longer deletes the only temporary copy of the original after rollback failure. The failure identifies the retained recovery path while preserving any prior `.bak`. |
| 4 | Important | Authorize filesystem IPC beneath roots selected by the invoking renderer. | Main-process authorization is keyed by renderer identity, starts only after folder selection, canonicalizes existing paths, rejects traversal and junction escapes, validates audio/CUE extensions, permits a new CUE only under the selected root, scopes scan cancellation to the sender, and clears authority when the renderer is destroyed. |
| 5 | Important | Wire candidate scoring and CTDB validation into the application flow. | Renderer searches pass local structural context. Main-process search results are scored and reordered from title, artist, track count, duration, Disc ID, and TOC evidence. Detailed MusicBrainz candidates use CTDB validation when available; validation failure is nonblocking and exposes only a sanitized warning. |
| 6 | Important | Preserve generated-CUE trust provenance. | Generated documents carry source, release ID, Disc ID, evidence, confidence, and inferred status. The editor displays the provenance and adds a specific warning before saving an inferred low-confidence candidate. |
| 7 | Important | Keep MusicBrainz media distinct. | Each release medium is modeled as its own candidate with its matching tracks, offsets, Disc ID, format, duration, and stable synthetic candidate ID. Detail and cover lookups resolve the underlying release ID without flattening multiple discs together. |
| 8 | Important | Enforce the suspected whole-track write policy in both main and renderer. | Ordinary fields, cover operations, diff preview, and candidate writes remain disabled until main accepts a sender-owned override. Main records scan facts and rejects direct `writeAudio` calls for suspected files; facts and overrides are invalidated when the selected root changes. |
| 9 | Important | Preview uncertain CUE encodings from source bytes and reject lossy saves. | Selecting an encoding rereads and decodes the original bytes rather than relabeling already-decoded text. Legacy writes must round-trip exactly; unrepresentable text is rejected with guidance to use UTF-8 BOM. Generated CUE defaults to UTF-8 BOM. |
| 10 | Important | Normalize provider dates to the writable metadata contract. | A full provider date such as `2026-09-04` is converted to the supported year value `2026` before diff generation and writing. |
| 11 | Important | Complete common metadata, navigation, and filtering UI. | The editor exposes every common field, with numeric inputs for track/disc values; the directory pane represents recursive hierarchy; and the library supports text, kind, and status filtering plus missing-reference status. |
| 12 | Important | Derive the generated CUE `FILE` type from the audio container. | MP3 produces `MP3`; WAV and FLAC produce `WAVE`; containers without a standards-compatible mapping are rejected instead of emitting a misleading CUE. |
| 13 | Minor | Improve candidate query defaults. | Query text derives from the selected item's title/artist context and resets on item changes, while preserving explicit user edits for the active item. |
| 14 | Minor | Correct new-CUE backup messaging. | The confirmation explains that `.bak` is created only when replacing an existing CUE and does not promise a backup for a newly generated path. |
| 15 | Minor | Avoid lossy structured quote serialization. | Structured values containing a double quote are rejected with raw-mode guidance instead of silently changing `"` to `''`. |
| 16 | Minor | State the actual Node.js prerequisite. | `package.json`, root lockfile metadata, the smoke test, and README now consistently require Node.js `>=22.12.0`. |
| 17 | Minor | Close final desktop E2E gaps. | E2E now covers a legacy-encoded CUE on an actual Chinese path, offline NetEase and QQ search/detail/cover/apply flows, and encrypted Cookie configuration surviving an application restart. No live provider, secret, or real credential is used. |

## Behavioral RED evidence

The focused regressions were first observed failing against the reviewed baseline. The failures established these behaviors rather than merely increasing line coverage:

- A changed draft could retain an earlier displayed diff, and repeated audio confirmation could enter the write path more than once.
- Rapid CUE confirmation could invoke two saves, allowing the second invocation to replace the useful original backup.
- When backup publication and rollback both failed, cleanup removed the only recovery copy and the error did not identify a recoverable path.
- A renderer could invoke path-bearing IPC without selecting the root, another renderer could reuse a selected root, and canonical junction escapes were not rejected.
- Search results retained adapter order, local match context did not reach IPC, and MusicBrainz details did not invoke CTDB validation.
- Candidate generation dropped trust provenance, so the UI could not explain low-confidence or inferred input before saving.
- Multi-disc MusicBrainz releases were flattened, mixing tracks and disc evidence across media.
- Suspected whole-track audio still exposed cover/diff mutation paths and direct main-process writes had no authoritative override check.
- Clicking an uncertain encoding did not reread the original CUE bytes, and legacy encoding silently substituted characters it could not represent.
- A full release date reached a year-only write contract unchanged and was rejected downstream.
- Common numeric metadata, recursive directory navigation, and library filtering/status workflows were absent.
- Generated CUE documents labeled every audio file `WAVE`, including MP3 and unsupported containers.
- Candidate queries did not consistently follow selection context; new-CUE confirmation promised a nonexistent `.bak`; structured quotes were rewritten; the minimum Node version was understated; and the final real-process E2E paths were missing.

## Additional implementation findings

While closing the offline provider E2E coverage, Electron request construction was corrected to use `RequestInit.referrer` rather than manually setting `Referer`; forbidden QQ `Host` headers were removed. The local fixture transport asserts the resulting referrer and header behavior. The Electron API choice was checked against current documentation through Context7 (`/electron/electron`).

Self-review then exposed a React Strict Mode lifecycle regression in `CueEditor`. The focused test was rendered under `<StrictMode>` and failed because the explicitly re-decoded value `正确预览` never appeared. Strict Mode's setup-cleanup-setup replay left `mounted.current` permanently false. After restoring `mounted.current = true` in effect setup, the same focused test passed. The final full UI suite retains the Strict Mode wrapper so this regression remains covered.

## Final verification

Fresh verification after the Strict Mode correction:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0. |
| `npm test` | Exit 0; 14 files and 215/215 tests passed. |
| `npm run test:e2e` | Exit 0; 13/13 Electron tests passed in 39.9 seconds. |
| `npm test -- tests/smoke/packaging.test.ts` | Exit 0; 2/2 tests passed. |
| `npm run build` | Exit 0; 24 modules built. |
| `git diff --check` | Exit 0; only expected Git LF/CRLF working-copy notices were emitted. |

Repository scans found no TODO markers, debug logging, or real credentials in the final change set. `npm install --package-lock-only --ignore-scripts` completed and reported two existing moderate dependency-audit findings.

`npm run package:win` was intentionally not rerun because packaging configuration and native dependency inclusion did not change. Task 8 already records successful NSIS and portable x64 builds, unpacked `node-taglib-sharp`, and launch checks for both artifacts.

## Preserved rulings and remaining concerns

- WavPack remains discoverable by the scanner, but metadata and duration read/write are explicitly unsupported because `node-taglib-sharp@6.0.3` has no WavPack registration. No second metadata engine was introduced.
- Raw tags remain read-only. Approved writes continue through the common metadata model; arbitrary frame/atom mutation remains outside the v1 contract.
- The packaging smoke test still does not assert release-directory and artifact-name templates. This remains deferred because CI already fails when expected artifacts are absent and Task 8 records the exact successfully launched outputs.
- The dependency audit still reports two moderate findings.
- Windows artifacts remain unsigned and use electron-builder's default application icon.
