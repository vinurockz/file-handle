# Studio

A multi-module productivity suite. Angular 22 front end, Node.js back end, SQLite database.
Everything runs on your own machine; there is no database server to install.

## Run it

Needs Node.js 24.15 or newer.

```bash
npm run setup     # install dependencies (downloads FFmpeg for video work)
npm run dev       # open http://localhost:4200
```

For a production-style run:

```bash
npm run build
npm start         # open http://127.0.0.1:3000
```

Create an account, then a workspace. To try chat, create a second account in another browser or a
private window.

## Modules

| Module | What it does |
| --- | --- |
| Files | Folders with cover pictures and colors, right-click menus, upload and drag-drop, search, type and color filters, grid/list, move (also into a new folder), ZIP download per folder, ZIP import and backup, viewer with slideshow, full screen and picture-in-picture |
| PDF Editor | Highlight, underline, strikeout, pen, marker, shapes, arrows, text, comments, stamps, images, signatures, whiteout, true redaction, snapshot, find text, form filling, watermark, page numbers; rotate, reorder, add, delete, merge, extract and split pages; blank PDF and pictures to PDF; browse the same folders as Files |
| Image Editor | Canvas presets, text, captions, speech bubbles, stickers, shapes, picture layers, brush and eraser, eyedropper, lasso and magic wand (cut out as a layer or save as a new picture), filters and adjustments, crop, rotate, flip, layer order/lock/hide, blend modes, shadows, frames, photo border and opacity, six text sections (header, sub-header, sides, caption, footer), draft/done history, PNG/JPG/WebP export |
| Video Editor | Trim, split, merge, reorder, speed, volume, mute, rotate, flip, crop, brightness, contrast, saturation, hue, grayscale, sepia, invert, blur, pixelate, vignette, top/bottom text, timed captions and stickers, background music, fades, draft/done history; export MP4, WebM, GIF or MP3; save a frame |
| Website Editor | Multiple pages (drag to reorder, double-click to rename), 25 block types, drag blocks onto and around the canvas, columns and tabs that hold other blocks, per-block design, library or web-address pictures, custom HTML/CSS (also loaded from files), favicon, templates, device preview, export as a static website ZIP |
| Chat | Direct and group chats between accounts, live messages, typing, online status, read receipts, edit, delete, reply, reactions, pictures, video, files, voice messages, group picture and description, search, PDF and text export, unread badge |
| Text Chat | Turn pasted text into editable bubbles; text sizes, highlight, copy, attach media, reorder, combine, export |
| Notes | Rich text, checklists, media, links, colors, labels, pin, archive, search |
| Tasks | Board with drag-drop, sections, priority, due dates, started/completed status, card pictures |
| Movies | Scenes with positioned media, animations, transitions, speech bubbles (pin, duplicate), styled title bars, replace or edit a picture in place, music, WebM/MP4 export |
| Slideshows | Build a show from files or a folder, then fine-tune it in the movie workspace |
| Books | Pages with text, images and shapes, drag-to-crop, reader with page turn, PDF export through printing |
| Bills | Bills and quotations with totals, tax, discount, logo, signature, print/PDF and PNG |
| API Tester | Send requests, inspect responses, copy headers, history (clearable) and saved requests |
| Custom APIs | Your own public mock endpoints, with "Try it" |
| Reports | Storage and activity totals with CSV export |

Each customer **workspace** has a name, description and photo, and keeps its own files and projects. Chat belongs to your account.
Editor work saves automatically and can be resumed; exports never change the original file.

## Differences from the React reference

- Chat uses real accounts. The reference let one person switch between made-up chat users.
- Bills save automatically instead of with a Save button.
- The single "Edit" module is split into Image Editor and Video Editor.
- Video export is done by FFmpeg on the server, not by recording in the browser.
- Chat PDF export is made of page pictures, so every language prints correctly but the text cannot be selected.

## Tests

```bash
npm run typecheck
npm test          # server API + FFmpeg tests, client unit tests
npm run e2e       # builds, then drives the app in your installed Google Chrome
```

Set `E2E_CHANNEL=msedge` to test in Microsoft Edge.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Where the server listens |
| `DATA_DIR` | `server/data` | Database and uploaded files. **Back this folder up.** |
| `MAX_UPLOAD_MB` | `500` | Largest upload |
| `ALLOWED_ORIGINS` | the dev server | Extra origins allowed to open the chat connection |
| `ALLOW_PRIVATE_TARGETS` | on only when `HOST` is local | Lets the API Tester call local and LAN addresses |
| `SECURE_COOKIES` | off | Set to `1` when served over HTTPS |
| `FFMPEG_PATH` | bundled | Use another FFmpeg |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | not set | Turn on "Continue with Google" (create an OAuth client in Google Cloud Console) |
| `GOOGLE_REDIRECT_URI` | `http://localhost:PORT/api/auth/google/callback` | Must match the one registered with Google. With `npm run dev`, use port 4200 |

## Before sharing it with other people

By default the server is reachable only from this computer. To let others use it:

- Put it behind an HTTPS reverse proxy and set `SECURE_COOKIES=1`. The microphone, clipboard and
  some browser features require HTTPS on other devices.
- Anyone who can reach the server can **create an account** and find other users by name.
- Keep `ALLOW_PRIVATE_TARGETS` off, or the API Tester can reach your internal network.
- Enabled Custom API endpoints are public by design.
- There is no password reset, email, or storage quota.

## Known limits

- Movies and slideshows are recorded in real time; keep the tab visible while exporting.
- The video preview is a close approximation. The exported file is rendered by FFmpeg.
- PDF text cannot be rewritten in place: cover it with whiteout or redact it, then add new text.
  Password-protected PDFs cannot be edited. Scanned pages have no selectable text.
- Website contact forms open the visitor's email app, because exported sites have no server.
  Maps, embedded videos and custom scripts run in the exported site, not in the editor.
- Google Chrome is the tested browser.
- If two tabs edit the same document, the last save wins.
- Google sign-in is off until you add credentials, and has only been tested against a stand-in for Google.
- Data saved in the old React project is not imported.
- `ffmpeg-static` ships a GPL build of FFmpeg; check the license before redistributing.
