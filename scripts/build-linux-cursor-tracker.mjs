import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const sourceDir = path.join(projectRoot, "electron", "native", "linux-cursor-tracker");
const manifestPath = path.join(sourceDir, "Cargo.toml");
const archTag = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
const bundledDir = path.join(projectRoot, "electron", "native", "bin", archTag);
const binaryName = "recordly-linux-cursor-tracker";
const targetDir = path.join(sourceDir, "target");
const builtBinaryPath = path.join(targetDir, "release", binaryName);
const bundledBinaryPath = path.join(bundledDir, binaryName);

if (process.platform !== "linux") {
	console.log("[build-linux-cursor-tracker] Skipping: host platform is not Linux.");
	process.exit(0);
}

if (!existsSync(manifestPath)) {
	console.error("[build-linux-cursor-tracker] Cargo.toml not found at", manifestPath);
	process.exit(1);
}

try {
	execFileSync("cargo", ["--version"], { stdio: "pipe" });
} catch {
	console.error("[build-linux-cursor-tracker] cargo is unavailable; install Rust to build the Linux cursor tracker.");
	process.exit(1);
}

console.log("[build-linux-cursor-tracker] Building...");
try {
	execFileSync(
		"cargo",
		["build", "--release", "--manifest-path", manifestPath, "--target-dir", targetDir],
		{
			cwd: sourceDir,
			stdio: "inherit",
			timeout: 300000,
		},
	);
} catch (error) {
	console.error("[build-linux-cursor-tracker] Build failed:", error.message);
	process.exit(1);
}

if (!existsSync(builtBinaryPath)) {
	console.error("[build-linux-cursor-tracker] Expected binary not found at", builtBinaryPath);
	process.exit(1);
}

mkdirSync(bundledDir, { recursive: true });
copyFileSync(builtBinaryPath, bundledBinaryPath);
chmodSync(bundledBinaryPath, 0o755);
console.log(`[build-linux-cursor-tracker] Staged bundled helper: ${bundledBinaryPath}`);
