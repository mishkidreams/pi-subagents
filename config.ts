import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ModelAlias, SubagentSettings } from "./types.ts";

export const DEFAULT_SETTINGS: SubagentSettings = {
	maxDepth: 2,
	maxConcurrency: 4,
	rpcMaxLineChars: 64 * 1024 * 1024,
	aliasesOnly: false,
};

export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_VALUES);

type RawSettings = Partial<SubagentSettings>;
type ModelSettings = Pick<SubagentSettings, "modelAliases" | "defaultModel" | "defaultThinking" | "aliasesOnly">;
export const MODEL_CONFIG_ENV = "PI_SUBAGENT_MODEL_CONFIG";

function readSettings(path: string): RawSettings {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return value as RawSettings;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean (true or false)`);
	return value;
}

function depth(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return value;
}

function concurrency(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || (value !== -1 && value < 1)) {
		throw new Error(`${field} must be -1 (unlimited) or a positive integer`);
	}
	return value;
}

export function validateRpcMaxLineChars(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive safe integer`);
	}
	return value;
}

export function validateThinkingLevel(value: unknown, field: string): string {
	const level = optionalString(value, field)!;
	if (!THINKING_LEVELS.has(level)) {
		throw new Error(`${field} is not a valid thinking level (${JSON.stringify(value)}); use ${THINKING_LEVEL_VALUES.join(", ")}`);
	}
	return level;
}

function validateAliases(value: unknown, field: string): Record<string, ModelAlias> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	const aliases: Record<string, ModelAlias> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
			throw new Error(`${field} alias names must contain only letters, digits, hyphens or underscores and start with a letter or digit`);
		}
		const source = `${field}.${name}`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source} must be an object`);
		for (const key of Object.keys(raw)) {
			if (!["model", "thinking", "description", "enabled"].includes(key)) throw new Error(`${source}.${key} is not a supported alias field`);
		}
		const entry = raw as Record<string, unknown>;
		const model = optionalString(entry.model, `${source}.model`);
		if (!model || !/^[^/\s:,]+\/[^\s,]+$/.test(model) || /[*?\p{Cc}]/u.test(model)) {
			throw new Error(`${source}.model must be an exact provider/model selector`);
		}
		const alias: ModelAlias = { model };
		if (entry.enabled !== undefined) alias.enabled = boolean(entry.enabled, `${source}.enabled`);
		if (entry.thinking !== undefined) alias.thinking = validateThinkingLevel(entry.thinking, `${source}.thinking`);
		if (entry.description !== undefined) {
			if (typeof entry.description !== "string") throw new Error(`${source}.description must be a string`);
			alias.description = entry.description;
		}
		aliases[name] = alias;
	}
	return aliases;
}

/** Validate effective settings after project/env merging, before any child can be launched. */
export function validateModelSettings(settings: ModelSettings, source = "subagent settings"): void {
	const aliases = settings.modelAliases ?? {};
	const enabled = Object.keys(aliases).filter((name) => aliases[name]!.enabled !== false).sort();
	if (settings.aliasesOnly && enabled.length === 0) {
		throw new Error(`${source}.aliasesOnly requires at least one enabled alias in modelAliases; configure one before delegating`);
	}
	const selected = settings.defaultModel;
	if (selected && Object.hasOwn(aliases, selected) && aliases[selected]!.enabled === false) {
		throw new Error(`${source}.defaultModel "${selected}" is disabled; choose an enabled alias. Available aliases: ${enabled.join(", ") || "(none)"}`);
	}
	if (settings.aliasesOnly && selected && !Object.hasOwn(aliases, selected)) {
		throw new Error(`${source}.defaultModel "${selected}" must name an enabled alias when aliasesOnly is true; raw model IDs are not allowed. Available aliases: ${enabled.join(", ")}`);
	}
}

/** Freeze effective delegation defaults, including their absence, for the entire child subtree. */
export function serializeModelSettings(settings: SubagentSettings): string {
	return JSON.stringify({
		modelAliases: settings.modelAliases ?? null,
		defaultModel: settings.defaultModel ?? null,
		defaultThinking: settings.defaultThinking ?? null,
		aliasesOnly: settings.aliasesOnly ?? false,
	});
}

function inheritedModelSettings(value: string | undefined): ModelSettings | undefined {
	if (value === undefined) return undefined;
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
		raw = parsed as Record<string, unknown>;
		for (const key of Object.keys(raw)) {
			if (!["modelAliases", "defaultModel", "defaultThinking", "aliasesOnly"].includes(key)) {
				throw new Error(`unsupported snapshot field "${key}"; supported fields: modelAliases, defaultModel, defaultThinking, aliasesOnly`);
			}
		}
		if (!["modelAliases", "defaultModel", "defaultThinking"].every((key) => Object.hasOwn(raw, key))) {
			throw new Error("missing snapshot fields");
		}
	} catch (error) {
		throw new Error(`${MODEL_CONFIG_ENV} is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		modelAliases: raw.modelAliases === null ? undefined : validateAliases(raw.modelAliases, MODEL_CONFIG_ENV),
		defaultModel: raw.defaultModel === null ? undefined : optionalString(raw.defaultModel, `${MODEL_CONFIG_ENV}.defaultModel`),
		defaultThinking: raw.defaultThinking === null ? undefined : validateThinkingLevel(raw.defaultThinking, `${MODEL_CONFIG_ENV}.defaultThinking`),
		// Old snapshots predate this flag; new parents always serialize it explicitly.
		aliasesOnly: raw.aliasesOnly === undefined ? false : boolean(raw.aliasesOnly, `${MODEL_CONFIG_ENV}.aliasesOnly`),
	};
}

