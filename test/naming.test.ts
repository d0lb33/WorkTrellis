import { describe, expect, it } from "vitest";

import {
  buildBucketName,
  buildDatabaseName,
  buildRedisPrefix,
  buildSlug,
  buildTemplateDatabaseName,
  assertProjectName,
  sanitizeLabel,
} from "../src/core/naming";
import { serializeEnv } from "../src/util/dotenv";

/**
 * These guard the isolation guarantee: two worktrees must never derive the same
 * database, bucket, or Redis namespace. A regression here would let one
 * checkout silently read and write another's data.
 */
describe("WorkTrellis naming", () => {
  describe("slug derivation", () => {
    it("keeps branches whose last segment collides distinct", () => {
      // The exact case a branch-name-derived scheme gets wrong: both of these
      // reduce to the label "deploy", so only the path fingerprint separates
      // them.
      const alice = buildSlug("deploy", "dec5813a");
      const bob = buildSlug("deploy", "893720ac");

      expect(alice).not.toBe(bob);
      expect(buildDatabaseName("stars-local", alice)).not.toBe(
        buildDatabaseName("stars-local", bob),
      );
      expect(buildBucketName("stars-local", alice)).not.toBe(
        buildBucketName("stars-local", bob),
      );
      expect(buildRedisPrefix("stars-local", alice)).not.toBe(
        buildRedisPrefix("stars-local", bob),
      );
    });

    it("does not special-case the default branch", () => {
      // Two clones both sitting on main still need distinct resources.
      expect(buildSlug("main", "11111111")).not.toBe(
        buildSlug("main", "22222222"),
      );
    });

    it("produces valid DNS labels from hostile branch names", () => {
      const slug = buildSlug(
        sanitizeLabel("---Feature/Foo_Bar!! 42---"),
        "abcdef12",
      );
      expect(slug).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
      expect(slug.length).toBeLessThanOrEqual(63);
    });
  });

  describe("derived resource names", () => {
    const slug = buildSlug("windowssupport", "829b3284");

    it("builds a valid Postgres identifier", () => {
      const name = buildDatabaseName("stars-local", slug);
      expect(name).toBe("stars_local_windowssupport_829b3284");
      expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(name.length).toBeLessThanOrEqual(63);
    });

    it("builds a valid S3 bucket name with no dots", () => {
      const name = buildBucketName("stars-local", slug);
      expect(name).toBe("stars-local-windowssupport-829b3284");
      expect(name).not.toContain(".");
      expect(name.length).toBeGreaterThanOrEqual(3);
      expect(name.length).toBeLessThanOrEqual(63);
    });

    it("preserves the fingerprint when a name must be truncated", () => {
      // Long label plus a long project must still end in the unique token,
      // because truncating that is what would cause a collision.
      const longSlug = buildSlug("a".repeat(20), "deadbeef");
      const database = buildDatabaseName("abcdefghijklmnopqrst", longSlug);
      const bucket = buildBucketName("abcdefghijklmnopqrst", longSlug);

      expect(database.endsWith("deadbeef")).toBe(true);
      expect(database.length).toBeLessThanOrEqual(63);
      expect(bucket.endsWith("deadbeef")).toBe(true);
      expect(bucket.length).toBeLessThanOrEqual(63);
    });

    it("wraps the Redis prefix in a single hash slot with no trailing separator", () => {
      // Queue libraries append their own ":"; a trailing one here produces
      // "prefix::queue" keys.
      expect(buildRedisPrefix("stars-local", slug)).toBe(
        "{stars-local:windowssupport-829b3284}",
      );
    });

    it("derives a template database name per schema fingerprint", () => {
      expect(buildTemplateDatabaseName("stars-local", "9c1f0b7e2a44ff")).toBe(
        "stars_local_tpl_9c1f0b7e2a44",
      );
    });
  });

  describe("project name validation", () => {
    it("accepts every valid DNS label independent of configured adapters", () => {
      expect(() => assertProjectName("9lives")).not.toThrow();
      expect(
        buildDatabaseName("9lives", buildSlug("main", "deadbeef")),
      ).toBe("p_9lives_main_deadbeef");
      expect(() => assertProjectName("Stars_Local")).toThrow(
        /Invalid project name/i,
      );
      expect(() => assertProjectName("-leading")).toThrow(
        /Invalid project name/i,
      );
      expect(() => assertProjectName("stars-local")).not.toThrow();
    });

    it("explains the rule in the remediation, not just the message", () => {
      // The CLI prints `remediation` under the message; a bare "invalid name"
      // with no stated rule is the failure mode this guards against.
      try {
        assertProjectName("Stars_Local");
        throw new Error("expected assertProjectName to throw");
      } catch (caught) {
        expect((caught as { remediation?: string }).remediation).toMatch(
          /DNS label/i,
        );
      }
    });
  });
});

describe("WorkTrellis env snapshot", () => {
  it("omits empty values instead of writing them", () => {
    // An empty value is an instruction to delete the variable in some loaders,
    // which would unset something the secrets file legitimately provided.
    const output = serializeEnv({ SET: "value", EMPTY: "", MISSING: undefined });

    expect(output).toContain('SET="value"');
    expect(output).not.toContain("EMPTY");
    expect(output).not.toContain("MISSING");
  });

  it("refuses values whose meaning depends on the parser", () => {
    // Node's --env-file parser and dotenv disagree about escaped quotes and
    // embedded newlines, so WorkTrellis will not emit them at all.
    expect(() => serializeEnv({ BAD: 'has "quotes"' })).toThrow(/quote/i);
    expect(() => serializeEnv({ BAD: "has\nnewline" })).toThrow(/newline/i);
  });

  it("emits keys sorted and double-quoted", () => {
    const output = serializeEnv({ ZULU: "1", ALPHA: "2" });
    expect(output).toBe('ALPHA="2"\nZULU="1"\n');
  });
});
