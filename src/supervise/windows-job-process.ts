import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import type * as Koffi from "koffi";

import { WorkTrellisError } from "../core/errors";
import type {
  ManagedProcess,
  ManagedProcessOptions,
} from "./managed-process";

const CREATE_SUSPENDED = 0x00000004;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_NO_WINDOW = 0x08000000;
const STARTF_USESTDHANDLES = 0x00000100;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const STILL_ACTIVE = 259;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xffffffff;

interface WindowsBindings {
  koffi: typeof Koffi;
  SECURITY_ATTRIBUTES: Koffi.TypeObject;
  STARTUPINFO: Koffi.TypeObject;
  EXTENDED_LIMITS: Koffi.TypeObject;
  CreateJobObjectW: (...args: unknown[]) => unknown;
  SetInformationJobObject: (...args: unknown[]) => boolean;
  AssignProcessToJobObject: (...args: unknown[]) => boolean;
  TerminateJobObject: (...args: unknown[]) => boolean;
  TerminateProcess: (...args: unknown[]) => boolean;
  CreateFileW: (...args: unknown[]) => unknown;
  CreateProcessW: (...args: unknown[]) => boolean;
  ResumeThread: (...args: unknown[]) => number;
  WaitForSingleObject: (...args: unknown[]) => number;
  GetExitCodeProcess: (...args: unknown[]) => boolean;
  GetLastError: () => number;
  CloseHandle: (handle: unknown) => boolean;
}

interface OutputPipe {
  path: string;
  server: net.Server;
  stream: PassThrough;
  close(): void;
}

let bindingsPromise: Promise<WindowsBindings> | null = null;

async function loadWindowsBindings(): Promise<WindowsBindings> {
  if (bindingsPromise) return bindingsPromise;
  bindingsPromise = import("koffi").then((module) => createBindings(module));
  try {
    return await bindingsPromise;
  } catch (caught) {
    bindingsPromise = null;
    throw new WorkTrellisError(
      `Windows process isolation could not load its native runtime: ${errorMessage(caught)}. Reinstall worktrellis for this Windows architecture.`,
    );
  }
}

