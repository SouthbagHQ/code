import { compare, rcompare, valid } from "semver";
import {
	detectInstallMethod,
	getPackageDir,
	getSelfUpdateCommand,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	VERSION,
} from "../config.ts";
import { spawnProcess, spawnProcessSync } from "./child-process.ts";
import { cleanupWindowsSelfUpdateQuarantine, quarantineWindowsNativeDependencies } from "./windows-self-update.ts";

const VERSION_CHECK_TIMEOUT_MS = 10000;

function getNpmCommand(npmCommand?: string[]): { command: string; args: string[] } {
	if (!npmCommand || npmCommand.length === 0) {
		return { command: "npm", args: [] };
	}
	const [command, ...args] = npmCommand;
	return { command: command || "npm", args };
}

export function isNewerPublishedVersion(latestVersion: string, currentVersion: string): boolean {
	const latest = valid(latestVersion.trim());
	const current = valid(currentVersion.trim());
	if (latest && current) {
		return compare(latest, current) > 0;
	}
	return latestVersion.trim() !== currentVersion.trim();
}

function parseNpmViewVersionOutput(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (typeof parsed === "string") {
			return parsed;
		}
		if (Array.isArray(parsed)) {
			const versions = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
			return versions.sort(rcompare)[0];
		}
	} catch {
		return valid(trimmed) ?? undefined;
	}
	return undefined;
}

function getLatestPublishedVersion(packageName: string, npmCommand?: string[]): string | undefined {
	const npm = getNpmCommand(npmCommand);
	const result = spawnProcessSync(npm.command, [...npm.args, "view", packageName, "version", "--json"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: VERSION_CHECK_TIMEOUT_MS,
	});
	if (result.status !== 0) {
		return undefined;
	}
	return parseNpmViewVersionOutput(result.stdout || result.stderr || "");
}

async function runSilentCommand(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawnProcess(command, args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
		});
	});
}

async function runSilentSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	const installMethod = detectInstallMethod();
	if (process.platform === "win32" && installMethod === "npm") {
		const packageDir = getPackageDir();
		cleanupWindowsSelfUpdateQuarantine(packageDir);
		quarantineWindowsNativeDependencies(packageDir);
	}

	for (const step of command.steps ?? [command]) {
		await runSilentCommand(step.command, step.args);
	}
}

async function runSilentSelfUpdateIfNeeded(npmCommand?: string[]): Promise<void> {
	const latestVersion = getLatestPublishedVersion(PACKAGE_NAME, npmCommand);
	if (!latestVersion || !isNewerPublishedVersion(latestVersion, VERSION)) {
		return;
	}

	const updateTarget = {
		packageName: PACKAGE_NAME,
		installSpec: `${PACKAGE_NAME}@${latestVersion}`,
	};
	const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, npmCommand, updateTarget);
	if (!selfUpdateCommand) {
		return;
	}

	await runSilentSelfUpdate(selfUpdateCommand);
}

/**
 * Check npm for a newer pi release and update global package-manager installs in the background.
 * Failures are ignored so startup stays seamless.
 */
export function startSilentSelfUpdate(npmCommand?: string[]): void {
	void runSilentSelfUpdateIfNeeded(npmCommand).catch(() => {});
}
