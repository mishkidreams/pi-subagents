import { validateModelSettings, validateThinkingLevel } from "./config.ts";
import type { SubagentSettings } from "./types.ts";

export interface ModelCapability {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

export interface ModelSelectionContext {
	settings: SubagentSettings;
	parentModel?: string;
	parentThinking?: string;
	scopedModels: readonly ModelCapability[];
	/** Omitted only by legacy hosts without a model registry. An empty catalog is not unrestricted. */
	availableModels?: readonly ModelCapability[];
}

function canonicalModel(model: ModelCapability): string {
	return `${model.provider}/${model.id}`;
}

/** Canonicalize a requested model against a nonempty parent model scope. */
export function resolveChildModel(model: string, scopedModels: readonly ModelCapability[]): string {
	if (scopedModels.length === 0) return model;
	const normalized = model.toLowerCase();
	const exact = scopedModels.find((item) => canonicalModel(item).toLowerCase() === normalized);
	if (exact) return canonicalModel(exact);
	const bareMatches = scopedModels.filter((item) => item.id.toLowerCase() === normalized);
	if (bareMatches.length === 1) return canonicalModel(bareMatches[0]!);
	if (bareMatches.length > 1) {
		throw new Error(`Subagent model "${model}" is ambiguous within the creating session's model scope`);
	}
	throw new Error(`Subagent model "${model}" is outside the creating session's model scope`);
}

export function resolveChildThinking(
	requested: string | undefined,
	model: string,
	scopedModels: readonly ModelCapability[],
	fallback: string,
): string {
	const pinned = scopedModels.find((item) => canonicalModel(item).toLowerCase() === model.toLowerCase())?.thinkingLevel;
	const value = requested?.trim();
	if (value) {
		if (pinned && value !== pinned) {
			throw new Error(`Subagent thinking "${value}" is outside the creating session's pin for ${model} (${pinned})`);
		}
		return value;
	}
	return pinned || fallback;
}

function assertAliasNames(context: ModelSelectionContext): void {
	const models = [...(context.availableModels ?? []), ...context.scopedModels];
	for (const [alias, value] of Object.entries(context.settings.modelAliases ?? {})) {
		if (value.enabled === false) continue;
		if (models.some((model) => model.id.toLowerCase() === alias.toLowerCase())) {
			throw new Error(`Subagent model alias "${alias}" conflicts with a bare model ID; rename the alias and use provider/model for the model`);
		}
	}
}

function resolveAvailableModel(selector: string, context: ModelSelectionContext, exactIdentity = false): string {
	const scoped = resolveChildModel(selector, context.scopedModels);
	// An alias's provider/model is an identity, never a bare ID offered by another provider.
	if (exactIdentity && scoped.toLowerCase() !== selector.toLowerCase()) {
		throw new Error(`Subagent model "${selector}" is outside the creating session's model scope`);
	}
	if (context.availableModels === undefined) return scoped;
	const normalized = scoped.toLowerCase();
	const exact = context.availableModels.find((model) => canonicalModel(model).toLowerCase() === normalized);
	if (exact) return canonicalModel(exact);
	// Bare IDs may themselves contain slashes (for example OpenRouter IDs).
	const matches = context.availableModels.filter((model) => model.id.toLowerCase() === normalized);
	if (!exactIdentity && matches.length === 1) return canonicalModel(matches[0]!);
	if (!exactIdentity && matches.length > 1) throw new Error(`Subagent model "${selector}" is ambiguous; use provider/model`);
	throw new Error(`Subagent model "${selector}" is not available in the creating session's model registry`);
}

function resolveSelection(
	selector: string,
	thinking: string | undefined,
	context: ModelSelectionContext,
	exactIdentity = false,
): { model: string; thinking: string } {
	const aliases = context.settings.modelAliases;
	const alias = aliases && Object.hasOwn(aliases, selector) ? aliases[selector] : undefined;
	if (context.settings.aliasesOnly && !alias) {
		throw new Error(`aliasesOnly is enabled: "${selector}" is not a configured alias; raw provider/model and bare model IDs are not allowed. Choose an enabled alias`);
	}
	if (alias?.enabled === false) throw new Error(`Subagent model alias "${selector}" is disabled (enabled: false)`);
	const model = resolveAvailableModel(alias?.model ?? selector, context, exactIdentity || alias !== undefined);
	const level = resolveChildThinking(
		thinking?.trim() || alias?.thinking,
		model,
		context.scopedModels,
		context.settings.defaultThinking || context.parentThinking || "off",
	);
	return { model, thinking: validateThinkingLevel(level, "thinking") };
}

function eligibleAliases(context: ModelSelectionContext): string[] {
	return Object.keys(context.settings.modelAliases ?? {}).sort().filter((alias) => {
		try { resolveSelection(alias, undefined, context); return true; }
		catch { return false; }
	});
}

/** The same resolution rules drive launch validation and the model-facing catalog. */
export function resolveModelSelection(
	selector: string | undefined,
	thinking: string | undefined,
	context: ModelSelectionContext,
): { model: string; thinking: string } {
	assertAliasNames(context);
	if (selector !== undefined && !selector.trim()) {
		throw new Error(`model must be a non-empty alias or exact model ID; omit the field to use the configured default. Available aliases: ${eligibleAliases(context).join(", ") || "(none)"}`);
	}
	const selected = selector?.trim() || context.settings.defaultModel || (context.settings.aliasesOnly ? undefined : context.parentModel);
	if (!selected) {
		if (context.settings.aliasesOnly) {
			throw new Error(`aliasesOnly is enabled: provide an explicit alias in model or configure defaultModel as an enabled alias; parent-model fallback is disabled. Available aliases: ${eligibleAliases(context).join(", ") || "(none)"}`);
		}
		throw new Error("No subagent model is available; choose a parent model or configure defaultModel");
	}
	try {
		return resolveSelection(selected, thinking, context);
	} catch (error) {
		const target = context.settings.modelAliases && Object.hasOwn(context.settings.modelAliases, selected)
			? context.settings.modelAliases[selected]!.model : undefined;
		const request = target ? `Alias "${selected}" resolves to ${target}. ` : `Requested model "${selected}". `;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${request}${message}. Available aliases: ${eligibleAliases(context).join(", ") || "(none)"}`);
	}
}

/** Validate startup capabilities without launching a child or falling back to another model. */
export function validateModelConfiguration(context: ModelSelectionContext): void {
	validateModelSettings(context.settings);
	assertAliasNames(context);
	const errors: string[] = [];
	if (context.settings.aliasesOnly) {
		for (const [name, alias] of Object.entries(context.settings.modelAliases ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
			if (alias.enabled === false) continue;
			try { resolveSelection(name, undefined, context); }
			catch (error) { errors.push(`modelAliases.${name} (${alias.model}): ${error instanceof Error ? error.message : String(error)}`); }
		}
	}
	if (context.settings.defaultModel) {
		try { resolveModelSelection(undefined, undefined, context); }
		catch (error) { errors.push(`defaultModel "${context.settings.defaultModel}": ${error instanceof Error ? error.message : String(error)}`); }
	}
	if (errors.length) {
		throw new Error(`Invalid subagent model configuration:\n- ${errors.join("\n- ")}\nFix the model/thinking or disable unused aliases (enabled: false); defaultModel must remain usable. Reload with /reload after editing subagents.json`);
	}
}

/** Resume never reinterprets a canonical saved identity as an alias or another provider's bare ID. */
export function resolveSavedModelSelection(
	model: string,
	thinking: string,
	context: ModelSelectionContext,
): { model: string; thinking: string } {
	if (context.settings.aliasesOnly) {
		const allowed = Object.values(context.settings.modelAliases ?? {}).some((alias) =>
			alias.enabled !== false && alias.model.toLowerCase() === model.toLowerCase());
		if (!allowed) {
			throw new Error(`Cannot resume saved model "${model}": aliasesOnly is enabled and this exact provider/model is not the target of an enabled alias. Configure an enabled alias for this saved model or start a new child with an allowed alias. Available aliases: ${eligibleAliases(context).join(", ") || "(none)"}`);
		}
	}
	// Membership was checked against exact saved identity; aliases cannot retarget it.
	return resolveSelection(model, thinking, {
		...context, settings: { ...context.settings, modelAliases: undefined, aliasesOnly: false },
	}, model.includes("/"));
}

/** Facts and user-authored descriptions only; no built-in model-selection policy. */
export function formatModelCatalog(context: ModelSelectionContext): string {
	if (context.settings.modelAliases === undefined) return "";
	assertAliasNames(context);
	const aliases = eligibleAliases(context);
	const selected = context.settings.defaultModel || (context.settings.aliasesOnly ? undefined : context.parentModel);
	let defaultLabel = context.settings.defaultModel || (context.settings.aliasesOnly
		? "(none; explicit alias required)" : context.parentModel ? `parent (${context.parentModel})` : "(none)");
	if (selected) {
		try { resolveSelection(selected, undefined, context); }
		catch {
			defaultLabel += context.settings.modelAliases?.[selected]?.enabled === false ? " (disabled)" : " (unavailable)";
		}
	}
	const policy = context.settings.aliasesOnly
		? " Only enabled aliases are allowed; raw model IDs and parent-model fallback are disabled." : "";
	const lines = [`Subagent models. Default: ${defaultLabel}.${policy}`];
	if (aliases.length === 0) lines.push("No available aliases in the current session.");
	for (const name of aliases) {
		const value = context.settings.modelAliases[name]!;
		const resolved = resolveSelection(name, undefined, context);
		lines.push(`${name} → ${resolved.model}; thinking=${resolved.thinking}.${value.description ? `\n${value.description}` : ""}`);
	}
	return lines.join("\n");
}
