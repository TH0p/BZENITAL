# BZENITAL maintenance validation

Audit date: 2026-11-07. Baseline: `9aac890d7b61a418c6a4d2966504a4325db00de7`.

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

## Real-browser smoke test

On Windows with Zen installed, run:

```powershell
node tools/zen-smoke.cjs "C:\Program Files\Zen Browser\zen.exe"
```

The test starts a separate headless Zen process with a new temporary profile,
loads the scripts/styles, checks startup/settings, writes preferences with native
Sine-compatible types, toggles modules, creates a native tab group, verifies that
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
