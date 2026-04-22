# Handoff — deep dive on stats/handicap issues

Picking up from the session that landed v1.5 (tabbed stats modal + Greg-par
model + per-user handicaps + daily refit workflow).

## Current state — what's shipping

- **v1.5.7 deployed to GitHub Pages.** Stats modal has Daily / Challenge /
  Quick Play tabs. Daily tab renders handicap, history, delta-by-complexity,
  strike rate, delta-by-modifier, delta distribution (KDE), rank vs. field.
- **PAR_MODEL is at seed coefficients** (see `src/logic/difficulty.js` between
  the `PAR_MODEL:START` / `PAR_MODEL:END` markers). We tried a real refit
  on 62 scores, got unstable coefficients (canonical 2.0 → 14.77,
  wormhole 0.8 → 32), and reverted. `MIN_SCORES_TO_FIT` is now 150.
- **Handicaps** (`src/logic/handicaps.json`) computed via recentered mean-
  residual against seed coefs:
  - Chris (`5Ht9d2io0ugU1NGsjdJmZvkJi382`): **+2.45s**
  - Kate (`kPkUkn5mndZG2SIGC1xC329zhrA3`): **−2.53s**
  - 5s gap between them, Kate slightly faster relative to population.
- **Firebase data**:
  - `daily/{date}/{pushId}`: 82 scores total, 42 Chris / 38 Kate / 1 Wendy / 1 Sebas (all Chris and Kate entries uid-tagged after retrofit)
  - `dailyMeta/{date}`: 44 dates (2026-03-09 through 2026-04-20 + 2026-04-21)
  - `users/{uid}/dailyHistory/{date}`: 41 for Chris, 38 for Kate
- **GitHub Action**: "Refit Greg-par" runs daily at 14:00 UTC (10am ET EDT /
  9am ET EST). No secrets needed — Firebase paths are world-readable.

## Known broken things

### 1. Service-worker cache staleness blocks users from seeing latest code

**Symptom (Chris):** stats page showed "~30s below par" consistently even
though handicap displays +2.5s. Root cause: `difficulty.js` is imported as
an ES module and cached aggressively by the service worker / browser
module cache. `handicaps.json` is fetched dynamically and stays fresh.
Result: stale coefficients + fresh handicap = internally inconsistent
numbers.

**Symptom (Kate):** "Need 3+ plays" message despite 38 retrofitted entries.
Almost certainly the same cache-staleness issue — her client is running
code from before the v1.5 stats renderer that actually reads her
`dailyHistory`.

**Blocker:** **Kate is on Chrome for iPhone.** She can't use desktop
DevTools; she can't easily inspect localStorage; iOS Chrome's "clear
cache" UI is buried and also tends to clear localStorage (which resets
Firebase anonymous auth and rotates her uid).

We need a mechanism that doesn't depend on the user knowing how to
clear a specific site's cache.

### 2. Kate's uid may have drifted

If she cleared localStorage during one of her cache attempts, her Firebase
anon-auth token was wiped and her next session got a brand-new uid. In
that case her 38 retrofitted entries sit under the old uid
(`kPkUkn5mndZG2SIGC1xC329zhrA3`) and her current session can't see them.

We can't confirm without reading her current uid from her device.

### 3. No in-app diagnostics

If the user is on mobile and reports a wrong number, I have no way to
tell what their device actually sees. Need an in-app surface that
displays: current uid, current PAR_MODEL coefficients, handicaps.json
contents, fetched history count.

### 4. Handicap semantics with N=2 players

Recentered mean-residual against 2 players produces "Chris is half the
gap above average; Kate half the gap below." Numerically fine, but
interpretively weak at N=2. Worth revisiting whether we show
handicap at all before a third player joins, or show something else
(e.g. raw mean residual labeled as "typical delta vs. par").

## Ordered TODO for the next session

