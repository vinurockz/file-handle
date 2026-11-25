# CLAUDE.md

Guidance for Claude Code in this repository. Studio is a multi-module productivity suite:
**Angular 22** client, **Node 24** API, **SQLite**. If a version here disagrees with a
`package.json`, trust `package.json` and fix this file.

## Commands (run from the repo root)

| Task | Command |
| --- | --- |
| Install everything | `npm run setup` |
| Develop (API on :3000, app on http://localhost:4200) | `npm run dev` |
| Type-check client and server | `npm run typecheck` |
| Unit and API tests | `npm test` |
| Build, then browser tests in installed Chrome | `npm run e2e` |
| Everything above, in order | `npm run verify` |
| Production build / serve it on :3000 | `npm run build` then `npm start` |
| Format | `npm run format` |

Inside `client/`: `npm run test:watch`, `npx ng generate component features/x/name`.

**Definition of done:** `npm run verify` passes, new logic has a test, and every bug fix has a
regression test. Report anything you could not verify.

## Layout

```
client/src/app/
  core/       api, auth, collection (autosave), history (undo), project, media, ui, util
  shared/     widgets (Slider, Modal), overlays (toasts, dialogs, media picker), context-menu,
              band + band-panel (text strips), rich-text, blocks-editor
  shell/      sidebar layout; provides the app-wide ChatStore
  features/<module>/   one folder per module; pure logic in its own .ts files
  modules.ts  the module list: navigation and lazy routes come from here
server/src/   app.ts wires routers; auth, google, docs, schemas, media, files, chat(-hub), video(-args), proxy, tools
server/test/  node:test API and FFmpeg integration tests
e2e/tests/    Playwright flows against the production build
```

## Angular 22 rules

- **Zoneless, OnPush by default.** State the template reads must be a **signal**. A plain field
  mutated in a timer, socket or promise callback will not re-render. Never add zone.js or
  `ChangeDetectionStrategy.Eager`.
- Standalone components only; list dependencies in `imports`. No NgModules.
- `input()`, `input.required()`, `output()`, `model()`, `viewChild()`. No `@Input`/`@Output` decorators.
- `computed()` for anything derived. `effect()` only to sync with the outside world (canvas, DOM,
  media elements, autosave). Wrap writes and unrelated reads in `untracked()`.
- Templates use `@if`, `@for` (always `track` a stable id), `@switch`, `@let`, `@defer`.
  Not `*ngIf`/`*ngFor`.
- Templates cannot use computed object keys (`{ [key]: v }`) or call imported functions or globals.
  Expose them as component members.
- `inject()` instead of constructor parameters. Host bindings go in the `host` object.
- `protected` for template-only members, `readonly` for signals and injected services.
- Register cleanup with `inject(DestroyRef).onDestroy`: timers, sockets, object URLs, media
  elements, animation frames.
- Lazy-load every module. Import heavy libraries (`pdf-lib`, `pdfjs-dist`, `jszip`) only from
  lazy features or with `await import()`. Keep within the budgets in `angular.json`.
- Route query parameters arrive as component inputs (`withComponentInputBinding`).
- Strict TypeScript and strict templates. No `any` in app code (`$any()` is acceptable for a
  template event target), no `@ts-ignore`.

## Patterns to reuse (do not reinvent)

- **Saved documents:** `injectCollection<T>('name')`. `patch()` updates immediately and saves
  debounced, in order, with retry. Never call `Api.put` on `/docs` directly. Add a collection in
  `server/src/schemas.ts` with a zod schema; no new route is needed.
- **Partial updates:** the server validates `{...existing, ...patch}`. Keep that: parsing a bare
  patch would let schema defaults wipe fields.
- **Undo/redo:** `History<T>` with immutable snapshots. Drags use `preview()` while moving and
  `commitPreview()` on release. Pass a key to `commit()` to merge slider ticks and typing.
  After undo/redo, persist the new value.
- **Resumable editor work:** `ProjectSaver` (PDF, image, video).
- **Pointer gestures:** `trackPointer()`. **Dialogs:** `Ui.confirm`, `Ui.prompt`, `Ui.pickMedia`.
  **Right-click menus:** `Ui.openMenu`, always with a visible ⋮ button as well.
- **Text strips** (image sections, movie title bars): `Band`, `drawBand`, `app-band-panel`.
  Never `window.alert/confirm/prompt`.
- **Files:** everything goes through `MediaLibrary`; reference files by media id, build URLs with `mediaUrl()`.
- **After an `await`,** re-check that the user is still on the same document before writing to it,
  and capture ids before opening a picker or dialog.
- Editing never modifies source files; exports create new ones.
- Geometry, timelines and money live in pure functions with unit tests, not in components.

## Module invariants

- **PDF:** positions are 0-1 fractions of the **unrotated** page. Convert with `geometry.ts` only.
  Redaction must rasterize the page; whiteout only covers.
- **Image:** layer positions are pixels in the cropped photo area. Crop and rotate are metadata.
- **Video:** `video-args.ts` is the only place FFmpeg arguments are built, from zod-validated
  values, spawned without a shell. If you change `toSpec` (client), change the schema (server) and
  the export test with it.
- **Website:** `blocks.ts` renders canvas, preview and export. Escape every user string, pass URLs
  through `safeUrl` and colors through `safeColor`. The canvas iframe stays
  `sandbox="allow-same-origin"` with **no** `allow-scripts`. New block = one entry in `BLOCKS`.
  Media values are library ids or https addresses; render them through `source()`. Drag logic is in
  `drag.ts`; tabs keep nested blocks aligned with `syncTabs`. Canvas elements belong to the frame's
  document, so do not test them with `instanceof`.
- **Schema changes:** add new columns in `Db.migrate()`, never by editing a `CREATE TABLE` that
  existing databases already ran. Old saved documents lack new fields: default with `??`.
- **Chat:** HTTP is the only way to change data; the WebSocket only pushes. Check membership on
  every route and return 404 to non-members. Drafts and uploads are tied to a conversation id.

## Server rules

- Node runs the TypeScript directly: erasable syntax only (no enums, namespaces or parameter
  properties), and relative imports end in `.ts`.
- Validate all input with zod. Scope every workspace query with `workspaceOf(req)`.
- Detect uploaded file types from content (`sniff`), serve them through `FileStore.send`.
- Writes require the `X-Requested-With: studio` header and a SameSite cookie. Do not add CORS to
  authenticated routes.
- Public mock endpoints must keep `Content-Security-Policy: sandbox`.
- Outbound requests go through `proxy.ts` (SSRF checks). Never `fetch` a user-supplied URL directly.

## Security and accessibility

- Rich text is sanitized with `cleanHtml`. Never bypass Angular sanitizing for user content; the
  only bypass is for the website editor's script-free sandboxed frames.
- No secrets or tokens in `localStorage` or client code.
- Semantic controls, an accessible name on every icon button, visible focus, keyboard access,
  mobile layout checked, `prefers-reduced-motion` respected.
- Use the classes and CSS variables in `styles.scss`; keep component styles small.

## Gotchas

- Chrome records nothing while an added audio track is silent with no source; `recordMovie` feeds a
  silent `ConstantSourceNode`. Do not remove it.
- CDK reports a drop after its animation, so tests wait for the save request before reloading.
- Playwright's `dragTo` cannot start a drag inside the script-free canvas frame, and its frame
  automation can log "Blocked script execution". Use `nativeDrag`/`nativeDragPoints`; keep the
  "real click and drag work without any errors" test free of any filtering.
- `Modal` stops key events from reaching the page. Use its `(keyed)` output.
- `execCommand` (rich text) is deprecated but intentional: no editor dependency.
- Production CSP is set in `server/src/app.ts`. Critical-CSS inlining is off because it needs inline script.
