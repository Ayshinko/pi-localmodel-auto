import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionVirtualModel,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { buildModelsFromCatalog, fetchModelCatalog, isValidLimit, StrataError } from "./discovery.ts";
import type { DiscoveredModel } from "./discovery.ts";
import { loadConfig } from "./config.ts";
import { catalogMismatch, selectAliasTarget } from "./alias.ts";
import type { StrataConfig } from "./config.ts";

// Module-level state shared across extension reloads within the Pi process.
let config: StrataConfig | null = null;
let currentModels: DiscoveredModel[] = [];
let registered = false;

/** Pi's catalog marker for virtual entries: they are selectable but never sent to a provider. */
const VIRTUAL_MODEL_API = "pi-virtual";

/** The thinking levels the alias may offer; anything else in config.json is dropped with a warning. */
const ALIAS_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type AliasThinkingLevel = (typeof ALIAS_THINKING_LEVELS)[number];

/** The extension API, kept so route() can rebuild the registration when Strata swaps models. */
let apiRef: ExtensionAPI | null = null;

/** Live-catalogue probe state: timestamp of the last probe plus one shared in-flight request. */
let lastProbeAt = 0;
let probeInFlight: Promise<void> | null = null;

/** Warn-once guard, so repeated requests over the same model list do not spam the console. */
let warnedAmbiguousKey = "";

/** Models that have every required numeric limit resolved (safe to register). */
function registerableModels(models: DiscoveredModel[]): DiscoveredModel[] {
	return models.filter((m) => isValidLimit(m.contextWindow) && isValidLimit(m.maxTokens));
}

/** Warn once per model that is missing a required limit (never invent one). */
function warnUnavailable(models: DiscoveredModel[]): void {
	for (const m of models) {
		const missing: string[] = [];
		if (!isValidLimit(m.contextWindow)) missing.push("context window");
		if (!isValidLimit(m.maxTokens)) missing.push("max tokens");
		if (missing.length > 0) {
			console.warn(
				`[localmodel-auto] model "${m.id}" is missing ${missing.join(" and ")} ` +
					`(not in Strata meta, per-model config, or config.json defaults); it is NOT registered. ` +
					`Set defaults or a per-model override in config.json to expose it.`,
			);
		}
	}
}

