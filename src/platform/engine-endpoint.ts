import net from "node:net";
import { domainToASCII } from "node:url";

import { WorkTrellisError, usageError } from "../core/errors";
import {
  readMachineConfig,
  writeMachineConfig,
  type MachineConfig,
} from "../core/state";
import { sha256 } from "../util/hash";
import {
  engineContext,
  type ContainerEngine,
  type DockerContextInfo,
} from "./engine";

export interface EngineEndpoint {
  contextName: string | null;
  endpointFingerprint: string | null;
  bindAddress: string;
  connectHost: string;
  isRemote: boolean;
  configured: boolean;
  stale: boolean;
}

const LOOPBACK = "127.0.0.1";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function fingerprint(endpoint: string): string {
  return sha256(endpoint);
}

export function normalizeBindAddress(value: string): string {
  const normalized = value.trim();
  if (net.isIP(normalized) === 0) {
    usageError("`--bind-address` must be an IPv4 or IPv6 address.");
  }
  return normalized;
}

export function normalizeConnectHost(value: string): string {
  const normalized = value.trim();
  if (!normalized) usageError("`--connect-host` must not be empty.");
  if (normalized === "0.0.0.0" || normalized === "::") {
    usageError("`--connect-host` must be a reachable host, not a wildcard address.");
  }
  if (net.isIP(normalized) !== 0) return normalized;
  if (
    normalized.includes("://") ||
    normalized.includes("/") ||
    normalized.includes(":") ||
    /\s/.test(normalized)
  ) {
    usageError(
      "`--connect-host` must be a hostname or IP address without a scheme, port, or path.",
    );
  }
  const ascii = domainToASCII(normalized.toLowerCase());
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.split(".").some((label) =>
      label.length === 0 || label.length > 63 || !DNS_LABEL.test(label)
    )
  ) {
    usageError("`--connect-host` must be a valid DNS hostname or IP address.");
  }
  return ascii;
}

export function hostForUrl(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

export function isWildcardAddress(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

export function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

export async function inspectEngineEndpoint(
  engine: ContainerEngine,
): Promise<EngineEndpoint> {
  const context = await engineContext(engine);
  if (!context) {
    return {
      contextName: null,
      endpointFingerprint: null,
      bindAddress: LOOPBACK,
      connectHost: LOOPBACK,
      isRemote: false,
      configured: false,
      stale: false,
    };
  }

  return endpointForDockerContext(context, readMachineConfig());
}

export function endpointForDockerContext(
  context: DockerContextInfo,
  machine: MachineConfig,
): EngineEndpoint {
  const endpointFingerprint = fingerprint(context.endpoint);
  const configured = machine.dockerContexts?.[context.name];
  if (!configured) {
    return {
      contextName: context.name,
      endpointFingerprint,
      bindAddress: LOOPBACK,
      connectHost: LOOPBACK,
      isRemote: context.isRemote,
      configured: false,
      stale: false,
    };
  }

  return {
    contextName: context.name,
    endpointFingerprint,
    bindAddress: normalizeBindAddress(configured.bindAddress),
    connectHost: normalizeConnectHost(configured.connectHost),
    isRemote: context.isRemote,
    configured: true,
    stale: configured.endpointFingerprint !== endpointFingerprint,
  };
}

export async function resolveEngineEndpoint(
  engine: ContainerEngine,
  options: { allowStale?: boolean } = {},
): Promise<EngineEndpoint> {
  const endpoint = await inspectEngineEndpoint(engine);
  if (endpoint.stale && !options.allowStale) {
    throw new WorkTrellisError(
      `The saved service endpoint for Docker context "${endpoint.contextName}" is stale.`,
      {
        remediation:
          "The Docker context now points somewhere different. Review it, then run `worktrellis services endpoint set --bind-address <ip> --connect-host <host>` or `worktrellis services endpoint clear`.",
      },
    );
  }
  return endpoint.stale
    ? {
        ...endpoint,
        bindAddress: LOOPBACK,
        connectHost: LOOPBACK,
      }
    : endpoint;
}

export async function setActiveDockerEndpoint(options: {
  engine: ContainerEngine;
  bindAddress: string;
  connectHost: string;
}): Promise<EngineEndpoint> {
  if (options.engine.name !== "docker") {
    usageError("Service endpoint mappings currently require Docker contexts.");
  }
  const context = await engineContext(options.engine);
  if (!context) {
    usageError("The active Docker context could not be inspected.");
  }
  const bindAddress = normalizeBindAddress(options.bindAddress);
  const connectHost = normalizeConnectHost(options.connectHost);
  const machine = readMachineConfig();
  machine.dockerContexts = {
    ...machine.dockerContexts,
    [context.name]: {
      endpointFingerprint: fingerprint(context.endpoint),
      bindAddress,
      connectHost,
    },
  };
  writeMachineConfig(machine);
  return {
    contextName: context.name,
    endpointFingerprint: fingerprint(context.endpoint),
    bindAddress,
    connectHost,
    isRemote: context.isRemote,
    configured: true,
    stale: false,
  };
}

export async function clearActiveDockerEndpoint(
  engine: ContainerEngine,
): Promise<string> {
  if (engine.name !== "docker") {
    usageError("Service endpoint mappings currently require Docker contexts.");
  }
  const context = await engineContext(engine);
  if (!context) usageError("The active Docker context could not be inspected.");
  const machine = readMachineConfig();
  if (machine.dockerContexts?.[context.name]) {
    const dockerContexts: NonNullable<MachineConfig["dockerContexts"]> = {
      ...machine.dockerContexts,
    };
    delete dockerContexts[context.name];
    machine.dockerContexts = dockerContexts;
    writeMachineConfig(machine);
  }
  return context.name;
}
