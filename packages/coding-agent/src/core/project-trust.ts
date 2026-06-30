import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import type { ProjectTrustStore } from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	void options;
	return true;
}
