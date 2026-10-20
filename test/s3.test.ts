import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResourceDeprovisionContext, S3Bucket } from "../src/types";

const s3State = vi.hoisted(() => ({
  exists: true,
  versioning: undefined as string | undefined,
  objects: [] as Array<{ Key: string; Size: number }>,
  pageSize: 2,
  sent: [] as string[],
}));

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class HeadBucketCommand extends Command {}
  class CreateBucketCommand extends Command {}
  class GetBucketVersioningCommand extends Command {}
  class ListObjectsV2Command extends Command {}
  class DeleteObjectsCommand extends Command {}
  class DeleteBucketCommand extends Command {}

  class S3Client {
    async send(command: Command) {
      const name = command.constructor.name;
      s3State.sent.push(name);
      if (name === "HeadBucketCommand") {
        if (!s3State.exists) {
          throw Object.assign(new Error("not found"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        return {};
      }
      if (name === "GetBucketVersioningCommand") {
        return { Status: s3State.versioning };
      }
      if (name === "ListObjectsV2Command") {
        const start = Number(command.input.ContinuationToken ?? 0);
        const end = start + s3State.pageSize;
        return {
          Contents: s3State.objects.slice(start, end),
          IsTruncated: end < s3State.objects.length,
          NextContinuationToken: String(end),
        };
      }
      if (name === "DeleteObjectsCommand") {
        const keys = (
          command.input.Delete as { Objects: Array<{ Key: string }> }
        ).Objects.map((object) => object.Key);
        s3State.objects = s3State.objects.filter((object) => !keys.includes(object.Key));
        return { Errors: [] };
      }
      if (name === "DeleteBucketCommand") {
        s3State.exists = false;
        return {};
      }
      return {};
    }
  }

  return {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    GetBucketVersioningCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    DeleteBucketCommand,
  };
});

import { s3Bucket } from "../src/resources";

const adapter = s3Bucket({
  endpoint: { stack: "infrastructure", port: "s3" },
  isolation: "bucket",
  accessKey: "access",
  secretKey: "secret",
});

const resource: S3Bucket = {
  endpoint: "http://127.0.0.1:9000",
  bucket: "shop-feature-deadbeef",
  accessKey: "access",
  secretKey: "secret",
  region: "us-east-1",
};

function context(dryRun: boolean): ResourceDeprovisionContext {
  return {
    dryRun,
    workspace: {
      root: "/gone",
      repoKey: "repo",
      isLinkedWorktree: false,
      branch: null,
      head: "unknown",
      project: "shop",
      slug: "feature-deadbeef",
      fingerprint: "deadbeef",
      ports: {},
    },
    compose: { host: "127.0.0.1", stacks: {}, url: () => "" },
    endpoint: {
      stack: "infrastructure",
      port: "s3",
      host: "127.0.0.1",
      hostPort: 9000,
      url: () => "http://127.0.0.1:9000",
    },
    baseEnv: {},
  };
}

beforeEach(() => {
  s3State.exists = true;
  s3State.versioning = undefined;
  s3State.objects = [
    { Key: "a", Size: 10 },
    { Key: "b", Size: 20 },
    { Key: "c", Size: 30 },
  ];
  s3State.sent.length = 0;
});

describe("WorkTrellis bucket pruning", () => {
  it("reports an absent bucket", async () => {
    s3State.exists = false;
    await expect(adapter.deprovision!(resource, context(false))).resolves.toEqual({
      status: "absent",
    });
  });

  it("sizes every page of objects in a dry run without deleting", async () => {
    await expect(adapter.deprovision!(resource, context(true))).resolves.toEqual({
      status: "would-remove",
      bytes: 60,
      detail: "3 object(s)",
    });
    expect(s3State.sent).not.toContain("DeleteObjectsCommand");
    expect(s3State.sent).not.toContain("DeleteBucketCommand");
  });

  it("empties and deletes the bucket", async () => {
    await expect(adapter.deprovision!(resource, context(false))).resolves.toEqual({
      status: "removed",
      bytes: 60,
      detail: "3 object(s)",
    });
    expect(s3State.objects).toEqual([]);
    expect(s3State.exists).toBe(false);
  });

  it("refuses a versioned bucket", async () => {
    s3State.versioning = "Enabled";
    await expect(adapter.deprovision!(resource, context(false))).resolves.toEqual({
      status: "refused",
      detail: "bucket versioning is enabled",
    });
    expect(s3State.sent).not.toContain("DeleteObjectsCommand");
  });
});
