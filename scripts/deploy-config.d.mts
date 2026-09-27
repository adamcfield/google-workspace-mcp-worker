/** Types for scripts/deploy-config.mjs (plain JavaScript, imported by tests). */
export declare const PLACEHOLDER: RegExp;
export declare const KV_ID_ENV: Record<string, string>;
export declare function fillConfig(config: unknown, env?: Record<string, string | undefined>): any;
export declare function renderConfig(sourceText: string, env?: Record<string, string | undefined>): string;
