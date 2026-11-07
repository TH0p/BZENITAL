# BZENITAL maintenance validation

Audit date: 2026-11-07. Baseline: `9aac890d7b61a418c6a4d2966504a4325db00de7`.

Version 2.4.0 also integrates Zentral 1.1.0; the exact source revision and
preserved fork changes are listed in [upstream-sync.md](upstream-sync.md).
Final integration checks: 112/112 Node tests passed, all scripts passed syntax
checks, and the isolated Zen browser smoke test passed.

Version 2.4.1 separates BZENITAL's Sine ID from the original and fixes the update
route. To test against an installed Sine engine without modifying its profile:

```powershell
node tools/sine-update-smoke.cjs "<profile-directory>\chrome\JS"
```

This evaluates the installed Sine manager and URL conversion code with intercepted
network/archive operations. Two consecutive updates must keep the fork's homepage
and download source, never request upstream files, and retain a distinct ID from
the original. The previous `main` manifest reproduced the upstream redirect; the
fixed manifest passed using Sine 2.3.4.1c.

Version 2.4.2 adds an 8px inner margin between the fixed Apps Bar and the page,
mirrored for both sidebar positions in the stylesheet and injected CSS. The
margin was measured in an isolated Zen profile; the bar remains 44px wide.
All 112 Node tests, syntax checks and the isolated Zen smoke test passed. The
collapse check now uses the current natural compact height, since moving the
add button between the grid and footer can legitimately change that height.

Version 2.4.3 corrects the app panel itself: it is fixed-positioned, so the
2.4.2 bar margins did not move it. Its previous hard-coded 44px offset left
zero spacing beside the 48px autohide bar (4px beside the fixed bar). Panel
placement now uses the actual bar width and outer inset plus an 8px inner
gap. Autohide uses the CSS inset rather than the animated bounding rect.
A disposable Zen 1.24.1b profile reproduced the old 0px/4px gaps and measured
8px after the correction in all four combinations of mode and side. All
112 Node tests, syntax checks and the isolated Zen smoke test passed.

## Scope and checks

Run `npm test` for the regression suite and `npm run check` for script syntax.
These commands use only Node.js built-ins; no dependencies or build step are needed.

The suite runs real classes/functions extracted from the userChrome monolith in
isolated VM contexts, with doubles for Gecko/DOM boundaries that Node cannot provide.
Worker tests intercept outgoing fetch requests; they never publish GitHub issues.

Covered failures:

- Startup duplication, pending startup after unload, failed module initialization,
  preference default branches/types, live module toggles and cleanup.
- Cancelled app preloads/animations, hidden background browsers, stale apps after
  preference changes, malformed saved data, keyboard shortcuts and panel resizing.
- Group recovery and hierarchy, pending restoration, native group preservation,
  selection guards, observers/listeners, favicon races and native menu restoration.
- Disabled logging, bounded buffers, console wrapping, Gecko error registration,
  popup observers, unique exports and stream cleanup on errors.
- Issue validation, payload limits, endpoint/response URL validation, cancellation,
  report drafts, DOM-safe links and configurable worker destinations.
- Upstream panel geometry, docking, all resize directions and equivalent behavior
  of the external geometry module and embedded fallback.
- App-tab isolation never detaches a group created after opening a tab and ignores
  focus retained by a closed panel; resizing interrupts the detachment animation.

## Real-browser smoke test

On Windows with Zen installed, run:

```powershell
node tools/zen-smoke.cjs "C:\Program Files\Zen Browser\zen.exe"
```

The test starts a separate headless Zen process with a new temporary profile,
loads the scripts/styles, checks startup/settings, writes preferences with native
Sine-compatible types, tests navigation/zoom, verifies the mobile User-Agent using
a local HTTP server, detaches/resizes/re-docks a panel, checks the compact centered
App Bar's expansion/collapse, toggles modules, creates a native tab group, verifies that
disabling Zentral preserves its tabs/group, and unloads the mod. It closes only
the process it started and removes only the temporary profile it created.
It never reads, updates or restarts the user's existing browser profile.

The smoke test passed on Zen 1.24.1b (Gecko 159.0.1), Windows, on the audit date.

## Limits

Passing checks establish the covered behaviors; they do not establish that every
possible bug has been eliminated. Headless checks do not replace manual visual
inspection, real drag-and-drop, multi-monitor layouts, authenticated third-party
apps, or long-running sessions. Multi-window recovery has automated coverage;
simultaneous full-browser session restoration still needs manual validation.

No Cloudflare worker was deployed and no live report was submitted. A deployed
public endpoint needs owner-configured Cloudflare abuse/rate controls. Diagnostic
logs are opt-in and may include tab titles, URLs and menu text; review before sharing.