/** Best-effort discovery. Never throws; reports offline status + last-known models. */
async function discoverAndStore(): Promise<{
	models: DiscoveredModel[];
	offline: boolean;
	error?: string;
}> {
	const cfg = config!;
	try {
		const catalog = await fetchModelCatalog(cfg.baseUrl, cfg.timeoutMs);
		currentModels = buildModelsFromCatalog(catalog, cfg);
		warnUnavailable(currentModels);
		return { models: currentModels, offline: false };
	} catch (err) {
		const offline = err instanceof StrataError;
		return {
			models: currentModels,
			offline,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Build the ProviderConfig Pi should register. */
function buildProviderConfig(): ProviderConfig {
	const cfg = config!;
	return {
		name: cfg.name,
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		api: cfg.api as ProviderConfig["api"],
		models: registerableModels(currentModels) as unknown as ProviderModelConfig[],
		refreshModels: async (context) => {
			// On cache-only initialization, keep the last-known list without a network call.
			if (context.allowNetwork === false) {
				return registerableModels(currentModels) as unknown as ProviderModelConfig[];
			}
			// Attempt a live refresh. On failure we retain the previous list so a
			// temporary outage does not wipe the in-memory catalogue.
			await discoverAndStore();
			return registerableModels(currentModels) as unknown as ProviderModelConfig[];
		},
	};
}

/** (Re)apply the provider registration so the runtime registry reflects currentModels. */
function applyProvider(pi: ExtensionAPI): void {
	if (registered) {
		pi.unregisterProvider(config!.providerId);
	}
	pi.registerProvider(config!.providerId, buildProviderConfig());
	registered = true;
}

function formatModels(models: DiscoveredModel[]): string {
	const ids = models.map((m) => m.id);
	return ids.length === 0 ? "(none)" : ids.map((id) => `- ${id}`).join("\n");
}

/**
 * Re-read Strata's live catalogue and rebuild the provider registration when the
 * live ids differ from what Pi has registered, i.e. the Strata model was swapped.
 *
 * TTL comes from `virtual.autoRefreshProbeMs`; 0 disables probing. `force` (used
 * when nothing is registered yet) probes at most once a second. Never throws:
 * offline keeps the last-known registration, and `refreshModels` already
 * retains the previous list, so a short Strata restart cannot wipe the alias's
 * only routing target.
 */
async function refreshIfStrataChanged(force: boolean): Promise<void> {
	const cfg = config!;
	const ttl = cfg.virtual.autoRefreshProbeMs;
	if (ttl <= 0 && !force) {
		return;
	}
	const minAgeMs = force ? (ttl > 0 ? Math.min(ttl, 1000) : 1000) : ttl;
	if (Date.now() - lastProbeAt < minAgeMs) {
		return;
	}
	if (probeInFlight) {
		return probeInFlight;
	}
	probeInFlight = (async () => {
		try {
			const catalog = await fetchModelCatalog(cfg.baseUrl, cfg.timeoutMs);
			const liveIds = catalog.map((entry) => entry.id);
			const knownIds = currentModels.map((entry) => entry.id);
			if (catalogMismatch(liveIds, knownIds)) {
				console.warn(
					`[localmodel-auto] Strata catalogue changed (${knownIds.join(", ") || "(none)"} -> ${liveIds.join(", ") || "(none)"}); rebuilding the registration so the alias routes to the new model`,
				);
				await discoverAndStore();
				if (apiRef) {
					applyProvider(apiRef);
					registerAliasModel(apiRef);
				}
			}
		} catch {
			// Offline or invalid response: keep the last-known list, and let the TTL retry.
		} finally {
			lastProbeAt = Date.now();
			probeInFlight = null;
		}
	})();
	return probeInFlight;
}

/**
 * Register the stable alias (`providerId/virtual.id`, by default
 * `localmodel-auto/current`). Registering again replaces the definition, which
 * also refreshes the display limits shown before the first routed response.
 *
 * Every refusal is a warning, never a throw: a Strata model id equal to the
 * alias id would collide with the physical model (Pi rejects that), and losing
 * the alias must not take the provider registration down with it.
 */
function registerAliasModel(pi: ExtensionAPI): void {
	const cfg = config!;
	const alias = cfg.virtual;
	if (!alias.enabled) {
		return;
	}
	const collision = currentModels.find((model) => model.id === alias.id);
	if (collision) {
		console.warn(
			`[localmodel-auto] Strata serves the model id "${alias.id}", which collides with the alias "${cfg.providerId}/${alias.id}"; the alias is NOT registered. Set virtual.id to a different id in config.json.`,
		);
		return;
	}
	const requested = Array.isArray(alias.thinkingLevels) ? alias.thinkingLevels : [];
	const knownLevels = ALIAS_THINKING_LEVELS as readonly string[];
	const levels = requested.filter((level) => knownLevels.includes(level)) as AliasThinkingLevel[];
	const dropped = requested.filter((level) => !knownLevels.includes(level));
	if (dropped.length > 0) {
		console.warn(`[localmodel-auto] ignoring unknown virtual.thinkingLevels entries: ${dropped.join(", ")}`);
	}
	const firstUsable = currentModels.find((model) => isValidLimit(model.contextWindow) && isValidLimit(model.maxTokens));
	const definition: ExtensionVirtualModel = {
		provider: cfg.providerId,
		id: alias.id,
		name: alias.name,
		thinkingLevels: levels.length > 0 ? levels : ALIAS_THINKING_LEVELS,
		contextWindow: alias.contextWindow ?? firstUsable?.contextWindow,
		maxTokens: alias.maxTokens ?? firstUsable?.maxTokens,
		route: async (request, ctx) => {
			const providerId = cfg.providerId;
			const physicalOnly = (
				models: readonly { readonly provider: string; readonly id: string; readonly api: unknown }[],
			) => models.filter((model) => model.provider === providerId && String(model.api) !== VIRTUAL_MODEL_API);
			const pickTargets = () => {
				const available = physicalOnly(ctx.modelRegistry.getAvailable());
				// Auth may not have landed yet during startup; fall back to the full list
				// and let Pi's credential check decide rather than hiding the target.
				return available.length > 0 ? available : physicalOnly(ctx.modelRegistry.getAll());
			};
			let targets = pickTargets();
			// Probe at the start of a user turn (TTL-guarded) and whenever nothing is
			// registered, which usually means Strata has just finished loading.
			if (targets.length === 0 || request.reason === "user") {
				await refreshIfStrataChanged(targets.length === 0);
				targets = pickTargets();
			}
			const selection = selectAliasTarget(targets, cfg.virtual.preferredModel);
			if (!selection) {
				const known = ctx.modelRegistry
					.getAll()
					.filter((model) => model.provider === providerId && String(model.api) !== VIRTUAL_MODEL_API)
					.map((model) => model.id);
				throw new Error(
					`[localmodel-auto] the alias "${providerId}/${alias.id}" has no Strata model to route to. ` +
						(known.length > 0
							? `Registered but not available: ${known.join(", ")} (check the provider's credentials).`
							: "Strata looks like it is still loading or offline — run /strata-refresh once /v1/models lists the model.") +
						` (endpoint: ${cfg.baseUrl})`,
				);
			}
			if (selection.ambiguous) {
				const key = targets.map((model) => model.id).join("|");
				if (key !== warnedAmbiguousKey) {
					warnedAmbiguousKey = key;
					console.warn(
						`[localmodel-auto] Strata lists ${targets.length} models (${key}); the alias "${cfg.providerId}/${alias.id}" dispatches to "${selection.id}". Set virtual.preferredModel in config.json to pin one.`,
					);
				}
			}
			const model = ctx.modelRegistry.find(providerId, selection.id);
			if (!model) {
				throw new Error(
					`[localmodel-auto] the alias "${providerId}/${alias.id}" selected "${selection.id}", but it is not in the Pi model registry. Run /strata-refresh.`,
				);
			}
			return { model, thinkingLevel: request.thinkingLevel };
		},
	};
	try {
		pi.registerVirtualModel(definition);
	} catch (err) {
		console.warn(
			`[localmodel-auto] could not register the alias "${cfg.providerId}/${alias.id}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export default async function strataProviderExtension(pi: ExtensionAPI): Promise<void> {
	config = await loadConfig();

	// Best-effort initial discovery so /model shows models even before a refresh.
	await discoverAndStore();
	applyProvider(pi);
	apiRef = pi;
	registerAliasModel(pi);

	pi.registerCommand("strata-refresh", {
		description: `Re-discover models from Strata (${config!.baseUrl})`,
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await discoverAndStore();
			applyProvider(pi);
			registerAliasModel(pi);
			if (result.offline) {
				ctx.ui.notify(
					`Strata: refresh failed — ${result.error ?? "offline"}` +
						(currentModels.length > 0 ? `\nKept last-known models (${currentModels.length}).` : ""),
					"error",
				);
				return;
			}
			const count = result.models.length;
			const summary = count === 1 ? "model" : "models";
			ctx.ui.notify(`Strata: ${count} ${summary} discovered\n${formatModels(result.models)}`, "info");
		},
	});

	pi.registerCommand("strata-status", {
		description: `Show Strata endpoint status and discovered models (${config!.baseUrl})`,
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await discoverAndStore();
			const cfg = config!;
			const lines = [
				"Strata",
				`Endpoint: ${cfg.baseUrl}`,
				`Status: ${result.offline ? "offline" : "online"}`,
			];
			if (result.offline && result.error) {
				lines.push(`Error: ${result.error}`);
			}
			lines.push(`Models: ${result.models.length}`);
			if (result.models.length > 0) {
				lines.push(formatModels(result.models));
			}
			ctx.ui.notify(lines.join("\n"), result.offline ? "error" : "info");
		},
	});
}