function createBindings(koffi: typeof Koffi): WindowsBindings {
  const kernel32 = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer(koffi.opaque());
  const SECURITY_ATTRIBUTES = koffi.struct("WT_SECURITY_ATTRIBUTES", {
    nLength: "uint32_t",
    lpSecurityDescriptor: "void *",
    bInheritHandle: "int32_t",
  });
  const STARTUPINFO = koffi.struct("WT_STARTUPINFOW", {
    cb: "uint32_t",
    lpReserved: "void *",
    lpDesktop: "void *",
    lpTitle: "void *",
    dwX: "uint32_t",
    dwY: "uint32_t",
    dwXSize: "uint32_t",
    dwYSize: "uint32_t",
    dwXCountChars: "uint32_t",
    dwYCountChars: "uint32_t",
    dwFillAttribute: "uint32_t",
    dwFlags: "uint32_t",
    wShowWindow: "uint16_t",
    cbReserved2: "uint16_t",
    lpReserved2: "void *",
    hStdInput: HANDLE,
    hStdOutput: HANDLE,
    hStdError: HANDLE,
  });
  const PROCESS_INFORMATION = koffi.struct("WT_PROCESS_INFORMATION", {
    hProcess: HANDLE,
    hThread: HANDLE,
    dwProcessId: "uint32_t",
    dwThreadId: "uint32_t",
  });
  const IO_COUNTERS = koffi.struct("WT_IO_COUNTERS", {
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  const BASIC_LIMITS = koffi.struct("WT_JOB_BASIC_LIMITS", {
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  const EXTENDED_LIMITS = koffi.struct("WT_JOB_EXTENDED_LIMITS", {
    BasicLimitInformation: BASIC_LIMITS,
    IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: "uintptr_t",
    JobMemoryLimit: "uintptr_t",
    PeakProcessMemoryUsed: "uintptr_t",
    PeakJobMemoryUsed: "uintptr_t",
  });

  return {
    koffi,
    SECURITY_ATTRIBUTES,
    STARTUPINFO,
    EXTENDED_LIMITS,
    CreateJobObjectW: kernel32.func(
      "__stdcall",
      "CreateJobObjectW",
      HANDLE,
      ["void *", "str16"],
    ),
    SetInformationJobObject: kernel32.func(
      "__stdcall",
      "SetInformationJobObject",
      "bool",
      [HANDLE, "int32_t", koffi.pointer(EXTENDED_LIMITS), "uint32_t"],
    ),
    AssignProcessToJobObject: kernel32.func(
      "__stdcall",
      "AssignProcessToJobObject",
      "bool",
      [HANDLE, HANDLE],
    ),
    TerminateJobObject: kernel32.func(
      "__stdcall",
      "TerminateJobObject",
      "bool",
      [HANDLE, "uint32_t"],
    ),
    TerminateProcess: kernel32.func("__stdcall", "TerminateProcess", "bool", [
      HANDLE,
      "uint32_t",
    ]),
    CreateFileW: kernel32.func("__stdcall", "CreateFileW", HANDLE, [
      "str16",
      "uint32_t",
      "uint32_t",
      koffi.pointer(SECURITY_ATTRIBUTES),
      "uint32_t",
      "uint32_t",
      HANDLE,
    ]),
    CreateProcessW: kernel32.func(
      "__stdcall",
      "CreateProcessW",
      "bool",
      [
        "str16",
        "void *",
        "void *",
        "void *",
        "bool",
        "uint32_t",
        "void *",
        "str16",
        koffi.pointer(STARTUPINFO),
        koffi.out(koffi.pointer(PROCESS_INFORMATION)),
      ],
    ),
    ResumeThread: kernel32.func("__stdcall", "ResumeThread", "uint32_t", [
      HANDLE,
    ]),
    WaitForSingleObject: kernel32.func(
      "__stdcall",
      "WaitForSingleObject",
      "uint32_t",
      [HANDLE, "uint32_t"],
    ),
    GetExitCodeProcess: kernel32.func(
      "__stdcall",
      "GetExitCodeProcess",
      "bool",
      [HANDLE, koffi.out(koffi.pointer("uint32_t"))],
    ),
    GetLastError: kernel32.func(
      "__stdcall",
      "GetLastError",
      "uint32_t",
      [],
    ),
    CloseHandle: kernel32.func("__stdcall", "CloseHandle", "bool", [HANDLE]),
  };
}

export async function spawnWindowsJobProcess(
  options: ManagedProcessOptions,
): Promise<ManagedProcess> {
  if (process.platform !== "win32") {
    throw new WorkTrellisError("Windows Job Objects are only available on Windows.");
  }

  const bindings = await loadWindowsBindings();
  const { stdoutPipe, stderrPipe } = await createOutputPipes();
  const inheritedHandles: unknown[] = [];
  let job: unknown = null;
  let processHandle: unknown = null;
  let threadHandle: unknown = null;

  try {
    const security = {
      nLength: bindings.koffi.sizeof(bindings.SECURITY_ATTRIBUTES),
      lpSecurityDescriptor: null,
      bInheritHandle: 1,
    };
    const stdoutHandle = openInheritedHandle(
      bindings,
      stdoutPipe.path,
      GENERIC_WRITE,
      0,
      security,
    );
    inheritedHandles.push(stdoutHandle);
    const stderrHandle = openInheritedHandle(
      bindings,
      stderrPipe.path,
      GENERIC_WRITE,
      0,
      security,
    );
    inheritedHandles.push(stderrHandle);
    const stdinHandle = openInheritedHandle(
      bindings,
      "NUL",
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      security,
    );
    inheritedHandles.push(stdinHandle);

    job = bindings.CreateJobObjectW(null, null);
    assertHandle(bindings, job, "CreateJobObjectW");
    const limits = emptyJobLimits();
    limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (
      !bindings.SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        limits,
        bindings.koffi.sizeof(bindings.EXTENDED_LIMITS),
      )
    ) {
      throw nativeError(bindings, "SetInformationJobObject");
    }

    const executable = resolveWindowsExecutable(
      options.file,
      options.cwd,
      options.env,
    );
    const commandLine = encodeWideString(
      [executable, ...options.args].map(quoteWindowsArgument).join(" "),
    );
    const environment = buildWindowsEnvironmentBlock(options.env);
    const startup = {
      cb: bindings.koffi.sizeof(bindings.STARTUPINFO),
      lpReserved: null,
      lpDesktop: null,
      lpTitle: null,
      dwX: 0,
      dwY: 0,
      dwXSize: 0,
      dwYSize: 0,
      dwXCountChars: 0,
      dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: STARTF_USESTDHANDLES,
      wShowWindow: 0,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: stdinHandle,
      hStdOutput: stdoutHandle,
      hStdError: stderrHandle,
    };
    const processInfo: Record<string, unknown> = {};
    const created = bindings.CreateProcessW(
      executable,
      bindings.koffi.as(commandLine, "char16_t *"),
      null,
      null,
      true,
      CREATE_SUSPENDED |
        CREATE_NEW_PROCESS_GROUP |
        CREATE_UNICODE_ENVIRONMENT |
        CREATE_NO_WINDOW,
      bindings.koffi.as(environment, "void *"),
      options.cwd,
      startup,
      processInfo,
    );
    if (!created) throw nativeError(bindings, "CreateProcessW");

    processHandle = processInfo.hProcess;
    threadHandle = processInfo.hThread;
    assertHandle(bindings, processHandle, "CreateProcessW process handle");
    assertHandle(bindings, threadHandle, "CreateProcessW thread handle");
    const pid = Number(processInfo.dwProcessId);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new WorkTrellisError(
        "Windows process isolation did not return a valid payload PID.",
      );
    }

    if (!bindings.AssignProcessToJobObject(job, processHandle)) {
      throw nativeError(bindings, "AssignProcessToJobObject");
    }
    const resumed = bindings.ResumeThread(threadHandle);
    if (resumed === 0xffffffff) throw nativeError(bindings, "ResumeThread");
    bindings.CloseHandle(threadHandle);
    threadHandle = null;
    for (const handle of inheritedHandles.splice(0)) bindings.CloseHandle(handle);

    return monitorWindowsProcess({
      bindings,
      pid,
      job,
      processHandle,
      stdoutPipe,
      stderrPipe,
    });
  } catch (caught) {
    if (job) bindings.TerminateJobObject(job, 1);
    if (processHandle) bindings.TerminateProcess(processHandle, 1);
    if (threadHandle) bindings.CloseHandle(threadHandle);
    if (processHandle) bindings.CloseHandle(processHandle);
    if (job) bindings.CloseHandle(job);
    for (const handle of inheritedHandles) bindings.CloseHandle(handle);
    stdoutPipe.close();
    stderrPipe.close();
    if (caught instanceof WorkTrellisError) throw caught;
    throw new WorkTrellisError(
      `Windows process isolation failed: ${errorMessage(caught)}`,
    );
  }
}

async function createOutputPipes(): Promise<{
  stdoutPipe: OutputPipe;
  stderrPipe: OutputPipe;
}> {
  let stdoutPipe: OutputPipe | null = null;
  try {
    stdoutPipe = await createOutputPipe("stdout");
    const stderrPipe = await createOutputPipe("stderr");
    return { stdoutPipe, stderrPipe };
  } catch (caught) {
    stdoutPipe?.close();
    throw new WorkTrellisError(
      `Windows process isolation could not create its output pipes: ${errorMessage(caught)}. Check the local Windows named-pipe policy and reinstall worktrellis.`,
    );
  }
}

function monitorWindowsProcess(options: {
  bindings: WindowsBindings;
  pid: number;
  job: unknown;
  processHandle: unknown;
  stdoutPipe: OutputPipe;
  stderrPipe: OutputPipe;
}): ManagedProcess {
  const errorListeners: Array<(error: Error) => void> = [];
  const exitListeners: Array<(code: number) => void> = [];
  let job = options.job;
  let processHandle = options.processHandle;
  let exited = false;

  const finish = (exitCode: number): void => {
    if (exited) return;
    exited = true;
    clearInterval(timer);
    if (job) options.bindings.CloseHandle(job);
    if (processHandle) options.bindings.CloseHandle(processHandle);
    job = null;
    processHandle = null;

    // CreateProcess exit can race the final named-pipe reads. Match the
    // observable behavior of complete child stdio by publishing exit only
    // after both streams have delivered their remaining bytes.
    void Promise.all([
      waitForOutputEnd(options.stdoutPipe.stream),
      waitForOutputEnd(options.stderrPipe.stream),
    ]).then(() => {
      for (const listener of exitListeners.splice(0)) listener(exitCode);
    });
  };

  const timer = setInterval(() => {
    if (exited) return;
    const wait = options.bindings.WaitForSingleObject(processHandle, 0);
    if (wait === WAIT_TIMEOUT) return;
    if (wait === WAIT_FAILED) {
      const caught = nativeError(options.bindings, "WaitForSingleObject");
      for (const listener of errorListeners.splice(0)) listener(caught);
      finish(1);
      return;
    }
    if (wait !== WAIT_OBJECT_0) {
      const caught = new WorkTrellisError(
        `Windows process isolation WaitForSingleObject returned unexpected status ${wait}.`,
      );
      for (const listener of errorListeners.splice(0)) listener(caught);
      finish(1);
      return;
    }

    const code = [STILL_ACTIVE];
    if (!options.bindings.GetExitCodeProcess(processHandle, code)) {
      const caught = nativeError(options.bindings, "GetExitCodeProcess");
      for (const listener of errorListeners.splice(0)) listener(caught);
      finish(1);
      return;
    }
    finish(code[0] ?? 1);
  }, 50);

  const terminate = (exitCode = 1): boolean => {
    if (exited || !job) return true;
    try {
      return options.bindings.TerminateJobObject(job, exitCode);
    } catch {
      return false;
    }
  };

  return {
    pid: options.pid,
    stdout: options.stdoutPipe.stream,
    stderr: options.stderrPipe.stream,
    onceError: (listener) => errorListeners.push(listener),
    onceExit: (listener) => exitListeners.push(listener),
    forceTerminate: terminate,
  };
}

function waitForOutputEnd(stream: PassThrough): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      stream.off("end", finish);
      stream.off("close", finish);
      resolve();
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.resume();
  });
}

