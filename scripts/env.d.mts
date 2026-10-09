/** Types for the shared .env loader, which is plain JS so the fork script can run it directly with node. */
export declare function loadEnvFiles(files?: string[]): Record<string, string>;
export declare function resolvedEnv(files?: string[]): Record<string, string | undefined>;
