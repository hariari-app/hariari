# Handoff: Issue #24 complete; Issue #25 is next

- Verified: `2026-08-24T20:52:46+01:00`
- Repository: `hariari-app/hariari`
- Primary checkout: `/home/ndev/projects/vibeide`

This is the restart document for a fresh coordinator. GitHub, Orca ownership,
rulesets, and remote `main` are time-sensitive; revalidate them before any
mutation.

## Start here

1. Read this file completely.
2. Read `AGENTS.md`, `CONTEXT.md` if present, `docs/agents/issue-delivery.md`,
   and `docs/agents/delivery-learning-loop.md`.
3. Re-query Issue #25, both native blockers, open PRs, remote branches, active
   Orca Runs/Tasks/Dispatches/worktrees, repository rulesets, and remote `main`.
4. Stop admission if #25 is no longer open and `ready-for-agent`, either blocker
   has reopened, or another owner/Dispatch has claimed it.
5. Preserve the primary checkout's user-owned changes. Create a fresh,
   independent top-level Orca worktree from current `origin/main`;
   implementation does not belong in the primary checkout or the completed
   Issue #24 worktree.
6. Bootstrap and verify the Gitignored agent context before dispatching an
   implementation worker. Record the new clean `HEAD` as the fixed point and
   open the GL-1 evidence ledger.

This handoff has done its job when a fresh coordinator can prove #25 is still
eligible, name its worktree/branch/fixed point/Orca Run, Task, and Dispatch, and
start one bounded public-seam red-green slice without reading the previous
conversation.

## Completed delivery

