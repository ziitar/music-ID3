# Repository Guidelines

## Project Structure & Module Organization

Renderer code lives in `src/`: UI is under `src/components/`, state stores are under `src/stores/`, and global styling is in `src/styles.css`. Electron entry points and privileged filesystem/network logic live in `electron/`; keep IPC registration in `electron/ipc/` and domain logic in `electron/services/`. Cross-process types and IPC contracts belong in `shared/`.

Tests are grouped under `tests/unit/`, `tests/ui/`, `tests/e2e/`, and `tests/smoke/`; sample data belongs in `tests/fixtures/`. Operational documentation lives in `docs/operations/`. Treat `dist/`, `release/`, and `test-results/` as generated output.

## Build, Test, and Development Commands

Use Node.js 22.12 or newer. Windows is required for packaging and Electron E2E verification.

- `npm ci` installs locked dependencies.
- `npm run dev` starts Vite, TypeScript watch mode, and Electron.
- `npm run typecheck` checks all TypeScript projects.
- `npm run build` builds renderer and main-process output.
- `npm test` runs Vitest unit, UI, and smoke tests once.
- `npm run test:e2e` runs Playwright Electron workflows serially.
- `npm run package:win` builds installer and portable executables in `release/`.

## Coding Style & Naming Conventions

Follow strict TypeScript style: two-space indentation, double quotes, semicolons, and explicit exported types at process boundaries. Use `PascalCase` for components and types, `camelCase` for functions and variables, and kebab-case service/store filenames such as `library-scanner.ts`. Keep privileged operations out of the renderer and expose them through typed IPC. No formatter or lint command is configured; match nearby code and run `npm run typecheck`.

## Testing Guidelines

Use Vitest for `*.test.ts`/`*.test.tsx` and Playwright for `tests/e2e/*.spec.ts`. Add regression coverage beside the affected layer and use fixtures instead of live provider calls. There is no numeric coverage threshold, but test new behavior and failure paths. Run `npm test` and relevant E2E tests before submitting.

## Commit & Pull Request Guidelines

History follows Conventional Commits such as `feat:`, `fix(cue):`, `test:`, and `build:`. Keep subjects imperative and limited to one logical change. Pull requests should explain user-visible behavior, identify file/provider risks, link issues, and include screenshots for UI changes. Confirm Windows CI passes type-check, build, Vitest, Playwright, and packaging.

## Security & Data Safety

Never commit provider cookies, credentials, personal music, or generated packages. Preserve Electron process isolation: cookies and filesystem writes must remain in the main process. Changes to tag or CUE writes must retain confirmation, validation, backup, and rollback protections.