async function createOutputPipe(label: string): Promise<OutputPipe> {
  const pipePath = `\\\\.\\pipe\\worktrellis-${process.pid}-${randomUUID()}-${label}`;
  const stream = new PassThrough();
  const server = net.createServer((socket) => {
    server.close();
    socket.once("error", () => stream.end());
    socket.pipe(stream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => stream.end());
  return {
    path: pipePath,
    server,
    stream,
    close: () => {
      if (server.listening) server.close();
      stream.destroy();
    },
  };
}

function openInheritedHandle(
  bindings: WindowsBindings,
  target: string,
  access: number,
  shareMode: number,
  security: Record<string, unknown>,
): unknown {
  const handle = bindings.CreateFileW(
    target,
    access,
    shareMode,
    security,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  assertHandle(bindings, handle, `CreateFileW(${target === "NUL" ? "NUL" : "pipe"})`);
  return handle;
}

function assertHandle(
  bindings: WindowsBindings,
  handle: unknown,
  operation: string,
): void {
  if (!handle) throw nativeError(bindings, operation);
  const invalid = BigInt.asUintN(bindings.koffi.sizeof("void *") * 8, -1n);
  if (bindings.koffi.address(handle) === invalid) {
    throw nativeError(bindings, operation);
  }
}

function nativeError(
  bindings: WindowsBindings,
  operation: string,
): WorkTrellisError {
  const code = bindings.GetLastError();
  return new WorkTrellisError(
    `Windows process isolation ${operation} failed: ${describeWindowsError(code)}`,
  );
}

export function describeWindowsError(code: number): string {
  const known: Record<number, string> = {
    2: "file not found",
    3: "path not found",
    5: "access denied",
    87: "invalid parameter",
    109: "pipe ended",
    126: "required module not found",
    193: "not a valid Windows executable",
    206: "path or command line is too long",
    216: "executable is for a different architecture",
    231: "all pipe instances are busy",
    740: "elevation is required",
  };
  return `${known[code] ?? "Win32 error"} (${code})`;
}

export function quoteWindowsArgument(value: string): string {
  if (value.includes("\0")) {
    throw new WorkTrellisError(
      "Windows process arguments cannot contain null characters.",
    );
  }
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function buildWindowsEnvironmentBlock(env: NodeJS.ProcessEnv): Buffer {
  const unique = new Map<string, [string, string]>();
  for (const entry of Object.entries(env)) {
    if (
      entry[1] === undefined ||
      entry[0].length === 0 ||
      (entry[0].includes("=") && !/^=[A-Za-z]:$/u.test(entry[0])) ||
      entry[0].includes("\0") ||
      entry[1].includes("\0")
    ) {
      continue;
    }
    unique.set(entry[0].toUpperCase(), entry as [string, string]);
  }

  const entries = [...unique.values()]
    .sort(([left], [right]) => compareWindowsEnvironmentNames(left, right))
    .map(([key, value]) => `${key}=${value}`);
  return Buffer.from(`${entries.join("\0")}\0\0`, "utf16le");
}

function compareWindowsEnvironmentNames(left: string, right: string): number {
  const foldedLeft = left.toUpperCase();
  const foldedRight = right.toUpperCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return 0;
}

function windowsEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const canonical = name.toUpperCase();
  let resolved: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === canonical) resolved = value;
  }
  return resolved;
}

export function resolveWindowsExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const extensions = (windowsEnvironmentValue(env, "PATHEXT") ?? ".COM;.EXE")
    .split(";")
    .map((extension) => extension.toUpperCase())
    .filter((extension) => extension === ".COM" || extension === ".EXE");
  const hasExtension = path.win32.extname(command).length > 0;
  const candidates = (base: string) =>
    hasExtension ? [base] : [base, ...extensions.map((ext) => `${base}${ext}`)];
  const explicit = command.includes("\\") || command.includes("/");
  if (explicit) {
    const base = path.win32.isAbsolute(command)
      ? command
      : path.win32.resolve(cwd, command);
    for (const candidate of candidates(base)) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } else {
    const systemRoot = windowsEnvironmentValue(env, "SystemRoot");
    const directories = [
      cwd,
      ...(systemRoot
        ? [path.win32.join(systemRoot, "System32"), systemRoot]
        : []),
      ...(windowsEnvironmentValue(env, "PATH") ?? "")
        .split(";")
        .filter(Boolean),
    ];
    for (const directory of directories) {
      for (const candidate of candidates(path.win32.join(directory, command))) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new WorkTrellisError(
    `Windows process isolation could not resolve executable ${JSON.stringify(command)} without a shell.`,
  );
}

function encodeWideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function emptyJobLimits() {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0n,
      PerJobUserTimeLimit: 0n,
      LimitFlags: 0,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0n,
      WriteOperationCount: 0n,
      OtherOperationCount: 0n,
      ReadTransferCount: 0n,
      WriteTransferCount: 0n,
      OtherTransferCount: 0n,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
