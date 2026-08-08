# Goal: Help a new contributor run the project checks

## Why now

A new contributor should be able to verify a change without needing private context or a live service.

## Success looks like

- A contributor can find and run the repository validation command from the README.
- The command explains whether the checks passed or where to investigate a failure.

## Boundaries

- Do not: change application behavior or publish a release.
- Ask before: changing required checks or adding a dependency.

## Evidence

- `npm run validate` completes successfully from a clean install.
- A reviewer can follow the README command without additional setup.
