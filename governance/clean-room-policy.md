# Clean-room Policy

**Policy version:** `autorepo-clean-room-v1`

## Purpose and public boundary

AutoRepo.ai public work is independently authored. A restricted,
hash-addressed source inventory is retained outside this repository. The public
attestation publishes only the permitted inventory digest, entry count, policy
version, limited state metadata, and—once available—opaque SHA-256 references
to immutable external scan and tool-manifest evidence. It must never expose
restricted source locators, commits, paths, names, manifests, scan contents, or
tool contents.

See [`source-inventory.attestation.yaml`](source-inventory.attestation.yaml)
and its schema for the public inventory record and the conditions required
before it can attest a scan result.

## Allowed material

The following are allowed when independently created or used under their
applicable terms:

- generalized concepts expressed in new language;
- public standards and third-party documentation identified by public URL and
  version;
- ordinary scaffolding produced by declared tools;
- the existing AutoRepo.ai MIT License;
- synthetic data and neutral examples; and
- newly created diagrams, assets, and documentation based on public inputs.

## Prohibited material

Do not add copied or closely paraphrased restricted prose, code, comments,
tests, prompts, diagrams, screenshots, assets, identifiers, private URLs,
account or resource identifiers, credentials, telemetry, delivery history,
business rules, schemas, fixtures, or source history/metadata. Do not move a
suspicious fragment into a public issue or log for review.

## Author and reviewer requirements

The preferred arrangement prevents public authors and build agents from reading
restricted source material. If an author previously had restricted-source
access, every affected work item requires:

1. an author clean-room attestation; and
2. provenance and scan review by an independent non-author.

No author or executing agent may approve its own similarity exception. O1 owns
provenance disposition, O2 owns suspected secret or security exposure, and an
independent reviewer is required for any borderline similarity decision.

## Scan and release controls

All candidate files receive secret and prohibited-identifier scans. The
following findings block public merge until independently disposed:

| Category | Threshold |
| --- | --- |
| Credentials | Any verified detector match; entropy candidates at least 4.5 bits/character across 20+ characters require review. |
| Restricted identifiers | Any prohibited exact identifier or phrase match. |
| File identity | Any non-allowlisted identical file hash. The preserved MIT License is allowlisted. |
| Prose | A normalized exact run of 12+ words, or similarity of 0.85+ across 50+ words. |
| Code | Token similarity of 0.80+ across 50+ significant tokens, or an identical non-trivial function/class sequence. |
| Assets | Exact asset hash, perceptual-image Hamming distance of 8 or less, or an unattributed asset. |
| Binary/archive | An unrecognized binary, archive, embedded source map, or metadata-bearing asset. |

Generated lockfiles, generated clients/schemas, SBOM/provenance outputs, and
dependency license text may skip prose/code similarity only when generator and
version, inputs, and output digest are recorded. They still receive secret,
identifier, license, and binary/metadata scans. Build outputs and dependency
directories are not committed as source.

An unresolved finding blocks merge, G1/G7/G8, and release publication. Scanner
outage fails closed for public release. Remove and independently recreate
similar material, then rescan. Suspected credentials or private security data
go to O2 for confidential handling. Prohibited secret or private data has no
exception path.

Restricted inventories, scan reports, dispositions, attestations, and tool
manifests are retained for the affected release's support life plus three
years. Public digest and release attestation records remain in Git history.

The fork-safe GitHub workflow runs the public-boundary scanner against tracked
files without confidential inputs. The stronger restricted scan is deliberately
separate: `npm run clean-room:restricted-scan` requires an access-controlled
corpus manifest, emits a hash-only report, and fails closed when that evidence
is unavailable. CI validates the immutable report and tool-manifest hashes in
the public attestation; it never receives the confidential corpus itself.
