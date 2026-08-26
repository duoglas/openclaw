---
summary: "Maintain and validate the fleet Responses WebSocket branch without touching a live checkout"
read_when:
  - Rebasing the fleet Responses WebSocket branch onto a new upstream OpenClaw revision
  - Building, staging, accepting, or rolling back a fleet OpenClaw upgrade
  - Verifying proxy routing and replay safety for custom Responses WebSocket providers

title: "Fleet Responses WebSocket maintenance"
---

# Fleet Responses WebSocket maintenance

This runbook covers the maintenance branch that carries explicit custom-provider
Responses WebSocket support. It is intentionally safe to publish: hostnames,
addresses, credentials, provider names, and local installation paths are omitted.
Substitute values from the private fleet inventory at execution time.

The maintenance script is an inspection and isolated-build tool. It never updates
a live checkout, installs into a live checkout, deploys a package, or restarts a
process.

## Branch and remote model

Use separate remote names for the public upstream and the maintenance fork:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git remote add fork git@github.com:YOUR-FORK/openclaw.git
git fetch --no-tags upstream main
git fetch --no-tags fork fleet/responses-websocket
```

The long-lived patch branch is `fleet/responses-websocket`. Do not carry the
patch on the fork's `main` branch, and do not merge upstream `main` into the
maintenance branch. Rebase it in an isolated checkout:

```bash
git clone --no-hardlinks /path/to/clean-maintenance-checkout /tmp/openclaw-ws-rebase
git -C /tmp/openclaw-ws-rebase remote add upstream https://github.com/openclaw/openclaw.git
git -C /tmp/openclaw-ws-rebase fetch --no-tags upstream main
git -C /tmp/openclaw-ws-rebase switch fleet/responses-websocket
git -C /tmp/openclaw-ws-rebase rebase upstream/main
```

Resolve conflicts by preserving current upstream architecture and the invariants
below. Run the gates before updating the fork. After review, update only the
maintenance branch with lease protection:

```bash
git push --force-with-lease fork fleet/responses-websocket
```

Never pull, stash, reset, checkout, or rebase inside a directory used by a live
OpenClaw process. A dirty live checkout is a stop condition, not permission to
hide changes with a broad stash.

## Fixed inspection entry point

From a clean maintenance checkout with a locally fetched upstream ref:

```bash
scripts/fleet-ws-upgrade-check.sh status \
  --upstream-ref refs/remotes/upstream/main
```

`state=current` means the selected upstream commit is an ancestor of the
maintenance commit. `state=stale` exits with status 3 and means a rebase is
required. `status` is read-only and does not fetch.

The dry-run modes clone the selected commit into a temporary directory and do
all rebasing, dependency installation, testing, and building there:

```bash
scripts/fleet-ws-upgrade-check.sh dry-run-light \
  --upstream-ref refs/remotes/upstream/main \
  --artifact-dir /safe/output/directory

scripts/fleet-ws-upgrade-check.sh dry-run-full \
  --upstream-ref refs/remotes/upstream/main \
  --artifact-dir /safe/output/directory
