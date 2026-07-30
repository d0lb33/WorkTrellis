import type { ServiceSpec } from "../types";
import { WorkTrellisError } from "../core/errors";
import { sha256 } from "../util/hash";

/**
 * Compose files are generated rather than checked in, for two reasons: the
 * shared stack lives outside any repository (several projects share it), and
 * the file must be derived from the service specs so a spec change is detected
 * and applied rather than silently ignored.
 *
 * One compose project per service kind and major version, so two projects that
 * need different major versions get genuinely separate stacks and volumes.
 */

export interface ResolvedPorts {
  [name: string]: number;
}

export interface RenderedStack {
  stackId: string;
  kind: ServiceSpec["kind"];
  yaml: string;
  /** Published host ports by role, e.g. { api: 9000, console: 9001 }. */
  ports: ResolvedPorts;
  /** Digest of the inputs; a change means the stack must be recreated. */
  specHash: string;
}

/**
 * Identity of a shared stack.
 *
 * Two projects share a container only when their service definitions actually
 * match. Keying on kind and major version alone was not enough: differing
 * credentials, images, or server arguments would resolve to the same stack, and
 * the second project would then be handed endpoints describing a configuration
 * that is not the one running.
 *
 * Including a digest of the full definition means a divergent project gets its
 * own stack — and, because it wants the same well-known port, the port-owner
 * check reports the collision instead of silently connecting to the wrong
 * server.
 */
export function legacyStackIdFor(spec: ServiceSpec): string {
  const version = "version" in spec && spec.version ? spec.version : "latest";
  const major = String(version).split(".")[0] ?? "latest";

  // `devstack-*` is a persisted pre-release identifier. It intentionally stays
  // stable across the product rename so existing Compose volumes are reused.
  return spec.kind === "minio" || spec.kind === "mailpit"
    ? `devstack-${spec.kind}`
    : `devstack-${spec.kind}-${major}`;
}

export function stackIdFor(spec: ServiceSpec, ports?: ResolvedPorts): string {
  const base = legacyStackIdFor(spec);
  if (!ports) return base;

  // Sorted keys so an equivalent definition always digests identically.
  // Machine-level port overrides are intentionally excluded: changing a host
  // port must reconfigure this stack, not strand its existing data volume under
  // a new Compose project name. Ports declared by a project remain part of the
  // spec and therefore still participate in compatibility.
  const identity = JSON.stringify({
    spec: Object.fromEntries(
      Object.entries(spec as unknown as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  });

  return `${base}-${sha256(identity).slice(0, 8)}`;
}

// --- tiny deterministic YAML emitter -------------------------------------
// The output shape is fixed and fully controlled here, so a YAML dependency
// would buy nothing. Only the constructs used below are supported.

type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

function emit(value: YamlValue, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    return value.map((entry) => `${pad}- ${scalar(entry)}`).join("\n");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, child]) => {
        if (Array.isArray(child)) {
          if (child.length === 0) return `${pad}${key}: []`;
          return `${pad}${key}:\n${emit(child, indent + 1)}`;
        }
        if (typeof child === "object") {
          return `${pad}${key}:\n${emit(child, indent + 1)}`;
        }
        return `${pad}${key}: ${scalar(child)}`;
      })
      .join("\n");
  }

  return `${pad}${scalar(value)}`;
}

function scalar(value: YamlValue): string {
  if (Array.isArray(value) || typeof value === "object") {
    // Only reached for arrays nested directly in arrays, which nothing emits.
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    // Quote everything: it is always valid, and it stops values like `on`,
    // `5432:5432`, and `no` from being reinterpreted by the YAML parser.
    return JSON.stringify(value);
  }
  return String(value);
}

// --- per-kind service definitions ----------------------------------------

function publish(port: number, containerPort: number): string {
  // Bind to loopback so a dev stack is never exposed on the network.
  return `127.0.0.1:${port}:${containerPort}`;
}

