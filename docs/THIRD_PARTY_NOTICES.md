# Third-party components

This extension bundles Mozilla PDF.js **6.4.299** (modern generic distribution).

- Project: https://github.com/mozilla/pdf.js
- Official release: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299
- Download: https://github.com/mozilla/pdf.js/releases/download/v6.4.299/pdfjs-6.4.299-dist.zip
- Download SHA-256: `f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d`
- License: Apache License 2.0. Additional notices remain in the distributed files. [Bundled license](../pdfjs/LICENSE)

Modifications: `pdfjs/web/viewer.html` has a custom title and loads `src/pdf/reader-bootstrap.js` and `src/pdf/reader.css`. PDF.js JavaScript and worker files are unmodified. The startup configuration disables PDF-embedded JavaScript, optional alt-text model downloads, and optional WebGPU rendering, and enables PDF copy permissions.

Google Translate's no-key endpoint is an external service, not bundled code and not the supported Google Cloud Translation API. Availability and rate limits may change. With Google selected, the extension can send copied PDF text, a paragraph requested with Shift, or subtitle batches when automatic YouTube translation is enabled.
