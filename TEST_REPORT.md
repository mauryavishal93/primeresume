# Automated Test Report

**Last verified:** 2026-11-13

## Validation

| Check | Result | Command |
| --- | --- | --- |
| Automated regression suite | PASS | `npm test` |
| Production build | PASS | `npm run build` |

The project requires Node.js 22.x. Local verification may also be run on a newer Node.js version; the CI workflow uses Node.js 22.

The suite uses Node's built-in test runner and covers client behavior contracts, account and plan access, editor functionality, homepage and responsive navigation markup, backend routes, and Vercel configuration. Build the frontend before running tests because a public-share route integration test serves the generated editor page. These tests complement—not replace—browser checks across supported browsers and real mobile devices.
