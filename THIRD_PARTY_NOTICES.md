# Third-party components

This extension bundles Mozilla PDF.js **6.4.299** (modern generic distribution).

- Project: https://github.com/mozilla/pdf.js
- Official release: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299
- Download: https://github.com/mozilla/pdf.js/releases/download/v6.4.299/pdfjs-6.4.299-dist.zip
- Download SHA-256: `f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d`
- License: Apache License 2.0, reproduced in `pdfjs/LICENSE`. Additional notices remain in the distributed files.

Modifications: `pdfjs/web/viewer.html` has a custom title and loads the extension's `reader-bootstrap.js` and `reader.css`. PDF.js JavaScript and worker files are unmodified. Extension integration is kept outside `pdfjs/`. The startup configuration disables PDF-embedded JavaScript, optional alt-text model downloads, and optional WebGPU rendering, and enables PDF copy permissions.

Google Translate's no-key endpoint is an external service, not bundled code and not the supported Google Cloud Translation API. Availability and rate limits may change. The extension clearly labels this option and sends text only after the user enables copy translation.
