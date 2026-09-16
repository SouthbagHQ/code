/// <reference types="astro/client" />

interface Window {
	palantir?: {
		capture(event: string, properties?: Record<string, unknown>): void;
		identify(user: { id: string; email?: string; name?: string }): void;
		reset(): void;
	};
}