function validate(raw: RawSettings, source: string, inheritModels = false): RawSettings {
	const result: RawSettings = {};
	const supported = ["defaultModel", "defaultThinking", "modelAliases", "aliasesOnly", "rpcMaxLineChars", "maxDepth", "maxConcurrency"];
	for (const key of Object.keys(raw)) {
		if (!supported.includes(key)) throw new Error(`${source}.${key} is not a supported setting; supported fields: ${supported.join(", ")}`);
	}
	if (!inheritModels) {
		if (raw.aliasesOnly !== undefined) result.aliasesOnly = boolean(raw.aliasesOnly, `${source}.aliasesOnly`);
		if (raw.defaultModel !== undefined) result.defaultModel = optionalString(raw.defaultModel, `${source}.defaultModel`);
		if (raw.defaultThinking !== undefined) {
			result.defaultThinking = validateThinkingLevel(raw.defaultThinking, `${source}.defaultThinking`);
		}
		if (raw.modelAliases !== undefined) result.modelAliases = validateAliases(raw.modelAliases, `${source}.modelAliases`);
	}
	if (raw.rpcMaxLineChars !== undefined) {
		result.rpcMaxLineChars = validateRpcMaxLineChars(raw.rpcMaxLineChars, `${source}.rpcMaxLineChars`);
	}
	if (raw.maxDepth !== undefined) result.maxDepth = depth(raw.maxDepth, `${source}.maxDepth`);
	if (raw.maxConcurrency !== undefined) {
		result.maxConcurrency = concurrency(raw.maxConcurrency, `${source}.maxConcurrency`);
	}
	return result;
}

function envNumber(value: string | undefined, parser: (value: unknown, field: string) => number, field: string) {
	if (value === undefined || value === "") return undefined;
	return parser(Number(value), field);
}

export function loadSettings(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	depthFlag?: string;
	env?: NodeJS.ProcessEnv;
}): SubagentSettings {
	const env = options.env ?? process.env;
	const inherited = inheritedModelSettings(env[MODEL_CONFIG_ENV]);
	const globalPath = join(options.agentDir, "subagents.json");
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, "subagents.json");
	const global = validate(readSettings(globalPath), `global subagent settings (${globalPath})`, inherited !== undefined);
	const project = options.projectTrusted
		? validate(readSettings(projectPath), `project subagent settings (${projectPath})`, inherited !== undefined)
		: {};
	const merged: SubagentSettings = { ...DEFAULT_SETTINGS, ...global, ...project, ...inherited };

	const inheritedDepth = envNumber(env.PI_SUBAGENT_MAX_DEPTH, depth, "PI_SUBAGENT_MAX_DEPTH");
	const flagDepth = options.depthFlag === undefined ? undefined : depth(Number(options.depthFlag), "--subagent-depth");
	const maxDepthFlagOverride = flagDepth !== undefined ||
		(inheritedDepth !== undefined && env.PI_SUBAGENT_DEPTH_FLAG_OVERRIDE === "1");
	// A flag overrides file configuration throughout its subtree. Without one,
	// explicit file limits may tighten inheritance, but built-in defaults may not.
	const configuredDepth = flagDepth ??
		(maxDepthFlagOverride ? inheritedDepth : project.maxDepth ?? global.maxDepth) ??
		inheritedDepth ?? DEFAULT_SETTINGS.maxDepth;
	const envThinking = inherited === undefined && env.PI_SUBAGENT_DEFAULT_THINKING
		? validateThinkingLevel(env.PI_SUBAGENT_DEFAULT_THINKING, "PI_SUBAGENT_DEFAULT_THINKING")
		: undefined;

	const result: SubagentSettings = {
		...merged,
		defaultModel: inherited === undefined && env.PI_SUBAGENT_DEFAULT_MODEL
			? optionalString(env.PI_SUBAGENT_DEFAULT_MODEL, "PI_SUBAGENT_DEFAULT_MODEL") : merged.defaultModel,
		defaultThinking: envThinking ?? merged.defaultThinking,
		// Neither file configuration nor a descendant flag may raise inheritance.
		maxDepth: inheritedDepth === undefined ? configuredDepth : Math.min(inheritedDepth, configuredDepth),
		maxDepthFlagOverride,
		maxConcurrency: merged.maxConcurrency,
	};
	const source = inherited ? MODEL_CONFIG_ENV : `effective subagent settings (${globalPath}${options.projectTrusted ? `; ${projectPath}` : ""})`;
	validateModelSettings(result, source);
	return result;
}

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const value = env.PI_SUBAGENT_DEPTH;
	return value === undefined ? 0 : depth(Number(value), "PI_SUBAGENT_DEPTH");
}
