import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	formatSkillsForPrompt,
	getAgentDir,
	loadSkillsFromDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";

const CONFIG_VERSION = 1;
const AVAILABLE_SKILLS_RE = /<available_skills>[\s\S]*?<\/available_skills>/m;
const CURRENT_WORKING_DIRECTORY_RE = /\nCurrent working directory:/;
const NAME_SEGMENT_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export type SkillExposure = "model-visible" | "manual-only";

interface PluginProjectionConfig {
	skills: Record<string, SkillExposure>;
}

interface ProjectionConfig {
	version: 1;
	plugins: Record<string, PluginProjectionConfig>;
}

interface InstalledPluginEntry {
	scope?: "user" | "project";
	installPath: string;
	version: string;
	enabled?: boolean;
}

interface InstalledPluginsRegistry {
	version: number;
	plugins: Record<string, InstalledPluginEntry[]>;
}

interface ExtensionOptions {
	agentDir?: string;
	configPath?: string;
}

interface ProjectionState {
	projected: Array<{ pluginId: string; skillName: string; exposure: SkillExposure; filePath: string }>;
	projectOverrides: string[];
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function canonicalExistingPath(path: string): string {
	return realpathSync(resolve(path));
}

function isContainedBy(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

function isValidPluginId(pluginId: string): boolean {
	const separator = pluginId.lastIndexOf("@");
	if (separator <= 0 || separator === pluginId.length - 1) return false;
	const name = pluginId.slice(0, separator);
	const marketplace = pluginId.slice(separator + 1);
	return (
		name.length <= 64 &&
		marketplace.length <= 64 &&
		NAME_SEGMENT_RE.test(name) &&
		NAME_SEGMENT_RE.test(marketplace)
	);
}

export function parseProjectionConfig(value: unknown): ProjectionConfig {
	if (!isRecord(value) || value.version !== CONFIG_VERSION || !isRecord(value.plugins)) {
		throw new Error(`config must contain version ${CONFIG_VERSION} and a plugins object`);
	}

	const plugins: Record<string, PluginProjectionConfig> = {};
	for (const [pluginId, rawPlugin] of Object.entries(value.plugins)) {
		if (!isValidPluginId(pluginId) || !isRecord(rawPlugin) || !isRecord(rawPlugin.skills)) {
			throw new Error(`invalid plugin projection: ${pluginId}`);
		}
		const skills: Record<string, SkillExposure> = {};
		for (const [skillName, exposure] of Object.entries(rawPlugin.skills)) {
			if (!skillName || (exposure !== "model-visible" && exposure !== "manual-only")) {
				throw new Error(
					`invalid exposure for ${pluginId}/${skillName}; expected model-visible or manual-only`,
				);
			}
			skills[skillName] = exposure;
		}
		plugins[pluginId] = { skills };
	}

	return { version: CONFIG_VERSION, plugins };
}

function parseInstalledRegistry(value: unknown, path: string): InstalledPluginsRegistry {
	if (!isRecord(value) || value.version !== 2 || !isRecord(value.plugins)) {
		throw new Error(`invalid marketplace registry: ${path}`);
	}
	const plugins: Record<string, InstalledPluginEntry[]> = {};
	for (const [pluginId, rawEntries] of Object.entries(value.plugins)) {
		if (!Array.isArray(rawEntries)) throw new Error(`invalid marketplace entries for ${pluginId}: ${path}`);
		const entries: InstalledPluginEntry[] = [];
		for (const rawEntry of rawEntries) {
			if (
				!isRecord(rawEntry) ||
				typeof rawEntry.installPath !== "string" ||
				typeof rawEntry.version !== "string" ||
				(rawEntry.scope !== undefined && rawEntry.scope !== "user" && rawEntry.scope !== "project") ||
				(rawEntry.enabled !== undefined && typeof rawEntry.enabled !== "boolean")
			) {
				throw new Error(`invalid marketplace entry for ${pluginId}: ${path}`);
			}
			entries.push({
				installPath: rawEntry.installPath,
				version: rawEntry.version,
				...(rawEntry.scope ? { scope: rawEntry.scope } : {}),
				...(typeof rawEntry.enabled === "boolean" ? { enabled: rawEntry.enabled } : {}),
			});
		}
		plugins[pluginId] = entries;
	}
	return { version: value.version, plugins };
}

async function readJson(path: string, optional = false): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function readRegistry(path: string, optional = false): Promise<InstalledPluginsRegistry | undefined> {
	const value = await readJson(path, optional);
	return value === undefined ? undefined : parseInstalledRegistry(value, path);
}

function projectRegistryPaths(cwd: string): string[] {
	return [
		join(cwd, ".pi", "marketplace", "installed_plugins.json"),
		join(cwd, ".agents", "marketplace", "installed_plugins.json"),
	];
}

function explicitProjectPluginIds(registries: readonly InstalledPluginsRegistry[]): Set<string> {
	const ids = new Set<string>();
	for (const registry of registries) {
		for (const pluginId of Object.keys(registry.plugins)) ids.add(pluginId);
	}
	return ids;
}

function selectedDisabledUserEntry(
	registry: InstalledPluginsRegistry,
	pluginId: string,
): InstalledPluginEntry | undefined {
	const userEntries = (registry.plugins[pluginId] ?? []).filter((entry) => (entry.scope ?? "user") === "user");
	if (userEntries.length === 0 || !userEntries.every((entry) => entry.enabled === false)) return undefined;
	return userEntries.at(-1);
}

function skillStanza(skill: Skill): string | undefined {
	return formatSkillsForPrompt([{ ...skill, disableModelInvocation: false }]).match(/  <skill>[\s\S]*?  <\/skill>/m)?.[0];
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function xmlContainsSkillLocation(value: string, filePath: string): boolean {
	return value.includes(`<location>${escapeXml(filePath)}</location>`);
}

function removeFirstSkillByLocation(value: string, filePath: string): string {
	let removed = false;
	return value.replace(AVAILABLE_SKILLS_RE, (xml) =>
		xml.replace(/  <skill>[\s\S]*?  <\/skill>\n?/g, (stanza) => {
			if (removed || !xmlContainsSkillLocation(stanza, filePath)) return stanza;
			removed = true;
			return "";
		}),
	);
}

function patchSkillsInSystemPrompt(
	systemPrompt: string,
	currentSkills: readonly Skill[],
	removeSkills: readonly Skill[],
	addSkills: readonly Skill[],
): string {
	const currentSection = formatSkillsForPrompt([...currentSkills]);
	const currentVisibleCount = currentSkills.filter((skill) => !skill.disableModelInvocation).length;
	if (
		addSkills.length === 0 &&
		removeSkills.length === currentVisibleCount &&
		currentSection &&
		systemPrompt.includes(currentSection)
	) {
		return systemPrompt.replace(currentSection, "");
	}

	let patched = systemPrompt;
	for (const skill of removeSkills) patched = removeFirstSkillByLocation(patched, skill.filePath);

	const existingXml = patched.match(AVAILABLE_SKILLS_RE)?.[0] ?? "";
	const additions = addSkills
		.filter((skill) => !xmlContainsSkillLocation(existingXml, skill.filePath))
		.map(skillStanza)
		.filter((stanza): stanza is string => Boolean(stanza));
	if (additions.length === 0) return patched;
	if (AVAILABLE_SKILLS_RE.test(patched)) {
		return patched.replace("</available_skills>", `${additions.join("\n")}\n</available_skills>`);
	}

	const addedSection = formatSkillsForPrompt(addSkills.map((skill) => ({ ...skill, disableModelInvocation: false })));
	const cwdMatch = patched.match(CURRENT_WORKING_DIRECTORY_RE);
	if (!cwdMatch || cwdMatch.index === undefined) return `${patched}${addedSection}`;
	return `${patched.slice(0, cwdMatch.index)}${addedSection}${patched.slice(cwdMatch.index)}`;
}

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(`[skill-projection] ${message}`);
}

export function createSkillProjectionExtension(pi: ExtensionAPI, options: ExtensionOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const configPath = options.configPath ?? join(agentDir, "skill-projection.json");
	let state: ProjectionState = { projected: [], projectOverrides: [], warnings: [] };
	let exposureByPath = new Map<string, SkillExposure>();

	pi.on("session_start", async (_event, ctx) => {
		state = { projected: [], projectOverrides: [], warnings: [] };
		exposureByPath = new Map<string, SkillExposure>();
	});

	pi.on("resources_discover", async (event, ctx) => {
		const warnings: string[] = [];
		let config: ProjectionConfig;
		let userRegistry: InstalledPluginsRegistry;
		let projectRegistries: InstalledPluginsRegistry[];

		try {
			const rawConfig = await readJson(configPath, true);
			if (rawConfig === undefined) {
				state = { projected: [], projectOverrides: [], warnings: [] };
				exposureByPath = new Map<string, SkillExposure>();
				return { skillPaths: [] };
			}
			config = parseProjectionConfig(rawConfig);
			const registryPath = join(agentDir, "marketplace", "installed_plugins.json");
			const parsedUserRegistry = await readRegistry(registryPath);
			if (!parsedUserRegistry) throw new Error(`marketplace registry not found: ${registryPath}`);
			userRegistry = parsedUserRegistry;
			projectRegistries = [];
			for (const path of projectRegistryPaths(event.cwd)) {
				const registry = await readRegistry(path, true);
				if (registry) projectRegistries.push(registry);
			}
		} catch (error) {
			state = {
				projected: [],
				projectOverrides: [],
				warnings: [error instanceof Error ? error.message : String(error)],
			};
			exposureByPath = new Map<string, SkillExposure>();
			report(ctx, `No skills projected: ${state.warnings[0]}`, "error");
			return { skillPaths: [] };
		}

		const projectOverrides = explicitProjectPluginIds(projectRegistries);
		const projected: ProjectionState["projected"] = [];
		const skillPaths = new Set<string>();
		const nextExposureByPath = new Map<string, SkillExposure>();

		for (const [pluginId, pluginConfig] of Object.entries(config.plugins)) {
			if (projectOverrides.has(pluginId)) continue;

			const entry = selectedDisabledUserEntry(userRegistry, pluginId);
			if (!entry) {
				warnings.push(
					`${pluginId} is not installed as a disabled user-scope marketplace plugin; projection skipped`,
				);
				continue;
			}

			let pluginRoot: string;
			let skillsRoot: string;
			try {
				pluginRoot = canonicalExistingPath(entry.installPath);
				skillsRoot = canonicalExistingPath(join(pluginRoot, "skills"));
			} catch (error) {
				warnings.push(
					`${pluginId} install or skills path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}

			const loaded = loadSkillsFromDir({ dir: skillsRoot, source: `projection:${pluginId}` });
			const byName = new Map(loaded.skills.map((skill) => [skill.name, skill]));
			for (const diagnostic of loaded.diagnostics) {
				if (diagnostic.type === "warning") warnings.push(`${pluginId}: ${diagnostic.message}`);
			}

			for (const [skillName, exposure] of Object.entries(pluginConfig.skills)) {
				const skill = byName.get(skillName);
				if (!skill) {
					warnings.push(`${pluginId} does not contain configured skill ${skillName}`);
					continue;
				}
				let filePath: string;
				try {
					filePath = canonicalExistingPath(skill.filePath);
				} catch (error) {
					warnings.push(
						`${pluginId}/${skillName} path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
				if (!isContainedBy(skillsRoot, filePath)) {
					warnings.push(`${pluginId}/${skillName} escapes the plugin skills directory; projection skipped`);
					continue;
				}
				skillPaths.add(filePath);
				projected.push({ pluginId, skillName, exposure, filePath });
				nextExposureByPath.set(filePath, exposure);
			}
		}

		state = {
			projected,
			projectOverrides: [...projectOverrides].filter((pluginId) => pluginId in config.plugins).sort(),
			warnings,
		};
		exposureByPath = nextExposureByPath;
		for (const warning of warnings) report(ctx, warning);
		return { skillPaths: [...skillPaths] };
	});

	pi.on("before_agent_start", async (event) => {
		if (exposureByPath.size === 0) return;
		const selectedTools = event.systemPromptOptions.selectedTools;
		if (selectedTools && !selectedTools.includes("read")) return;

		const skills = event.systemPromptOptions.skills ?? [];
		const removeSkills: Skill[] = [];
		const addSkills: Skill[] = [];
		for (const skill of skills) {
			if (skill.sourceInfo.scope === "project") continue;
			const exposure = exposureByPath.get(canonicalPath(skill.filePath));
			if (exposure === "manual-only" && !skill.disableModelInvocation) {
				removeSkills.push(skill);
			} else if (exposure === "model-visible" && skill.disableModelInvocation) {
				addSkills.push({ ...skill, disableModelInvocation: false });
			}
		}
		if (removeSkills.length === 0 && addSkills.length === 0) return;
		return {
			systemPrompt: patchSkillsInSystemPrompt(event.systemPrompt, skills, removeSkills, addSkills),
		};
	});

	pi.registerCommand("skill-projection", {
		description: "Show projected marketplace skills and their model exposure",
		handler: async (_args, ctx) => {
			const lines = state.projected.map(
				(item) => `- ${item.skillName} (${item.exposure}) from ${item.pluginId}`,
			);
			if (state.projectOverrides.length > 0) {
				lines.push(`Project overrides: ${state.projectOverrides.join(", ")}`);
			}
			if (state.warnings.length > 0) lines.push(`Warnings: ${state.warnings.join("; ")}`);
			const message = lines.length > 0 ? lines.join("\n") : "No marketplace skills are projected.";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else console.log(`[skill-projection]\n${message}`);
		},
	});
}

export default function skillProjection(pi: ExtensionAPI): void {
	createSkillProjectionExtension(pi);
}

export const __testing = {
	canonicalExistingPath,
	canonicalPath,
	explicitProjectPluginIds,
	isContainedBy,
	parseInstalledRegistry,
	projectRegistryPaths,
	patchSkillsInSystemPrompt,
	selectedDisabledUserEntry,
};
