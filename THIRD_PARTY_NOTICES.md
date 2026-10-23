# Third-party notices

hex-memo depends on the following third-party components.

| Component | Used by | License |
|---|---|---|
| Electron 33 (fetched by `npm install`; the only dependency of the desktop version, not included in this repository) | hex-memo desktop version | MIT, Copyright (c) Electron contributors / GitHub Inc. (Electron bundles Chromium and Node.js under their own licenses) |
| Playwright and ffmpeg (optional; only used by `npm run demo:*` to record demo videos, not bundled, install them yourself) | `scripts/demo/` | Apache-2.0 (Playwright) / LGPL-2.1 or later, or GPL depending on the build (ffmpeg) |

The web version (`npm run build:web`, output in `dist-web/`) is assembled from this repository's own files only.
The full license texts are available from each project (for Electron, `node_modules/electron/LICENSE` after `npm install`).
