// Types for scripts/playground-state.mjs, so the Vite config can use it.
export function playgroundState(file: URL): { name: string; configureServer(server: unknown): void };