Issue [#24](https://github.com/hariari-app/hariari/issues/24), **Control Plane
06: Reconcile crashes, stale sessions, and orphaned resources**, is closed as
completed.

- PR: [#51](https://github.com/hariari-app/hariari/pull/51)
- Fixed point: `4155dc21087e927f408176d9a5a5b4f962b4cea7`
- Final reviewed branch head: `695c508f6dc4202cff8d3ba24b30371d4438e0fa`
- Squash merge on `main`: `97c75fbcb2f2237333daaa5d41f83c850a19542f`
- Feature branch: `nandadevaiah/issue-24-runtime-recovery`
- Delivery size: 8 branch commits squashed to 1; 28 files; 2,744 additions and
  65 deletions; about 2 hours 24 minutes from first implementation commit to
  merge.

The slice delivered Runtime-owned desired-versus-observed recovery across
provider sessions, processes, PTYs, worktrees, and branches. It classifies
healthy, stale, missing, duplicated, externally modified, orphaned, and unknown
resources; selects resume, fork, adopt, archive, or fail by centralized rules;
and emits bounded Attention for ambiguity without implicit destructive or
lifecycle authority. Reconciliation and recovery outcomes are durable and
idempotent across retry and restart.

Native/adversarial coverage includes cross-Task marker substitution, duplicate
orphan worktrees and branches, a real survivor at the
spawn-marker-before-durable-context crash boundary, and healthy sibling Tasks
sharing a repository root. Public Runtime views remain provider-neutral and do
not expose filesystem paths, PIDs, native session identifiers, commands,
environment values, tokens, or cleanup authority.

### Final review and verification

The valid final two-axis review froze the exact range
`4155dc21087e927f408176d9a5a5b4f962b4cea7...695c508f6dc4202cff8d3ba24b30371d4438e0fa`.
Both sole-axis reviewers inspected every hunk in all 28 changed files:

- **Standards: PASS.** No findings remained.
- **Spec: PASS.** All five Issue #24 acceptance criteria and the remediated
  adversarial cases were evidenced.

Local evidence on the reviewed head:

- `npm test`: 50 files and 613 passing tests;
- `npx tsc --noEmit`, `npm run lint`, `npm run build`, and
  `git diff --check`: pass;
- exact-range GL-6 scan: largest changed file was
  `src/runtime/task-module.ts` at 798 lines; largest changed function or
  callback was 49 lines; and
- `npm audit --audit-level=high`: known failing Issue #42 baseline of 33
  vulnerabilities (2 low, 4 moderate, 25 high, 2 critical). This is not a
  green gate.

Hosted evidence:

- [PR run 32766645594](https://github.com/hariari-app/hariari/actions/runs/32766645594)
  passed all five jobs at the reviewed head.
- [merge/main run 32767539645](https://github.com/hariari-app/hariari/actions/runs/32767539645)
  passed all five jobs at the exact merge commit.
- The jobs were `lint-and-test`, `build-check`, and Runtime package smoke on
  Ubuntu, macOS, and Windows.

Four valid review rounds and two invalid aggregations were needed. One valid
Spec PASS was invalidated by later Standards remediation. More importantly, a
Standards review lane correctly found a shallow rules module but then edited,
committed, pushed, and opened the PR. That crossed its read-only ownership,
changed the frozen head, and invalidated the review pair. GL-6 now requires
mutation-fenced review lanes and coordinator checks of local and remote heads
before and after both axes. Apply that rule operationally in #25.

## State that must be preserved

The dirty primary checkout remains on local `main` at
`dd697a8d3adba5d94ea32a563aee7fbd5a7a3d9e`, 18 commits behind the fetched
`origin/main` at `97c75fbcb2f2237333daaa5d41f83c850a19542f` when this handoff was
verified. These user-owned changes must remain untouched:

- `.github/PULL_REQUEST_TEMPLATE.md`
- `.gitignore`
- `src/renderer/src/main.ts`
- `src/renderer/src/preview/single-preview.ts`
- `src/renderer/src/project/project-workspace.ts`

Use read-only inspection around those files. Fetching remote refs is safe;
updating, stashing, resetting, formatting, committing, merging, or rebasing the
dirty primary checkout is a separate user decision.

Preserve the completed Issue #24 evidence worktree unless the user separately
authorizes cleanup:

- path: `/home/ndev/orca/workspaces/vibeide/issue-24-runtime-recovery`
- branch/head: `nandadevaiah/issue-24-runtime-recovery` at
  `695c508f6dc4202cff8d3ba24b30371d4438e0fa`
- Orca workspace status: `completed`
- historical Orca Run: `run_7ca130d9bd23`
- merge: `97c75fbcb2f2237333daaa5d41f83c850a19542f`

Most local delivery context remains intentionally Gitignored:

- `docs/agents/issue-delivery.md`
- `docs/agents/delivery-learning-loop.md`
- `docs/agents/handoff-issue-23-to-24.md`
- `.agents/scripts/bootstrap-worktree-agent-context.sh`
- `.agents/scripts/verify-delivery-learning-context.sh`

This handoff, `docs/agents/handoff-issue-24-to-25.md`, is intentionally tracked
despite the local `docs/` ignore rule so the restart evidence is available from
the remote repository.

Issue #24 revised GL-6 to mutation-fence reviewers. Its active guardrail and
slice record are already in `docs/agents/delivery-learning-loop.md`; bootstrap
that source into the new worktree instead of recreating or weakening it.

The configured `origin` may still display the former `vibeide-app/vibeide`
spelling, which GitHub redirects to `hariari-app/hariari`. Treat the canonical
GitHub repository as `hariari-app/hariari`.

## Next eligible slice

Issue [#25](https://github.com/hariari-app/hariari/issues/25), **Control Plane
07: Expose raw events, normalized events, and a task timeline**, is the next
control-plane slice.

At verification it was open, labelled `ready-for-agent`, unassigned, and
blocked only by closed/completed Issues #20 and #21. No Issue #25-named remote
branch, Orca worktree, process, Run, or Task was found. The only open PRs were
unrelated PRs #12 and #15. Re-query all of this, including Dispatch state,
before admission.

This slice unlocks the plan's next wave:

- #26 remains blocked by open #25;
- #27 remains blocked by #26;
- #28 remains blocked by open #25 and #26; and
- #29 remains blocked by open #25 and #26.

Many later issues carry `ready-for-agent`; that label alone does not make them
dependency-ready. Do not skip the native blocker check.

### Acceptance criteria

1. Raw provider observations and normalized runtime events are stored as
   distinct records.
2. Normalized envelopes carry schema, identity, correlation, causation,
   idempotency, ordering, time, and redaction metadata.
3. Task status and a readable timeline are projections rather than the durable
   source of truth.
4. Replaying the same event history rebuilds equivalent Task, status, and
   timeline projections.
5. Content that cannot be proven safe to redact is excluded from durable
   storage.

### Current starting seam

Revalidate this against the fresh fixed point. At the Issue #24 merge, the
Runtime has:

- a single `TaskEvent` union in `src/runtime/task-events.ts`, where records
  carry event-specific fields plus `type` and `version: 1`, but no complete
  normalized envelope;
- one framed append-only Task log in `src/runtime/task-event-store.ts`, with
  append-before-apply ordering, restart replay, partial-frame repair, writer
  poisoning, and a rebuildable `projection.json`;
- projection ownership in `src/runtime/task-module.ts` and
  `src/runtime/task-execution-projection.ts`; and
- no authenticated public Runtime query for raw observations, normalized event
  history, or a readable Task timeline in
  `src/shared/runtime/runtime-interface.ts`.

The durable PTY output log from #22 is not automatically safe raw provider
evidence. Do not copy prompts, output, provider payloads, commands, environment
values, paths, tokens, or native IDs into the new records merely because that
content already exists at another private boundary.

### Scope and attack-first gates

Keep #25 on evidence separation, normalized envelopes, replayable projections,
redaction, and the smallest readable timeline. Policy decisions and command or
filesystem governance belong to #26; credential leasing belongs to #27;
Attention Queue behavior belongs to #28; additional provider adapters belong
to #29.

Drive one authenticated public-seam red-green vertical slice at a time:

- first make one allowlisted provider observation produce a distinct raw
  record, a normalized event envelope, and a deterministic timeline entry;
- add the read-only Runtime contract through every strict client/server/port
  fixture rather than weakening validation or letting the renderer inspect
  Runtime files;
- define schema/version, event identity, Task identity, correlation,
  causation, idempotency, per-history ordering, event time, and redaction
  metadata once; store replay inputs such as time rather than regenerating them
  during projection;
- preserve compatibility with existing version-1 Task logs or make any
  migration explicit, fail-closed, and restart-tested;
- use allowlists for durable raw evidence. Unknown or unproven fields are
  omitted or rejected, and redaction metadata describes that decision without
  leaking the excluded value;
- prove same history means equivalent Task, status, and timeline projections
  after deleting only rebuildable projections and restarting the Runtime;
- prove duplicate/idempotent input, correlation/causation integrity, stable
  ordering, malformed or future schema handling, and cross-Task identity
  rejection; and
- render only Runtime projections. The renderer must not become a durable
  store, synthesize authoritative status, read logs directly, or gain cleanup
  and provider-native authority.

Apply the full GL-7 zero-first, partial/error, retry, and restart/replay matrix
to every new append-before-success boundary. A query-only timeline does not
need a replay/live stream; if the implementation adds a subscription, GL-9's
more-than-capacity delayed-acknowledgement and stalled-write matrix becomes
mandatory. Apply GL-8 if any renderer mutation is introduced, though a
read-only projection should avoid that scope.

Redaction tests must be adversarial and inspect durable bytes, not only the
public response. Include secret-like tokens, absolute paths, commands,
environment values, provider-native identifiers, unknown fields, and nested
payloads. A redacted public view is insufficient if unsafe source content was
already written to disk.

Before each review freeze and after every remediation batch, rerun exact-range
churn, file-size, and AST function-length scans, including outer test callbacks.
Fence both review lanes read-only and verify the local head and remote branch
before and after the Standards and Spec reports.

## Restart sequence

Load the version-matched Orca CLI and orchestration guides rather than relying
on cached syntax:

```bash
cd /home/ndev/projects/vibeide
orca-ide skills get orca-cli
orca-ide skills get orchestration
orca-ide status --json
git status --short --branch
git ls-remote origin refs/heads/main 'refs/heads/*issue-25*'
gh issue view 25 --repo hariari-app/hariari --json number,title,state,labels,assignees,body,url
gh api repos/hariari-app/hariari/issues/25/dependencies/blocked_by
gh pr list --repo hariari-app/hariari --state open --json number,title,headRefName,body,url
gh api repos/hariari-app/hariari/rulesets
orca-ide orchestration run-list --json
orca-ide orchestration task-list --json
orca-ide repo list --json
orca-ide worktree list --repo id:<current-repo-id> --json
orca-ide worktree ps --json
```

If #25 remains eligible, refresh the remote ref and create the independent
worktree without an implementation agent so the ignored delivery context can
be installed first:

```bash
git fetch origin main
orca-ide worktree create \
  --repo id:<current-repo-id> \
  --name issue-25-event-timeline \
  --no-parent \
  --setup run \
  --json

bash .agents/scripts/bootstrap-worktree-agent-context.sh \
  /home/ndev/orca/workspaces/vibeide/issue-25-event-timeline
bash .agents/scripts/verify-delivery-learning-context.sh \
  /home/ndev/orca/workspaces/vibeide/issue-25-event-timeline
git -C /home/ndev/orca/workspaces/vibeide/issue-25-event-timeline status --short
git -C /home/ndev/orca/workspaces/vibeide/issue-25-event-timeline rev-parse HEAD
```

Resolve `<current-repo-id>` live and copy the full worktree ID from Orca's
create result. The new worktree must be clean after bootstrap, and its `HEAD`
becomes the fixed point. Do not hard-code the merge SHA above as the fixed point
because remote `main` may advance.

Then follow `docs/agents/issue-delivery.md`: bind a fresh Orca Run, create one
Issue #25 Task, preserve its dependency evidence, start one implementation
owner in the existing worktree, and record the branch/worktree/fixed
point/Task/Dispatch in the GL-1 ledger. Freeze an exact committed head for fresh
mutation-fenced Standards and Spec reviews, then deliver through one protected
PR with `Closes #25`.

The active branch rulesets at verification were:

- `main independent review gate` (`21094680`): one approving review, code-owner
  and last-push requirements, with the named solo maintainer limited to
  pull-request bypass; and
- `main non-bypassable safety gates` (`21094675`): no bypass actors, PR and
  conversation gates, deletion/non-fast-forward prevention, and required
  `lint-and-test` plus `build-check` on an up-to-date branch.

Re-query both rulesets before relying on the solo-maintainer exception.

## Completion requirements for Issue #25

Issue #25 is complete only when:

- every acceptance criterion has authenticated public-seam evidence;
- raw observations and normalized events are durably distinct, complete
  envelopes are strict, and unsafe content is absent from durable bytes;
- projection deletion plus restart/replay rebuilds equivalent Task, status, and
  readable timeline views;
- every applicable GL-7 and GL-9 matrix is green, and any GL-3/GL-8
  applicability or accepted blocker is explicitly recorded;
- fresh sole-axis Standards and Spec reports are acceptable at the exact final
  head, with reviewer mutation fencing proven;
- local and affected hosted checks pass on that same head;
- the protected PR is merged and Issue #25 is closed;
- the learning loop records metrics and lesson dispositions; and
- Orca ownership is settled and the dependency frontier, especially #26, is
  recalculated live.

Keep the Issue #42 audit baseline separate and report it as failing until its
own remediation lands.

## Copy-paste resume prompt

```text
Read /home/ndev/projects/vibeide/docs/agents/handoff-issue-24-to-25.md completely.
Revalidate every time-sensitive GitHub, Orca Run/Task/Dispatch/worktree,
ruleset, and remote-main fact in its Start here section. Preserve the listed
dirty-primary changes and completed Issue #24 evidence worktree. If Issue #25
remains open, ready-for-agent, unassigned, unblocked, and unowned, admit it
through the local issue-delivery directive in a fresh independent top-level
Orca worktree from current origin/main. Bootstrap and verify the Gitignored
agent context before dispatch, then record the clean fixed point and GL-1
ledger. Implement only #25 through authenticated public Runtime seams, one
red-green vertical slice at a time: distinct allowlisted raw observations and
normalized envelopes, strict schema/identity/correlation/causation/idempotency/
ordering/time/redaction metadata, replay-derived Task/status/timeline
projections, legacy-log compatibility, and fail-closed durable-byte redaction.
Do not expand into #26 Policy Engine, #27 credentials, #28 Attention Queue, or
#29 adapters. Apply GL-7 to every append, GL-9 to any replay/live stream, keep
the renderer projection-only, mutation-fence both independent review axes, and
finish through protected PR delivery, merge/closure verification,
learning-loop update, and live recalculation of #26 readiness.
```
