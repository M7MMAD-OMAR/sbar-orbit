import { expect, test } from "bun:test";

test("source CI keeps all platform contracts mandatory and pins its toolchain", async () => {
  const workflow = await Bun.file(".github/workflows/verify-native.yml").text();
  expect(workflow).toContain("os: [ubuntu-24.04, windows-latest, macos-15-intel]");
  expect(workflow).toContain("fail-fast: false");
  expect(workflow.match(/bun-version: 1\.3\.14/g)).toHaveLength(2);
  expect(workflow).toContain("bun run verify:platform-contracts");
  expect(workflow).not.toContain("continue-on-error");
});

test("release build validates workflow and source commits independently before project tooling", async () => {
  const workflow = await Bun.file(".github/workflows/package-release.yml").text();
  expect(workflow).toContain("DISPATCH_REF: ${{ github.ref }}");
  expect(workflow).toContain('[[ "$DISPATCH_REF" == refs/heads/main ]]');
  expect(workflow).toContain('test "$(git cat-file -t "$WORKFLOW_REF")" = commit');
  expect(workflow).toContain('git merge-base --is-ancestor "$WORKFLOW_REF" refs/remotes/origin/main');
  expect(workflow).toContain('git merge-base --is-ancestor "$SOURCE_REF" refs/remotes/origin/main');
  expect(workflow.indexOf('git merge-base --is-ancestor "$WORKFLOW_REF"')).toBeLessThan(workflow.indexOf("bun run verify"));
  expect(workflow).toContain("contents: read");
});
