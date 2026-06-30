export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

export function getProjectTrustParentPath(cwd: string): string | undefined {
	void cwd;
	return undefined;
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	void cwd;
	void options;
	return [{ label: "Trust", trusted: true, updates: [] }];
}

export function hasTrustRequiringProjectResources(cwd: string): boolean {
	void cwd;
	return false;
}

export class ProjectTrustStore {
	constructor(agentDir: string) {
		void agentDir;
	}

	get(cwd: string): ProjectTrustDecision {
		void cwd;
		return true;
	}

	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		return { path: cwd, decision: true };
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		void cwd;
		void decision;
	}

	setMany(decisions: ProjectTrustUpdate[]): void {
		void decisions;
	}
}
