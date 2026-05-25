#!/usr/bin/env node
// scripts/install-local.mjs
// Packages the extension and installs it into the running VS Code instance.
// Invokes executables directly — no shell required (avoids cmd.exe resolution bugs).

import { spawnSync } from "child_process";
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { platform } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const isWin = platform() === "win32";

// ─── Find VS Code executable & CLI script ──────────────────────────────────

function findCodeExe() {
  // Standard per-user install
  const base = join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code");
  const exe = join(base, "Code.exe");
  if (existsSync(exe)) {
    // Find the version directory (e.g. "f6cfa2ea24")
    const entries = readdirSync(base, { withFileTypes: true });
    const versionDir = entries
      .filter((e) => e.isDirectory() && /^[a-f0-9]{8,}$/i.test(e.name))
      .sort()
      .at(-1);
    if (versionDir) {
      const cliJs = join(base, versionDir.name, "resources", "app", "out", "cli.js");
      if (existsSync(cliJs)) return { exe, cliJs };
    }
  }
  return null;
}

// ─── Run a command via spawnSync ───────────────────────────────────────────

function run(exe, args, opts = {}) {
  const result = spawnSync(exe, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// ─── Package ───────────────────────────────────────────────────────────────

console.log("📦 Packaging extension…");

// Run vsce directly via node.exe (no shell, no .cmd wrapper)
const vsceEntry = join(root, "node_modules", "@vscode", "vsce", "vsce");
run(process.execPath, [vsceEntry, "package", "--no-dependencies"]);

const vsix = readdirSync(root)
  .filter((f) => f.endsWith(".vsix"))
  .sort()
  .at(-1);

if (!vsix) {
  console.error("❌ No .vsix file found after packaging.");
  process.exit(1);
}

// ─── Install ───────────────────────────────────────────────────────────────

console.log(`🔌 Installing ${vsix}…`);

if (isWin) {
  const codeInfo = findCodeExe();
  if (codeInfo) {
    // Run Code.exe directly: Code.exe cli.js --install-extension file.vsix
    run(codeInfo.exe, [codeInfo.cliJs, "--install-extension", join(root, vsix)], {
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  } else {
    console.error("❌ VS Code installation not found. Install the .vsix manually.");
    process.exit(1);
  }
} else {
  run("code", ["--install-extension", join(root, vsix)]);
}

console.log("✅ Done! Fully restart VS Code to activate the new version.");