```

Both modes refuse a dirty source checkout. `dry-run-light` runs the focused 99
runtime contracts, plugin SDK declaration build, and core type check.
`dry-run-full` runs the same gates and the full `pnpm build`. The script checks
source HEAD and status again during cleanup and fails if either changed.

The script deliberately does not fetch. Fetch in a disposable checkout or CI
checkout first, then pass the resulting local upstream ref.

## Gate roles

The fleet uses two complementary roles rather than treating a production host
as a build machine:

- **M5 build role:** run `dry-run-full`, retain the logs and hashed source
  artifact, and perform cumulative review. This is the authoritative heavy
  compile/build result for a candidate commit.
- **DJVM light-gate role:** before installation, run or consume the exact
  `dry-run-light` candidate result, verify the expected SHA-256, inspect current
  config without printing secrets, and confirm rollback material exists. It is
  a canary and acceptance host, not the place to repair or rebase source.

A light gate cannot replace the M5 full build. A successful M5 build cannot
replace DJVM's proxy-path and runtime acceptance.

## Transport invariants

Every rebase and conflict resolution must preserve all of these properties:

1. WebSocket use by a custom Responses provider requires an explicit
   `supportsResponsesWebSocket` compatibility opt-in propagated through config,
   catalog normalization, registry parsing, and the runtime host.
2. Custom endpoints must use HTTPS and the exact supported `/v1` API root.
3. Custom-provider sockets are transient. They do not reuse upstream OpenAI
   cached-continuation behavior and do not send `previous_response_id`.
4. Per-request headers and rotating credentials are resolved at connection time
   with the same precedence as HTTP Responses requests. Proxy credentials must
   never be forwarded to the destination provider.
5. Explicit and environment proxy routes must preserve `NO_PROXY`, proxy
   authentication, HTTP CONNECT behavior, and destination TLS verification.
   Unsupported proxy-side TLS or an unusable configured route fails closed.
6. Abort and timeout signals must interrupt connection setup and pending reads.
   `response.failed` and `response.incomplete` are terminal failures.
7. Fallback is allowed only before a `response.create` frame has been accepted
   for sending. After send, a transport failure must not replay model input,
   switch to SSE, or repeat a tool side effect.

A correct final answer is not transport evidence. Acceptance must observe the
WebSocket path and the absence of replay/fallback.

## Artifact identity and hashing

Each dry run prints:

- source and upstream commit IDs;
- rebased candidate commit and tree IDs;
- SHA-256 of a deterministic `git archive` of the candidate.

With `--artifact-dir`, it also writes the archive and a sibling `.sha256`
manifest. Store the gate log with those files. Before staging, verify the
manifest with the platform SHA-256 tool and record:

```text
upstream commit
maintenance source commit
rebased candidate commit and tree
candidate archive SHA-256
built package or installation artifact SHA-256
```

Hash the actual deployable package separately after packaging. The source
archive hash proves source identity; it does not prove that an independently
built binary or package is identical. Never accept a filename, version string,
or branch name as artifact identity.

## Staged deployment

1. **Freeze the candidate.** Record all commit IDs and hashes. Do not deploy a
   moving branch name.
2. **Prepare rollback.** Record the currently installed version and hash, back
   up the existing package and redacted configuration, and verify the rollback
   package can be read.
3. **Run M5 full gate.** Require the script tests, 99 focused runtime tests,
   plugin SDK declarations, core type check, full build, focused lint/format,
   changed-path security scan, and cumulative review.
4. **Run DJVM light gate.** Verify the candidate hash and focused gates in an
   isolated directory. Do not modify the active installation yet.
5. **Stage the package.** Install the frozen candidate without changing model or
   proxy policy. Compare installed files or package hash with the approved
   artifact.
6. **Restart externally.** Use the fleet's approved external service manager.
   Never restart from this script or from inside the process being replaced.
7. **Run acceptance.** Keep the canary only if every acceptance item below
   passes. Otherwise roll back immediately.
8. **Observe.** Hold the canary through the agreed observation window before
   promoting the same hashed artifact elsewhere.

## Acceptance

Acceptance evidence must show all of the following without exposing secrets:

- configured custom models retain the explicit WebSocket capability;
- the selected provider resolves to the expected HTTPS `/v1` base and transient
  WebSocket transport;
- a one-hop request produces a WebSocket timing/transport event and no Responses
  SSE request;
- a two-hop tool loop produces exactly two model requests and one tool side
  effect, with no duplicate request, replay, or fallback;
- the connection uses the intended CONNECT proxy route, honors `NO_PROXY`, and
  does not leak proxy authorization to the destination;
- a pre-send connection failure fails safely according to the configured
  policy, while a post-send failure never falls back or replays;
- health checks and configured messaging channels recover after the external
  restart;
- unrelated local-model and provider settings remain unchanged.

Redact tokens, authorization headers, cookies, internal addresses, and full
configuration files from logs and artifacts.

## Rollback

Rollback on any hash mismatch, missing invariant, failed health check, duplicate
tool side effect, unexpected SSE request, proxy bypass, or secret-bearing log.

1. Stop promotion and preserve the failed candidate logs.
2. Restore the exact previously hashed package and configuration backup.
3. Restart through the approved external service manager.
4. Confirm the previous version/hash, health, channels, and known-good transport
   behavior.
5. Leave the maintenance branch and failed artifact unchanged for diagnosis. Do
   not repair source in the live installation directory.

If the maintenance branch does not pass all gates against the selected upstream
commit, continue running the last accepted version. Upstream freshness alone is
never an upgrade approval.
