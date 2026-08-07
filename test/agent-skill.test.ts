import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = resolve(root, "skills/worktrellis");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(skillRoot, relativePath), "utf8");
}

describe("WorkTrellis agent skill", () => {
  it("keeps agent guides mirrored and requires documentation skill review", async () => {
    const agents = await readFile(resolve(root, "AGENTS.md"), "utf8");
    const claude = await readFile(resolve(root, "CLAUDE.md"), "utf8");

    expect(claude).toBe(agents);
    expect(agents).toContain("Every change to `README.md`, `docs/`, examples");
    expect(agents).toContain("must be evaluated for skill impact");
    expect(agents).toContain("agent-skill regression tests in the same");
  });

  it("has portable skill metadata and no unfinished placeholders", async () => {
    const skill = await read("SKILL.md");
    const normalizedSkill = skill.replaceAll("\r\n", "\n");
    const frontmatter = normalizedSkill.match(/^---\n([\s\S]*?)\n---\n/);

    expect(frontmatter?.[1]).toMatch(/^name: worktrellis$/m);
    expect(frontmatter?.[1]).toMatch(/^description: .+$/m);
    expect(frontmatter?.[1]).not.toMatch(/^metadata:/m);
    expect(normalizedSkill).not.toContain("[TODO");
  });

  it("keeps every linked reference inside the installable skill", async () => {
    const skill = await read("SKILL.md");
    const references = [
      ...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g),
    ].map((match) => match[1]!);

    expect(new Set(references).size).toBe(5);

    for (const reference of new Set(references)) {
      await expect(read(reference)).resolves.toContain("# ");
    }
  });

  it("provides Codex interface metadata with an invocable default prompt", async () => {
    const metadata = await read("agents/openai.yaml");

    expect(metadata).toContain('display_name: "WorkTrellis"');
    expect(metadata).toContain("$worktrellis");
  });

  it("teaches safe machine-stack lineage decisions", async () => {
    const skill = await read("SKILL.md");
    const configuration = await read("references/configuration.md");
    const troubleshooting = await read("references/troubleshooting.md");

    expect(skill).toContain("services variants <stack>");
    expect(skill).toContain("services reconcile <stack> --from <compose-project>");
    expect(skill).toContain("--new-variant <stack>");
    expect(skill).toContain("exits with code `4`");
    expect(skill).toContain("services down --variant <compose-project>");
    expect(configuration).toContain("volumeDataVersions");
    expect(troubleshooting).toMatch(/There is no\s+force flag/);
    expect(troubleshooting).toContain("never delete the unselected variant");
  });

  it("teaches machine-local Docker context endpoint mappings", async () => {
    const skill = await read("SKILL.md");
    const configuration = await read("references/configuration.md");
    const setup = await read("references/setup-workflow.md");
    const boundaries = await read("references/responsibility-boundaries.md");
    const troubleshooting = await read("references/troubleshooting.md");
    const validation = await read("references/validation.md");

    expect(skill).toContain("worktrellis services endpoint show");
    expect(skill).toContain("Docker API endpoint");
    expect(configuration).toContain("--bind-address");
    expect(configuration).toContain("--connect-host");
    expect(configuration).toContain("WORKTRELLIS_HOME");
    expect(setup).toContain("Prefer an exact bind address");
    expect(boundaries).toContain("Container-engine endpoint boundary");
    expect(boundaries).toContain("VM lifecycle");
    expect(troubleshooting).toContain("If the mapping is stale");
    expect(validation).toContain("port-conflict checks");
  });

  it("documents a copyable skills CLI installation command", async () => {
    const readme = await readFile(resolve(root, "README.md"), "utf8");

    expect(readme).toContain(
      "npx skills add d0lb33/WorkTrellis --skill worktrellis",
    );
  });
});