function renderService(
  spec: ServiceSpec,
  ports: ResolvedPorts,
): { service: Record<string, YamlValue>; volumes: string[] } {
  switch (spec.kind) {
    case "postgres": {
      const service: Record<string, YamlValue> = {
        image: spec.image ?? `postgres:${spec.version}-alpine`,
        restart: "unless-stopped",
        environment: {
          POSTGRES_USER: spec.superuser ?? "postgres",
          POSTGRES_PASSWORD: spec.password ?? "postgres",
          // WorkTrellis creates a database per workspace; this is only the
          // bootstrap database the superuser connects to.
          POSTGRES_DB: "postgres",
        },
        ports: [publish(ports.main!, 5432)],
        volumes: ["data:/var/lib/postgresql/data"],
        healthcheck: {
          test: `pg_isready -U ${spec.superuser ?? "postgres"}`,
          interval: "5s",
          timeout: "3s",
          retries: 10,
        },
      };

      if (spec.serverArgs?.length) {
        service.command = [
          "postgres",
          ...spec.serverArgs.flatMap((arg) => ["-c", arg]),
        ];
      }

      return { service, volumes: ["data"] };
    }

    case "redis":
      return {
        service: {
          image: spec.image ?? `redis:${spec.version}-alpine`,
          restart: "unless-stopped",
          ports: [publish(ports.main!, 6379)],
          volumes: ["data:/data"],
          healthcheck: {
            test: "redis-cli ping",
            interval: "5s",
            timeout: "3s",
            retries: 10,
          },
        },
        volumes: ["data"],
      };

    case "minio":
      return {
        service: {
          image: spec.image ?? "minio/minio:latest",
          restart: "unless-stopped",
          command: ["server", "/data", "--console-address", ":9001"],
          environment: {
            MINIO_ROOT_USER: spec.rootUser ?? "minioadmin",
            MINIO_ROOT_PASSWORD: spec.rootPassword ?? "minioadmin",
          },
          ports: [publish(ports.api!, 9000), publish(ports.console!, 9001)],
          volumes: ["data:/data"],
          healthcheck: {
            // The image has no shell utilities to rely on, but it does ship mc.
            test: "mc ready local",
            interval: "5s",
            timeout: "3s",
            retries: 20,
          },
        },
        volumes: ["data"],
      };

    case "mailpit":
      return {
        service: {
          image: spec.image ?? "axllent/mailpit:latest",
          restart: "unless-stopped",
          environment: {
            MP_SMTP_AUTH_ACCEPT_ANY: "1",
            MP_SMTP_AUTH_ALLOW_INSECURE: "1",
          },
          ports: [publish(ports.smtp!, 1025), publish(ports.ui!, 8025)],
        },
        volumes: [],
      };

    default: {
      const exhaustive: never = spec;
      throw new WorkTrellisError(
        `Unsupported service kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

export function renderStack(
  spec: ServiceSpec,
  ports: ResolvedPorts,
): RenderedStack {
  return renderStackWithId(spec, ports, stackIdFor(spec, ports));
}

/**
 * Definition used by pre-release versions that predate configuration-hashed stack
 * IDs. A matching legacy stack is reused so an upgrade keeps its existing
 * volume and databases; incompatible legacy definitions are never adopted.
 */
export function renderLegacyStack(
  spec: ServiceSpec,
  ports: ResolvedPorts,
): RenderedStack {
  return renderStackWithId(spec, ports, legacyStackIdFor(spec));
}

function renderStackWithId(
  spec: ServiceSpec,
  ports: ResolvedPorts,
  stackId: string,
): RenderedStack {
  const { service, volumes } = renderService(spec, ports);

  const document: Record<string, YamlValue> = {
    name: stackId,
    services: { [spec.kind]: service },
  };

  if (volumes.length > 0) {
    document.volumes = Object.fromEntries(
      volumes.map((name) => [name, {}]),
    ) as YamlValue;
  }

  const yaml = `${[
    // Kept byte-for-byte stable so legacy definitions still pass the
    // compatibility check and retain their existing volumes.
    "# Generated by devstack. Do not edit: rewritten whenever the service spec changes.",
    emit(document),
  ].join("\n")}\n`;

  return {
    stackId,
    kind: spec.kind,
    yaml,
    ports,
    specHash: sha256(yaml).slice(0, 16),
  };
}
