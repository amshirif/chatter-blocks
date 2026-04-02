# ChatterBlocks Field-Test Maintainer Checklist

Use this while observing each field-test session so issue logging stays consistent.

## Before The Session

- Confirm tester is using current `main`
- Confirm tester has the short runbook, not just raw ad hoc instructions
- Decide whether this session is:
  - core flow only
  - core flow + encrypted-state check
  - core flow + backup/recovery check

## During The Session

- Do not explain the next step unless the tester is clearly blocked
- Record the first moment they:
  - hesitate
  - backtrack
  - ask what a term means
  - retry a command or menu action
- Record whether they complete:
  - `pnpm demo:fresh`
  - Alice post
  - Bob respond
  - Alice accept
  - one sent message
  - one successful refresh/read

## Recovery-Specific Checks

If recovery is part of the session, record:

- whether passphrase/unlock behavior is understandable
- whether `chat secrets export/import/show` is understandable
- whether “missing local key version” copy is understandable
- whether the tester correctly infers that restoring an older backup can recover older decryptability

## Questions To Ask At The End

- What was the most confusing step?
- What term or concept was least clear?
- If you had to do this alone tomorrow, where would you expect to get stuck?
- In your own words, what are invites, matches, and local secret backups for?

## Issue Logging Format

For each issue, capture:

- Area: setup / recovery / messaging / trust model / docs / demo ops
- Severity: blocker / high friction / polish
- Exact step or screen
- What the tester expected
- What actually happened
- Whether they recovered alone or needed help

## After The Session

- Fill out the tester feedback template
- Add the issue to the shared backlog immediately
- Separate:
  - real failures
  - wording confusion
  - expected but surprising recovery behavior
