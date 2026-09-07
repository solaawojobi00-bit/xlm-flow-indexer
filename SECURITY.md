# Security Policy

## Supported Versions

This project is pre-1.0 (currently `0.1.0`) and has no released or maintained
branches other than `main`. Security fixes are applied to `main` only; there are
no backports to tags or older commits.

| Version                | Supported          |
| ---------------------- | ------------------ |
| `main` (latest commit) | :white_check_mark: |
| Any earlier commit/tag | :x:                |

If you are running this indexer, track `main`. Once a 1.0 release exists, this
policy will be revised to name the supported release lines.

## Reporting a Vulnerability

**Do not open a public issue, pull request, or discussion for a security
report.** Public reports disclose the problem to everyone before a fix exists.

Report privately by email to **sola.awojobi00@gmail.com**. Please include:

- A description of the vulnerability and the impact you believe it has.
- The affected file, function, or component, if you have narrowed it down.
- Steps to reproduce, ideally a minimal case (Horizon fixtures, a query, or a
  CLI invocation).
- The commit SHA you tested against, plus your Node.js version and operating
  system.

You may encrypt sensitive details however you prefer; say so in the first
message and a key can be exchanged.

## What to Expect

This project is maintained by one person, so the timelines below are targets
rather than a contractual SLA. All windows are in calendar days.

| Stage                                                 | Target                                  |
| ----------------------------------------------------- | --------------------------------------- |
| Acknowledgement that the report was received          | Within 3 days                            |
| Initial assessment — accepted, rejected, or need info | Within 7 days                            |
| Fix on `main` for an accepted report                  | Within 30 days, sooner for severe issues |
| Public disclosure                                     | After the fix lands, coordinated with you |

If you have not heard back within the acknowledgement window, please send a
follow-up email — mail does get filtered occasionally.

Accepted reports are credited in the fix commit and any advisory unless you ask
to remain anonymous. There is no bug bounty for this project.

## Scope

This project is a Stellar payment-flow indexer: it reads public ledger data from
Horizon and writes it to a local database. It has no authentication layer, no
network listener, and no multi-tenant surface. Reports that are in scope include,
for example:

- Injection through ingested Horizon data (SQL injection, path traversal from
  operation or asset fields).
- Data-integrity flaws where correct Horizon input produces wrong or
  attacker-controlled rows.
- Credential or secret leakage through logs, error messages, or committed files.
- Dependency vulnerabilities that are reachable from this project's code paths.

The following are generally **out of scope**:

- Denial of service caused by pointing the indexer at a hostile or malfunctioning
  Horizon endpoint you control.
- Vulnerabilities in Horizon itself or in SQLite/`better-sqlite3` — report those
  upstream, though a note here is welcome if this project's usage makes them
  worse.
- Anything requiring an attacker who already has write access to your database
  file, filesystem, or environment.
- Findings from automated scanners with no demonstrated impact on this codebase.

## Related

- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards and conduct
  reporting, which uses the same contact address.
