# ResumeOut.com Test Report

**Date:** 2026-10-15
**Overall result:** Not ready for a general production release. Core desktop and tested mobile workflows pass, but there is no repeatable automated regression suite or server-backed resume persistence.

## Environment

- macOS, Node.js 25.3.0, npm 11.7.0
- Vite 7.3.7 and Express 5.1.x
- Chromium-based integrated browser for UI tests
- `pdftotext` and `pdfinfo` for PDF inspection
- UI tests used an isolated local origin to avoid changing the user's saved resume

## Results

| Area | Result | Executed checks |
| --- | --- | --- |
| Production build | PASS | `npm run build` completed successfully. |
| Dependency audit | PASS | `npm audit --audit-level=moderate` reported zero vulnerabilities. |
| Source diagnostics | PASS | No errors reported for active frontend, backend, package, or Vite files. |
| Backend routes | PASS | `/`, `/editor.html`, `/api/health`, built JS/CSS assets returned 200; unknown route returned 404. |
| About page | PASS | `/about.html` serves product/privacy details and all three developer/company contact links; layout checked at 320, 390, and 1280px; navigation to and from the editor works. |
| Starter profile and links | PASS | Name, email, and LinkedIn render correctly; email and website links use `mailto:` and `https:`. Unsafe `javascript:` website input was not linked. |
| Template selection | PASS | All 17 templates could be selected. |
| PDF export by template | PASS | PDF generation completed for all 17 templates. |
| PDF text and links | PASS | An actual exported four-page A4 PDF yielded 130 expected text lines via `pdftotext`; both email and website URI annotations were present. |
| Layout and editor modes | PASS | Single/two-column layout, structured/free-position modes, zoom in/out, and multi-page pagination were exercised. A long imported resume rendered across four pages. |
| Profile/design controls | PASS | Profile edits, undo, font, accent color, body size, margins, header alignment, photo alignment, and page-number toggle were exercised. |
| Sections | PASS | Add/edit/hide/show/duplicate/delete, custom sections, entry add/remove, and drag reorder were exercised. |
| Profile photo | PASS | Image upload/render, alignment, removal, non-image rejection, and the 8 MB size limit were exercised. |
| JSON and autosave | PASS | JSON export produced parseable project data; valid import succeeded; malformed JSON was rejected; autosave persisted after its debounce interval. |
| Panels and keyboard | PASS | Desktop collapse/expand, width controls, drag resizing, Escape modal dismissal, and keyboard undo were exercised. On mobile, both panels expand to the available width and collapse to 36px rails. |
| Print styling | PASS | Print media hides editor chrome and preserves A4 sheet sizing. The browser's native print dialog was not invoked. |
| Desktop viewport | PASS | Layout checked at 768px and 1280px widths. |
| Responsive viewport | PASS | Logo and all top-bar actions fit at 320, 360, 390, 430, 520, 521, 768, and 1280px without document-level horizontal overflow. At 320/390/768px, left and right panels occupy the top row, collapse to 36px rails at opposite edges, and reopen; the full-width preview/zoom row sits below. Zoom changes 100% to 105% and back. |

## Release Blockers And Caveats

1. Add an automated test command and CI coverage. The project currently has no `test` script; browser checks in this report were manual/integrated-browser runs.
2. The backend serves static files and a health endpoint only. Resume data is stored in browser `localStorage`, not on a server; this is not cross-device or account-backed persistence.
3. Cross-browser testing, real mobile devices/touch, deployed hosting, and the native print dialog were not tested.
4. Root-level legacy files (`resume-studio-working-model-v2.html` and `src/main.js`) are outside the configured Vite frontend root and are not part of the production build. Remove or archive them before distribution to avoid source ambiguity.

## Readiness Assessment

The previously clipped mobile action has been fixed and responsive browser checks now pass at widths down to 320px. The app remains suitable for a controlled browser-only pilot, but not a general production release until automated regression coverage, persistence expectations, and the target-browser matrix are addressed.