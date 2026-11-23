import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Token cost rates (per one million tokens). */
export interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Default metadata applied to every discovered Strata model. */
export interface ModelDefaults {
	/**
	 * Configured default context window. Optional: it is only used as a last
	 * resort (precedence 3) when Strata does not report `meta.n_ctx` and there
	 * is no per-model override. There is intentionally NO hardcoded fallback in
	 * code — config.json is the single editable source of truth. `undefined`
	 * means "unavailable", never an invented number.
	 */
	contextWindow?: number;
	/**
	 * Configured default max output tokens. config.json is the single editable
	 * source of truth. `undefined` means "unavailable". We NEVER derive it from
	 * the context window (no /2, /4, 90% formulas) because Strata does not expose
	 * a reliable max_tokens field.
	 */
	maxTokens?: number;
	reasoning: boolean;
	input: string[];
	cost: Cost;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string>;
}

/** Optional per-model overrides keyed by the Strata model id. */
export interface ModelOverride {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	cost?: Partial<Cost>;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string>;
}

/**
 * Configuration for the stable alias model (`localmodel-auto/current`).
 *
 * The alias is a Pi *virtual* model: it is selectable in `/model`, `--model`,
 * settings, and subagent configs, but it never reaches Strata. `route()` picks
 * the physical Strata model registered under the provider id, so every request
 * carries the id Strata actually serves. That makes configs provider-stable:
 * swapping the loaded model or its quantization needs no config edits.
 */
export interface VirtualModelConfig {
	/** Register the alias. Set false to keep provider-only behaviour. */
	enabled: boolean;
	/** Stable model id under `providerId`. Keep it distinct from any Strata model id. */
	id: string;
	/** Display name for the alias in `/model`. */
	name: string;
	/** Thinking levels offered for the alias selection; unknown values are dropped. */
	thinkingLevels: string[];
	/**
	 * Limits shown for the alias before its first routed response. Unset means
	 * "unknown"; afterwards Pi uses the routed model's limits, so these are only
	 * a display/first-turn fallback and never invent a value in code.
	 */
	contextWindow?: number;
	/** See `contextWindow`. */
	maxTokens?: number;
	/**
	 * Substring hint (case-insensitive) used to pick one model when Strata lists
	 * several. Unused when exactly one model is registered.
	 */
	preferredModel?: string;
	/**
	 * Minimum ms between live `/v1/models` probes made by `route()`, so a Strata
	 * model swap is picked up without editing config or running `/strata-refresh`.
	 * 0 disables probing (then `/strata-refresh` or a Pi restart is required).
	 */
	autoRefreshProbeMs: number;
}

/** Runtime configuration for the localmodel-auto provider. */
export interface StrataConfig {
	/** Pi provider id (registered with pi.registerProvider). */
	providerId: string;
	/** Provider display name. */
	name: string;
	/** Strata OpenAI-compatible base URL. */
	baseUrl: string;
	/** Dummy API key for the local, keyless endpoint. */
	apiKey: string;
	/** Pi API implementation used to talk to Strata. */
	api: string;
	/** How long to wait for the /models request before giving up. */
	timeoutMs: number;
	/** Model metadata defaults for discovered models. */
	defaults: ModelDefaults;
	/** Per-model overrides keyed by model id. */
	models: Record<string, ModelOverride>;
	/** Stable alias model (`localmodel-auto/<virtual.id>`) configuration. */
	virtual: VirtualModelConfig;
}

/**
 * Non-limit configuration defaults. Model-limit values (contextWindow,
 * maxTokens) intentionally have NO hardcoded fallback here: config.json is the
 * single editable source of truth for maxTokens, and Strata's live `meta.n_ctx`
 * is preferred for contextWindow. A missing value is left `undefined` so
 * callers can detect "unavailable" and warn instead of silently inventing a
 * model-specific limit.
 */
export const DEFAULT_CONFIG: StrataConfig = {
	providerId: "localmodel-auto",
	name: "LocalModel Auto",
	baseUrl: "http://127.0.0.1:8080/v1",
	apiKey: "local",
	api: "openai-completions",
	timeoutMs: 2500,
	defaults: {
		contextWindow: undefined,
		maxTokens: undefined,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsReasoningEffort: true },
		thinkingLevelMap: {
			off: "none",
			minimal: "none",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
			max: "high",
		},
	},
	models: {},
	virtual: {
		enabled: true,
		id: "current",
		name: "Strata (current)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		preferredModel: undefined,
		autoRefreshProbeMs: 5000,
	},
};

/**
 * Load the package-local config.json (optional). Missing or invalid values stay
 * `undefined` rather than falling back to a hardcoded model limit. Overrides in
 * the JSON are merged over DEFAULT_CONFIG.
 */
