# Security Policy

## Reporting status: active

Private vulnerability intake is active through [GitHub Private Vulnerability Reporting](https://github.com/sunnykgupta/AutoRepo.ai/security/advisories/new).
The repository setting was enabled and verified by authenticated API read-back on
2026-08-08. Sunny R Gupta (`sunnykgupta`) owns the route in the O2 role.

Do not send vulnerability details through GitHub issues, pull requests,
discussions, or any other public channel. The project does not promise a fixed
response or remediation time yet, but O2 will triage reports through the private
advisory route and keep sensitive details out of public work.

## Verification record and continued validity

The active claim remains valid only while all of the following are true and
recorded in Git:

1. GitHub Private Vulnerability Reporting was enabled and its provider setting
   was verified by authenticated API read-back on 2026-08-08.
2. The O2 security authority confirms responsibility for the route.
3. A future provider-setting change is read back and this document is updated
   with the current route state.

## Security decisions and exceptions

O2 owns security finding disposition, privileged security decisions, and
security exceptions. O1 and O2 are distinct authorities even during bootstrap
when the same human holds both roles. A security exception can never be
self-approved: it needs a second independent human reviewer or remains
blocked. Agents and bots cannot approve their own findings or exceptions.

Potential secrets or private security data must be handled confidentially and
must not be quoted in a public issue, pull request, or log.
