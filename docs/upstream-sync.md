# BZENITAL 2.4.0 — upstream integration

Integrated on 2026-11-07 from
[Michele501st/Zentral-Sine](https://github.com/Michele501st/Zentral-Sine),
release 1.1.0, commit `0e18990c0bfa2563d22de8f5d04135da186ef1b0`.
The shared source snapshot used for the three-way comparison is tag `v1.0.2`
(`0d93b79552878a94478f1b1d8933548151fca830`). The pre-integration BZENITAL
revision is `76f268bc69706fa9300ed38475db8fff939e7d98` (2.3.1).

## Included upstream changes

- Detachable app panels with drag, eight resize handles, docking to either side,
  snap previews and controls that remain reachable near window edges.
- Optional navigation toolbar: history, reload/stop, address, saved app URL,
  zoom and the address shortcut.
- Per-app mobile User-Agent and persisted mobile, zoom and docking-side options.
- A standalone geometry module, its embedded fallback and original geometry tests.
- Effective light/dark theme tracking for panels and tab-group previews.
- Updated control-pill layout, floating-panel styles and navigation preference.

## Preserved BZENITAL changes

- The compact centered App Bar, subtle add button, custom coordinated panel/bar
  animations and settings-button visibility.
- Group-label height of 20px and removal of the additional vertical-bar grain.
- Fork name, repository links, attribution and original license.
- App lifecycle cancellation, background-browser visibility, live preferences,
  safe module toggles and native group/session preservation from the previous audit.
- Logger/worker fixes, opt-in diagnostic attachments, no shared report endpoint
  and safe issue-report handling. Upstream did not change the logger or worker.

The merge records both histories so the next upstream update can use Git's
normal shared ancestry. No upstream source was replaced wholesale over the fork.
The geometry component keeps its upstream 1.1.0 component version; BZENITAL's
manifest, package and displayed version are 2.4.0.

## Validation

Run `npm test`, `npm run check` and the isolated Zen smoke test described in
[validation.md](validation.md). The original geometry tests and tests for the
external/embedded geometry implementations are included in the test command.
The browser smoke test loads the external geometry module before the main script.
Final result: 112/112 Node tests, syntax checks and the Zen 1.24.1b smoke test passed.
The real-browser checks also confirmed the compact centered bar, mobile User-Agent,
zoom, floating resize, snap docking and preservation of native groups through reload.

The user's installed browser profile is outside this integration and is preserved.
Authenticated apps, visual inspection and long-session behavior retain the manual
validation limits documented in `validation.md`.
