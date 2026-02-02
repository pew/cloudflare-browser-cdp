# Changelog

## 2026-02-02

Initial AGENTS.md setup and security hardening session.

### Code/File Changes
- Created `AGENTS.md` with build commands, code style guidelines, and CDP implementation notes
- Added `scripts/test-browser.js` for testing remote browser connections
- Converted `scripts/cdp-client.js` from CommonJS to ESM (project uses `"type": "module"`)

### Security
- Modified info endpoint (`GET /`) to only expose `supported_methods` when authenticated via `?secret=`

### Tooling/Environment
- `ws` package required as dependency for running client scripts (`npm install ws`)
