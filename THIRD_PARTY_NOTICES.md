# Third-party notices / 第三方来源与许可

This project is a combined and modified distribution, not a claim that every bundled file was written from scratch by kixrlm contributors. The root [LICENSE](LICENSE) applies to this project's contributions; preserve the notices below when redistributing the corresponding material.

## KIX / kixparadigm

- Source: [Kasugano-Soraa/kixparadigm](https://github.com/Kasugano-Soraa/kixparadigm).
- Reference: [`c4cb4217455647d8dbcc9b6ff967c414b329a912`](https://github.com/Kasugano-Soraa/kixparadigm/commit/c4cb4217455647d8dbcc9b6ff967c414b329a912).
- Copyright (c) 2026 kixparadigm contributors.
- License: [MIT, full original text](licenses/kixparadigm-MIT.txt).
- Scope: the KIX persona/composition, plugins, agents, prompts, kixparadigm/kixpower resources and historical experience documents under `integrations/dsh/kixrlm/`, with subsequent fusion and distribution changes. The reference commit is a provenance anchor, not a claim that the complete preset equals that revision byte-for-byte.

## prime-agent RLM

- Source: [Dmatut7/prime-agent-rlm](https://github.com/Dmatut7/prime-agent-rlm), reference [`402d58516f38b68be37e039d68cc0751b173914d`](https://github.com/Dmatut7/prime-agent-rlm/commit/402d58516f38b68be37e039d68cc0751b173914d).
- Copyright (c) 2025 Mario Zechner.
- Copyright (c) 2026 Prime Intellect.
- License: [MIT, full original text](licenses/prime-agent-rlm-MIT.txt).
- Scope: the DSH adaptations `plugins/rlm-kernel.js`, `plugins/rlm_kernel.py`, `plugins/rlm-harness.js`, related RLM/refine skill material and tests in the bundled preset. These are adaptations, not a vendored copy of the complete upstream runtime.

## Matt Pocock skills

- Source: [mattpocock/skills](https://github.com/mattpocock/skills).
- Verified content anchors: [`62f43a18177be6ec82da242e59ffbc490a4c22ea`](https://github.com/mattpocock/skills/tree/62f43a18177be6ec82da242e59ffbc490a4c22ea) and [`221ffca96736afefdc08ca7cf0b3965e9ea83f41`](https://github.com/mattpocock/skills/tree/221ffca96736afefdc08ca7cf0b3965e9ea83f41), with identical MIT license text.
- Copyright (c) 2026 Matt Pocock.
- License: [MIT, full original text](licenses/matt-pocock-skills-MIT.txt).
- Scope: copied or adapted material in `skills/caveman`, `diagnose`, `grill-me`, `grill-with-docs`, `handoff`, `improve-codebase-architecture`, `migrate-to-shoehorn`, `prototype`, `tdd`, `teach`, `to-issues`, `to-prd`, `triage`, `write-a-skill` and `zoom-out`, including their supporting templates and documents.
- Provenance verification found 24 exact file-blob matches across these two anchors, plus adapted bodies. These are verifiable content references, not an assertion that all directories were originally imported at one of those exact commits. In particular, the precise historical import of `zoom-out` has not been reconstructed; its upstream attribution is retained conservatively.

## DeepSeek Harness (DSH)

- Upstream: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- Copyright (c) 2026 DeepSeek.
- License: [MIT, original installed-package text](licenses/deepseek-dsh-MIT.txt).
- Scope: upstream code represented by the workflow and compaction host diffs under `integrations/dsh/host-patches/`; the observed package version is `0.1.5-rc.2`. DSH itself and its dependency tree are not vendored here.

## Distribution boundary

The complete Git repository/archive includes these notices and all license texts. The preset also carries a combined `LICENSE` so a manual preset-only installation does not silently drop the bundled notices. Keep the relevant notices with any extracted or repackaged subset.

External tools mentioned or loaded optionally (for example Playwright/Chromium, model providers and PowerShell) have their own licenses and terms. Referring to them does not include their implementation or credentials in this repository. No endorsement by the upstream authors is implied.