export function loadConfig(configPath?: string): StrataConfig {
	let raw: unknown;
	const resolved = configPath ?? resolveDefaultConfigPath();
	if (resolved && existsSync(resolved)) {
		try {
			// Strip a UTF-8 BOM (config editors often add one), which otherwise
			// makes JSON.parse reject valid files and silently falls back to
			// DEFAULT_CONFIG — turning the editable config.json into a lie.
			const text = readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
			raw = JSON.parse(text);
		} catch {
			raw = undefined;
		}
	}
	if (!raw || typeof raw !== "object") {
		return {
			...DEFAULT_CONFIG,
			defaults: { ...DEFAULT_CONFIG.defaults },
			models: {},
			virtual: { ...DEFAULT_CONFIG.virtual },
		};
	}
	return mergeConfig(DEFAULT_CONFIG, raw as Record<string, unknown>);
}

function resolveDefaultConfigPath(): string | undefined {
	try {
		// config.ts lives at <pkg>/src/config.ts; the package config.json is one level up.
		const here = fileURLToPath(import.meta.url);
		return fileURLToPath(new URL("../config.json", pathToFileURL(here)));
	} catch {
		return undefined;
	}
}

function mergeConfig(base: StrataConfig, raw: Record<string, unknown>): StrataConfig {
	const merged: StrataConfig = {
		...base,
		providerId: str(raw.providerId, base.providerId),
		name: str(raw.name, base.name),
		baseUrl: str(raw.baseUrl, base.baseUrl),
		apiKey: str(raw.apiKey, base.apiKey),
		api: str(raw.api, base.api),
		timeoutMs: num(raw.timeoutMs, base.timeoutMs),
		defaults: {
			...base.defaults,
			cost: { ...base.defaults.cost },
		},
		models: {},
		virtual: { ...base.virtual },
	};
	if (raw.defaults && typeof raw.defaults === "object") {
		const d = raw.defaults as Record<string, unknown>;
		if (d.contextWindow !== undefined) merged.defaults.contextWindow = numOrUndefined(d.contextWindow);
		if (d.maxTokens !== undefined) merged.defaults.maxTokens = numOrUndefined(d.maxTokens);
		if (d.reasoning !== undefined) merged.defaults.reasoning = bool(d.reasoning, base.defaults.reasoning);
		if (d.input !== undefined && Array.isArray(d.input)) merged.defaults.input = d.input as string[];
		if (d.cost && typeof d.cost === "object") {
			merged.defaults.cost = { ...base.defaults.cost, ...(d.cost as object) };
		}
		if (d.compat && typeof d.compat === "object") merged.defaults.compat = d.compat as Record<string, unknown>;
		if (d.thinkingLevelMap && typeof d.thinkingLevelMap === "object")
			merged.defaults.thinkingLevelMap = d.thinkingLevelMap as Record<string, string>;
	}
	if (raw.virtual && typeof raw.virtual === "object") {
		const v = raw.virtual as Record<string, unknown>;
		if (v.enabled !== undefined) merged.virtual.enabled = bool(v.enabled, base.virtual.enabled);
		if (v.id !== undefined) merged.virtual.id = str(v.id, base.virtual.id);
		if (v.name !== undefined) merged.virtual.name = str(v.name, base.virtual.name);
		if (Array.isArray(v.thinkingLevels))
			merged.virtual.thinkingLevels = v.thinkingLevels.filter((level): level is string => typeof level === "string" && level.length > 0);
		if (v.contextWindow !== undefined) merged.virtual.contextWindow = numOrUndefined(v.contextWindow);
		if (v.maxTokens !== undefined) merged.virtual.maxTokens = numOrUndefined(v.maxTokens);
		if (v.preferredModel !== undefined)
			merged.virtual.preferredModel =
				typeof v.preferredModel === "string" && v.preferredModel.trim().length > 0 ? v.preferredModel.trim() : undefined;
		if (v.autoRefreshProbeMs !== undefined) merged.virtual.autoRefreshProbeMs = num(v.autoRefreshProbeMs, base.virtual.autoRefreshProbeMs);
	}
	if (raw.models && typeof raw.models === "object") {
		for (const [id, ov] of Object.entries(raw.models as Record<string, unknown>)) {
			if (!ov || typeof ov !== "object") continue;
			const o = ov as Record<string, unknown>;
			const override: ModelOverride = {};
			if (o.name !== undefined) override.name = o.name as string;
			if (o.contextWindow !== undefined) override.contextWindow = numOrUndefined(o.contextWindow);
			if (o.maxTokens !== undefined) override.maxTokens = numOrUndefined(o.maxTokens);
			if (o.reasoning !== undefined) override.reasoning = bool(o.reasoning, base.defaults.reasoning);
			if (o.input !== undefined && Array.isArray(o.input)) override.input = o.input as string[];
			if (o.cost && typeof o.cost === "object") override.cost = o.cost as Partial<Cost>;
			if (o.compat && typeof o.compat === "object") override.compat = o.compat as Record<string, unknown>;
			if (o.thinkingLevelMap && typeof o.thinkingLevelMap === "object")
				override.thinkingLevelMap = o.thinkingLevelMap as Record<string, string>;
			merged.models[id] = override;
		}
	}
	return merged;
}

function str(v: unknown, fallback: string): string {
	return typeof v === "string" && v.length > 0 ? v : fallback;
}
function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}
function numOrUndefined(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}