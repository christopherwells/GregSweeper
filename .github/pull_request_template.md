<!-- GregSweeper PR. Keep the shipped app dependency-free (no runtime `dependencies` in package.json). -->

## What & why


## Regression test
<!--
Every bug-fix PR adds (or extends) a test that FAILS before the fix and PASSES after,
at the CHEAPEST layer that can catch it:
  pure helper (node --test)  >  import-smoke  >  boot-smoke (e2e)  >  e2e journey
If the bug lived in DOM-coupled code, EXTRACT the decision into a pure helper and test that
(the project's established pattern: moltDay, resumeEligibility, scoreRowMatch, the Layer-1 helpers).
Name the incident in the test header; prefix the pinning case `REGRESSION:`.
-->
- [ ] Regression test added/updated — layer: ____, file: ____
- [ ] …or rationale why none applies:

## Verification
<!-- Tick what you ran. -->
- [ ] `node --test test/*.test.mjs` green
- [ ] `npm run typecheck` green (if touching a curated `src/logic` module)
- [ ] `npm run test:e2e` green (if UI / boot affecting)
- [ ] Cache bumped in `sw.js` (if this ships an app-code change)
