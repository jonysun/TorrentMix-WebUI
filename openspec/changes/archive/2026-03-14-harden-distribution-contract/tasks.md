## 1. Release Producer Hardening

- [x] 1.1 Refactor `scripts/release/build-publish.mjs` so the release-contract generation logic can be exercised by automated tests without changing the external artifact layout.
- [x] 1.2 Enforce and document the required `latest.json` and `manifest.json` invariants, including relative release paths, entry records, and checksum/integrity fields.
- [x] 1.3 Add a smoke test that `pnpm build:publish` emits the canonical top-level and versioned file set for the current package version.
- [x] 1.4 Add a smoke test that the generated `dist.zip` extracts with `index.html` at the archive root and matches the versioned manifest layout.

## 2. Consumer Verification

- [x] 2.1 Add `Loader` contract tests for pinned-version precedence and release-source candidate precedence.
- [x] 2.2 Add `Loader` contract tests that validate manifest-relative asset loading and integrity propagation.
- [x] 2.3 Add `Sidecar` tests for successful installation, installed-marker updates, and repeated up-to-date no-op behavior.
- [x] 2.4 Add `Sidecar` failure-path tests for checksum mismatch and invalid archive layout without clobbering an existing target directory.

## 3. CI And Documentation

- [x] 3.1 Add the new distribution-contract smoke checks to CI or the release workflow so artifact regressions fail before publish.
- [x] 3.2 Update `README.md`, `README.zh-CN.md`, and mode-specific deployment docs to reflect the enforced contract for `Loader`, `Sidecar`, and `Dist`.
- [x] 3.3 Run the release pipeline verification locally (`pnpm build:publish` plus the new smoke tests) and capture any rollout caveats needed for maintainers.