1. **Build an in-app diagnostics page.**
   - New hidden/secret path (e.g. `?debug=1` or a footer link on the title
     screen) that renders a single screen of: current uid, whether
     Firebase is online, fetched `dailyHistory` count, current
     `PAR_MODEL` values (parsed from what's actually in memory), last
     `handicaps.json` `updatedAt`, and the bundle version.
   - Goal: have Kate open it on her iPhone and screenshot. Gives us the
     ground-truth data without needing DevTools.
   - Should also expose a "copy diagnostics" button that copies the JSON
     to clipboard.

2. **Fix cache invalidation end-to-end.**
   - When a new `CACHE_NAME` activates, the service worker should
     `postMessage` to all clients. Client listens and shows a toast:
     "New version — tap to reload."
   - Auto-reload is an option for a small-audience app — the user sees
     "App updated. Reloading..." for a second, then the fresh bundle.
   - Verify this works across Chrome iOS specifically (its SW handling
     has historically been flaky).

3. **Handle uid drift gracefully.**
   - On login, if `users/{uid}/dailyHistory` is empty and there are
     orphan retrofitted dates tagged to a different uid, offer a
     "migrate" action. Hard to automate without knowing which old uid
     was theirs.
   - Prevention: store a device-stable identifier somewhere that
     survives cache clears (IndexedDB, maybe). Firebase anonymous
     auth persistence can be reconfigured, but this is fiddly.

4. **Kate's data specifically:**
   - Once her current uid is visible via the diagnostics page, retrofit
     `users/{new-uid}/dailyHistory` with her 38 historical scores.
   - Decide: migrate her old-uid `daily/*/{pushId}.uid` fields to the
     new uid, or leave the old scores tagged to the old uid. Migration
     is cleaner for the regression fit.

5. **Revisit handicap interpretation.**
   - With proper data (both players seeing consistent numbers), validate
     that Chris's +2.45 and Kate's −2.53 actually match their felt
     experience.
   - Consider whether the recentering is the right choice or whether
     showing raw residual would be more honest at small N.
   - Add a "last refit" timestamp somewhere near the handicap headline
     so players can see when their number last changed.

6. **Optional but worth considering:**
   - Ridge regression for the refit (shrinks unstable coefficients toward
     their prior without the clamping bias).
   - Showing the current PAR_MODEL coefficients somewhere in the app so
     numbers are auditable from the UI rather than only in the source.

## Quick reference — how to rerun things locally

```bash
# Dev server
python -m http.server 8080

# Manual refit (writes difficulty.js + handicaps.json if N >= 150)
"/c/Program Files/R/R-4.5.2/bin/Rscript.exe" scripts/refit-par-model.R

# Calibration check against today's daily
node scripts/calibrate-today.mjs 2026-04-21

# Deploy Firebase rules (when firebase-rules.json changes)
MSYS_NO_PATHCONV=1 firebase deploy --only database

# Apply a multi-path Firebase update (admin bypasses rules)
MSYS_NO_PATHCONV=1 firebase database:update / update.json -f

# Backfill historical dailyMeta
# Start a dev server, then open /backfill-features.html,
# set dates, type BACKFILL, click Run.
```

## Who's who (as of 2026-04-21)

- **Chris** uid = `5Ht9d2io0ugU1NGsjdJmZvkJi382` — 42 scores, 41 dailyHistory entries, handicap +2.45s
- **Kate** uid = `kPkUkn5mndZG2SIGC1xC329zhrA3` — 38 scores, 38 dailyHistory entries, handicap −2.53s (Kate's current browser may have a different uid)
- **Wendy** (1 score, no uid) and **Sebas** (1 score, no uid) — real people per Chris, left as-is

## Files that matter

- `src/logic/difficulty.js` — PAR_MODEL coefficients (between markers)
- `src/logic/dailyFeatures.js` — feature computation, predictPar, breakdownPar
- `src/logic/handicaps.js` — handicap lookup + client fallback
- `src/logic/handicaps.json` — current handicaps (refitted daily)
- `src/ui/charts.js` — SVG chart toolkit
- `src/ui/statsRenderer.js` — Daily tab orchestration
- `scripts/refit-par-model.R` — daily regression + handicap computation
- `scripts/fit-par-model.qmd` — interactive diagnostics in Quarto
- `.github/workflows/refit-par-model.yml` — cron schedule
- `firebase-rules.json` — RTDB security rules
- `backfill-features.html` — one-shot browser utility for dailyMeta

## CLAUDE.md sections with the model architecture

- "Greg-par Model (Daily)"
- "Daily History Chart"
- "Handicaps (user-specific par offsets)"
- "Refit Workflow (.github/workflows/refit-par-model.yml)"
- "Firebase" → Database paths
