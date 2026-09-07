<!--
Delete nothing. If a section does not apply, say why in one line rather than
removing the heading — an empty section is a signal, a missing one is invisible.
-->

## What changed

<!-- What this PR does and why, in a few sentences. Reviewers read this before the diff. -->

## Closes

<!--
Use a closing keyword so the issue closes on merge: `Closes #123`.
If this PR does not close an issue, write "No issue — <reason>".
-->

Closes #

## Test evidence

<!--
Paste the tail of `npm test` from your own machine — the summary block with the
pass/fail counts, not a screenshot and not "tests pass". CI runs the same suite,
but this shows the change was verified before it was pushed.
-->

```
$ npm test

<paste the tail here>
```

Other checks run locally:

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`

<!-- If this PR touches migrations, also confirm they are idempotent: -->

- [ ] `npm run migrate` applies cleanly from an empty database and is a no-op on second run
- [ ] Not applicable — this PR does not touch migrations

## Scope boundary

<!--
This project asks changes to stay inside the issue they claim to fix. Drive-by
fixes, opportunistic refactors, and unrelated formatting churn make a diff harder
to review and harder to revert, so they belong in their own PR.
-->

- [ ] Every file in this diff is required by the issue above — no unrelated fixes, refactors, or reformatting are bundled in.

<!--
If you did bundle something in, list it here and say why splitting it out was not
practical. Being upfront is fine; a reviewer discovering it is not.
-->

## Notes for reviewers

<!-- Trade-offs, alternatives you rejected, or the parts you would most like a second opinion on. -->
