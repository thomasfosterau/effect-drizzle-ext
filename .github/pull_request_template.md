## Summary

Describe what changed and why. If this closes an issue, add `Closes #N` so it auto-closes on merge to `main`.

## Validation

Run the gates in [AGENTS.md → Verification](https://github.com/thomasfosterau/effect-drizzle-ext/blob/main/AGENTS.md#verification) and list each command with its final pass/fail. If one can't run (`vp run test:integration` needs Docker or PostgreSQL), say so.

- [ ] A changeset under `.changeset/` for every change to a published package's behaviour

## Notes

Anything reviewers should pay special attention to: exported signatures, declaration-emit shape, peer ranges, behaviour ported from an application that must stay byte-compatible.
