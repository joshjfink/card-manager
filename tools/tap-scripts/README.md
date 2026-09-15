# Tap scripts

Real-tap regression scripts for `tools/mg-tap-suite.js`.

**Assert destinations, not waypoints.** `career-boot.json` used to assert the
countdown screen, and a build that booted *faster* than the script's 900ms
wait sailed past it — the gate then held a perfectly good build for hours.
Assert the state the player must reach (`play`), with a generous timeout, and
take screenshots of the journey rather than gating on it.
