#!/usr/bin/env node

/**
 * Read-only WeChat DevTools / miniprogram-automator probe.
 *
 * Discovery and CLI help checks are safe by default. A real DevTools session is
 * attempted only when --project is supplied. The runtime result is deliberately
 * reported as evidence, not inferred from package metadata.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface CliCandidate {
  readonly path: string;
  readonly source: string;
}

interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

interface AutomatorEvidence {
  readonly packageJsonPath?: string;
  readonly entryPath?: string;
  readonly version?: string;
  readonly declarations: readonly string[];
  readonly sourceChecks: readonly string[];
}

interface RuntimeProbeResult {
  readonly attempted: boolean;
  readonly status: "VERIFIED" | "BLOCKED" | "UNKNOWN";
  readonly elapsedMs?: number;
  readonly currentPage?: unknown;
  readonly pageStack?: unknown;
  readonly screenshotPath?: string;
  readonly screenshotBytes?: number;
  readonly consoleEvents?: number;
  readonly exceptions?: number;
  readonly error?: string;
  readonly cleanupError?: string;
}

interface ProbeOptions {
  readonly cliPath?: string;
  readonly projectPath?: string;
  readonly port?: number;
  readonly timeoutMs: number;
  readonly screenshotPath?: string;
  readonly keepOpen: boolean;
  readonly json: boolean;
}

// The extension build targets CommonJS, while Node's strip-types loader may
// execute this source as ESM. Keep the safe discovery path usable in either
// mode; runtime launch is expected to run from the compiled CommonJS output.
const scriptDirectory = typeof __dirname === "string" ? __dirname : process.cwd();
const commonJsRequire: NodeRequire | undefined =
  typeof require === "function" ? require : undefined;

const macCliPaths = [
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
  "/Applications/微信开发者工具.app/Contents/MacOS/cli",
  "/Applications/WeChat DevTools.app/Contents/MacOS/cli",
];

const windowsCliPaths = [
  "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat",
  "C:/Program Files/Tencent/微信web开发者工具/cli.bat",
];

function parseOptions(argv: readonly string[]): ProbeOptions {
  let cliPath: string | undefined;
  let projectPath: string | undefined;
  let port: number | undefined;
  let timeoutMs = 30_000;
  let screenshotPath: string | undefined;
  let keepOpen = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--cli":
        cliPath = argv[++index];
        break;
      case "--project":
        projectPath = argv[++index];
        break;
      case "--port":
        port = Number(argv[++index]);
        if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
          throw new Error("--port must be an integer between 1 and 65535");
        }
        break;
      case "--timeout":
        timeoutMs = Number(argv[++index]);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          throw new Error("--timeout must be a positive integer in milliseconds");
        }
        break;
      case "--screenshot":
        screenshotPath = argv[++index];
        break;
      case "--keep-open":
        keepOpen = true;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { cliPath, projectPath, port, timeoutMs, screenshotPath, keepOpen, json };
}

function printUsage(): void {
  console.log(`Usage: node out/scripts/probe-wechat-runtime.js [options]

Safe checks (default):
  --cli <path>          Explicit DevTools CLI path
  --json                Emit a JSON report instead of human-readable output

Optional real-runtime check:
  --project <path>      Mini Program directory containing project.config.json
  --port <number>       Automation WebSocket port (default: automator chooses)
  --timeout <ms>        Launch/connect timeout (default: 30000)
  --screenshot <path>   Write captured PNG when the runtime returns one
  --keep-open           Do not close the automator project after probing
`);
}

function run(command: string, args: readonly string[], timeoutMs = 10_000): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });

  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandPath(command: string): string | undefined {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = run(lookupCommand, [command], 2_000);
  const firstLine = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine || undefined;
}

function detectCli(explicitPath?: string): { selected?: CliCandidate; candidates: readonly CliCandidate[] } {
  const candidates: CliCandidate[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined, source: string): void => {
    if (!path) {
      return;
    }
    const normalized = isAbsolute(path) ? path : resolve(path);
    if (seen.has(normalized) || !isExecutable(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ path: normalized, source });
  };

  add(explicitPath, "--cli");
  add(process.env.MINIPROGRAM_DEVTOOLS_CLI, "MINIPROGRAM_DEVTOOLS_CLI");

  if (process.platform === "darwin") {
    for (const path of macCliPaths) {
      add(path, "macOS conventional path");
    }
  } else if (process.platform === "win32") {
    for (const path of windowsCliPaths) {
      add(path, "Windows conventional path");
    }
  }

  for (const command of ["wechatwebdevtools", "wechatdevtools", "cli"]) {
    add(commandPath(command), `PATH lookup: ${command}`);
  }

  return { selected: candidates[0], candidates };
}

function readPlistValue(plistPath: string, key: string): string | undefined {
  const result = run("plutil", ["-extract", key, "raw", "-o", "-", plistPath], 2_000);
  const value = result.stdout.trim();
  return result.status === 0 && value ? value : undefined;
}

function detectBundleInfo(cliPath: string): Record<string, string> {
  const bundleRoot = cliPath.includes(".app/Contents/")
    ? cliPath.slice(0, cliPath.indexOf(".app/Contents/") + ".app".length)
    : undefined;
  if (!bundleRoot) {
    return {};
  }

  const plistPath = join(bundleRoot, "Contents", "Info.plist");
  if (!existsSync(plistPath)) {
    return {};
  }

  const shortVersion = readPlistValue(plistPath, "CFBundleShortVersionString");
  const bundleVersion = readPlistValue(plistPath, "CFBundleVersion");
  return {
    ...(shortVersion ? { shortVersion } : {}),
    ...(bundleVersion ? { bundleVersion } : {}),
    plistPath,
  };
}

function findAutomatorEvidence(): AutomatorEvidence {
  const packageCandidates: string[] = [];
  if (process.env.MINIPROGRAM_AUTOMATOR_PATH) {
    packageCandidates.push(resolve(process.env.MINIPROGRAM_AUTOMATOR_PATH));
  }

  // Normal project installation is the primary resolution route. The fallback
  // probes nearby package roots only to make the script useful before install.
  if (commonJsRequire) {
    try {
      const entry = commonJsRequire.resolve("miniprogram-automator");
      packageCandidates.push(dirname(dirname(entry)));
    } catch {
      // Optional dependency: continue with filesystem candidates.
    }
  }

  const roots = [process.cwd(), scriptDirectory, dirname(scriptDirectory)];
  for (const root of roots) {
    packageCandidates.push(join(root, "node_modules", "miniprogram-automator"));
  }

  const seen = new Set<string>();
  for (const packageRoot of packageCandidates) {
    const normalized = resolve(packageRoot);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    const packageJsonPath = join(normalized, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    let packageJson: { version?: string; main?: string } = {};
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as typeof packageJson;
    } catch {
      // Keep the path as evidence even if a package is temporarily malformed.
    }

    const entryPath = packageJson.main ? join(normalized, packageJson.main) : undefined;
    const declarationChecks: string[] = [];
    for (const declaration of ["out/Launcher.d.ts", "out/MiniProgram.d.ts", "out/Page.d.ts"]) {
      const path = join(normalized, declaration);
      if (existsSync(path)) {
        declarationChecks.push(declaration);
      }
    }

    const sourceChecks: string[] = [];
    const launcherPath = join(normalized, "out/Launcher.js");
    const miniProgramPath = join(normalized, "out/MiniProgram.js");
    if (existsSync(launcherPath)) {
      const source = readFileSync(launcherPath, "utf8");
      for (const needle of ["cli auto", "--auto-port", "ws://127.0.0.1:"]) {
        if (source.includes(needle)) {
          sourceChecks.push(`Launcher.js contains ${needle}`);
        }
      }
    }
    if (existsSync(miniProgramPath)) {
      const source = readFileSync(miniProgramPath, "utf8");
      for (const needle of ["App.getPageStack", "App.getCurrentPage", "App.captureScreenshot", "App.logAdded", "App.exceptionThrown"]) {
        if (source.includes(needle)) {
          sourceChecks.push(`MiniProgram.js contains ${needle}`);
        }
      }
      if (!source.includes("compile()")) {
        sourceChecks.push("MiniProgram.js has no compile() method");
      }
    }

    return {
      packageJsonPath,
      ...(entryPath ? { entryPath } : {}),
      ...(packageJson.version ? { version: packageJson.version } : {}),
      declarations: declarationChecks,
      sourceChecks,
    };
  }

  return { declarations: [], sourceChecks: [] };
}

function resolveProjectPath(projectPath: string): string {
  return isAbsolute(projectPath) ? projectPath : resolve(process.cwd(), projectPath);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function runRuntimeProbe(
  options: ProbeOptions,
  cliPath: string | undefined,
  automatorEvidence: AutomatorEvidence,
): Promise<RuntimeProbeResult> {
  if (!options.projectPath) {
    return { attempted: false, status: "UNKNOWN" };
  }

  if (!cliPath) {
    return {
      attempted: true,
      status: "BLOCKED",
      error: "No executable WeChat DevTools CLI was found.",
    };
  }

  if (!automatorEvidence.entryPath) {
    return {
      attempted: true,
      status: "BLOCKED",
      error: "miniprogram-automator is not installed in the probe's resolution paths.",
    };
  }

  const projectPath = resolveProjectPath(options.projectPath);
  if (!existsSync(join(projectPath, "project.config.json"))) {
    return {
      attempted: true,
      status: "BLOCKED",
      error: `No project.config.json found at ${projectPath}`,
    };
  }

  const startedAt = Date.now();
  let miniProgram: any;
  let consoleEvents = 0;
  let exceptions = 0;

  try {
    if (!commonJsRequire) {
      return {
        attempted: true,
        status: "BLOCKED",
        error: "Runtime launch requires the compiled CommonJS probe (run npm run compile first).",
      };
    }
    const automatorModule = commonJsRequire(automatorEvidence.entryPath);
    const automator = automatorModule?.default ?? automatorModule;
    if (!automator || typeof automator.launch !== "function") {
      return {
        attempted: true,
        status: "BLOCKED",
        error: "Resolved automator module does not expose launch().",
      };
    }

    const launchOptions: Record<string, unknown> = {
      cliPath,
      projectPath,
      timeout: options.timeoutMs,
      trustProject: true,
    };
    if (options.port !== undefined) {
      launchOptions.port = options.port;
    }

    miniProgram = await automator.launch(launchOptions);
    if (typeof miniProgram.on === "function") {
      miniProgram.on("console", () => {
        consoleEvents += 1;
      });
      miniProgram.on("exception", () => {
        exceptions += 1;
      });
    }

    let currentPage: unknown;
    let pageStack: unknown;
    let screenshotPath: string | undefined;
    let screenshotBytes: number | undefined;

    try {
      currentPage = await miniProgram.currentPage();
    } catch (error) {
      currentPage = { error: errorMessage(error) };
    }
    try {
      pageStack = await miniProgram.pageStack();
    } catch (error) {
      pageStack = { error: errorMessage(error) };
    }
    try {
      const screenshotData = await miniProgram.screenshot();
      if (typeof screenshotData === "string" && screenshotData.length > 0) {
        const base64 = screenshotData.replace(/^data:image\/png;base64,/, "");
        const target = resolve(options.screenshotPath ?? join(process.cwd(), "work", "reality-spike", "simulator.png"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(base64, "base64"));
        screenshotPath = target;
        screenshotBytes = Buffer.byteLength(base64, "base64");
      }
    } catch (error) {
      return {
        attempted: true,
        status: "BLOCKED",
        elapsedMs: Date.now() - startedAt,
        currentPage,
        pageStack,
        consoleEvents,
        exceptions,
        error: `Screenshot failed: ${errorMessage(error)}`,
      };
    }

    return {
      attempted: true,
      status: screenshotPath ? "VERIFIED" : "UNKNOWN",
      elapsedMs: Date.now() - startedAt,
      currentPage,
      pageStack,
      ...(screenshotPath ? { screenshotPath } : {}),
      ...(screenshotBytes !== undefined ? { screenshotBytes } : {}),
      consoleEvents,
      exceptions,
      ...(screenshotPath ? {} : { error: "Automator returned no screenshot data." }),
    };
  } catch (error) {
    return {
      attempted: true,
      status: "BLOCKED",
      elapsedMs: Date.now() - startedAt,
      consoleEvents,
      exceptions,
      error: errorMessage(error),
    };
  } finally {
    if (miniProgram && !options.keepOpen && typeof miniProgram.close === "function") {
      try {
        await miniProgram.close();
      } catch (error) {
        // Cleanup errors are surfaced by the caller only when the probe itself
        // produced a result. Do not turn a successful screenshot into a claim
        // that the runtime was unavailable.
        process.stderr.write(`Probe cleanup warning: ${errorMessage(error)}\n`);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildReport(options: ProbeOptions, cli: CliCandidate | undefined, automator: AutomatorEvidence, runtime: RuntimeProbeResult): Record<string, unknown> {
  const cliHelp = cli ? run(cli.path, ["--help"]) : undefined;
  const autoHelp = cli ? run(cli.path, ["auto", "--help"]) : undefined;
  const openHelp = cli ? run(cli.path, ["open", "--help"]) : undefined;

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cli: cli
      ? {
          path: cli.path,
          source: cli.source,
          bundle: detectBundleInfo(cli.path),
          help: summarizeCommand(cliHelp),
          autoHelp: summarizeCommand(autoHelp),
          openHelp: summarizeCommand(openHelp),
        }
      : { status: "NOT_FOUND" },
    automator,
    runtime,
    options: {
      ...(options.projectPath ? { projectPath: resolveProjectPath(options.projectPath) } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      timeoutMs: options.timeoutMs,
      ...(options.screenshotPath ? { screenshotPath: resolve(options.screenshotPath) } : {}),
    },
  };
}

function summarizeCommand(result: CommandResult | undefined): Record<string, unknown> | undefined {
  if (!result) {
    return undefined;
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    output: `${result.stdout}${result.stderr}`.trim().slice(0, 8_000),
  };
}

function printHumanReport(report: Record<string, unknown>): void {
  const cli = asRecord(report.cli);
  const bundle = asRecord(cli.bundle);
  const automator = asRecord(report.automator);
  const runtime = asRecord(report.runtime);

  console.log("WeChat Mini Program runtime probe");
  console.log(`Platform: ${report.platform} ${report.arch}; Node ${report.node}`);
  if (cli.path) {
    console.log(`CLI: ${cli.path} (${cli.source})`);
    if (bundle.shortVersion || bundle.bundleVersion) {
      console.log(`DevTools bundle: ${bundle.shortVersion ?? "unknown"} (${bundle.bundleVersion ?? "unknown"})`);
    }
    console.log("CLI help: captured --help, auto --help, and open --help");
  } else {
    console.log("CLI: NOT_FOUND");
  }
  if (automator.version) {
    console.log(`Automator: miniprogram-automator ${automator.version}`);
  } else {
    console.log("Automator: NOT_FOUND");
  }

  const declarations = Array.isArray(automator.declarations) ? automator.declarations.join(", ") : "none";
  console.log(`Automator declarations: ${declarations}`);
  if (Array.isArray(automator.sourceChecks)) {
    for (const check of automator.sourceChecks) {
      console.log(`  ${check}`);
    }
  }

  if (runtime.attempted) {
    console.log(`Runtime attempt: ${runtime.status}`);
    if (runtime.elapsedMs !== undefined) {
      console.log(`Runtime elapsed: ${runtime.elapsedMs} ms`);
    }
    if (runtime.screenshotPath) {
      console.log(`Screenshot: ${runtime.screenshotPath} (${runtime.screenshotBytes ?? "?"} bytes)`);
    }
    if (runtime.error) {
      console.log(`Runtime detail: ${runtime.error}`);
    }
  } else {
    console.log("Runtime attempt: not requested (pass --project to run it)");
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const cliResult = detectCli(options.cliPath);
  const automator = findAutomatorEvidence();
  const runtime = await runRuntimeProbe(options, cliResult.selected?.path, automator);
  const report = buildReport(options, cliResult.selected, automator, runtime);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
}

main().catch((error) => {
  console.error(`Probe failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
