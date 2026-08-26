// Fleet WebSocket upgrade script tests cover read-only source safety and freshness detection.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts/fleet-ws-upgrade-check.sh");
const tempRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture(options: { stale: boolean }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fleet-ws-upgrade-test-"));
  tempRoots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fleet-test@example.invalid"]);
  git(root, ["config", "user.name", "Fleet Test"]);
  fs.writeFileSync(path.join(root, "fixture.txt"), "base\n");
  git(root, ["add", "fixture.txt"]);
  git(root, ["commit", "-qm", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);

  git(root, ["switch", "-qc", "fleet/responses-websocket"]);
  fs.appendFileSync(path.join(root, "fixture.txt"), "maintenance\n");
  git(root, ["commit", "-qam", "maintenance"]);

  if (options.stale) {
    git(root, ["switch", "-q", "--detach", base]);
    fs.writeFileSync(path.join(root, "upstream.txt"), "new upstream\n");
    git(root, ["add", "upstream.txt"]);
    git(root, ["commit", "-qm", "upstream"]);
    git(root, ["update-ref", "refs/remotes/upstream/main", "HEAD"]);
    git(root, ["switch", "-q", "fleet/responses-websocket"]);
  } else {
    git(root, ["update-ref", "refs/remotes/upstream/main", base]);
  }

  return root;
}

function snapshotSource(source: string): { head: string; status: string } {
  return {
    head: git(source, ["rev-parse", "HEAD"]),
    status: git(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("fleet-ws-upgrade-check", () => {
  it("reports a maintenance branch that contains the selected upstream ref as current", () => {
    const source = createFixture({ stale: false });
    const before = snapshotSource(source);
    const result = spawnSync(
      "bash",
      [scriptPath, "status", "--source", source, "--upstream-ref", "refs/remotes/upstream/main"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("state=current");
    expect(snapshotSource(source)).toEqual(before);
  });

  it("reports a maintenance branch that does not contain the selected upstream ref as stale", () => {
    const source = createFixture({ stale: true });
    const before = snapshotSource(source);
    const result = spawnSync(
      "bash",
      [scriptPath, "status", "--source", source, "--upstream-ref", "refs/remotes/upstream/main"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(3);
    expect(result.stdout).toContain("state=stale");
    expect(snapshotSource(source)).toEqual(before);
  });

  it("keeps source HEAD and status unchanged when an isolated light dry run fails", () => {
    const source = createFixture({ stale: true });
    const before = snapshotSource(source);
    const result = spawnSync(
      "bash",
      [
        scriptPath,
        "dry-run-light",
        "--source",
        source,
        "--upstream-ref",
        "refs/remotes/upstream/main",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("isolated_checkout=");
    expect(snapshotSource(source)).toEqual(before);
  });
});
