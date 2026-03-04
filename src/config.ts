import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// Config file location
const CONFIG_DIR = join(homedir(), ".cc-worklog");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Config structure
export interface Config {
  output: {
    directory: string;
  };
  state: {
    directory: string;
  };
  openai: {
    model: string;
    apiKey: string;
  };
}

// Runtime overrides (from CLI flags)
interface RuntimeOverrides {
  outputDirectory?: string;
  model?: string;
}

let runtimeOverrides: RuntimeOverrides = {};

/**
 * Set runtime overrides from CLI flags
 */
export function setRuntimeOverrides(overrides: RuntimeOverrides): void {
  runtimeOverrides = overrides;
}

/**
 * Get default config values
 */
function getDefaults(): Config {
  return {
    output: {
      directory: join(homedir(), ".cc-worklog", "output"),
    },
    state: {
      directory: join(homedir(), ".cc-worklog"),
    },
    openai: {
      model: "gpt-4o-mini",
      apiKey: "",
    },
  };
}

/**
 * Load config from file (returns only user-set values)
 */
async function loadConfigFile(): Promise<Partial<Config>> {
  try {
    const content = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as Partial<Config>;
  } catch {
    return {};
  }
}

/**
 * Save config to file
 */
async function saveConfigFile(config: Partial<Config>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Deep merge two config objects
 */
function mergeConfig(base: Config, overrides: Partial<Config>): Config {
  return {
    output: {
      ...base.output,
      ...overrides.output,
    },
    state: {
      ...base.state,
      ...overrides.state,
    },
    openai: {
      ...base.openai,
      ...overrides.openai,
    },
  };
}

/**
 * Get environment variable overrides
 */
function getEnvOverrides(): Partial<Config> {
  const overrides: Partial<Config> = {};

  if (process.env.CC_WORKLOG_OUTPUT_DIR) {
    overrides.output = { directory: process.env.CC_WORKLOG_OUTPUT_DIR };
  }

  if (process.env.CC_WORKLOG_STATE_DIR) {
    overrides.state = { directory: process.env.CC_WORKLOG_STATE_DIR };
  }

  if (process.env.CC_WORKLOG_MODEL || process.env.OPENAI_API_KEY) {
    overrides.openai = {
      ...(process.env.CC_WORKLOG_MODEL && { model: process.env.CC_WORKLOG_MODEL }),
      ...(process.env.OPENAI_API_KEY && { apiKey: process.env.OPENAI_API_KEY }),
    };
  }

  return overrides;
}

/**
 * Get runtime overrides as partial config
 */
function getRuntimeOverridesAsConfig(): Partial<Config> {
  const overrides: Partial<Config> = {};

  if (runtimeOverrides.outputDirectory) {
    overrides.output = { directory: runtimeOverrides.outputDirectory };
  }

  if (runtimeOverrides.model) {
    overrides.openai = { model: runtimeOverrides.model };
  }

  return overrides;
}

/**
 * Load resolved config (defaults + file + env + runtime)
 */
export async function getConfig(): Promise<Config> {
  const defaults = getDefaults();
  const fileConfig = await loadConfigFile();
  const envOverrides = getEnvOverrides();
  const runtimeConfig = getRuntimeOverridesAsConfig();

  // Resolution order: defaults < file < env < runtime
  let config = mergeConfig(defaults, fileConfig);
  config = mergeConfig(config, envOverrides);
  config = mergeConfig(config, runtimeConfig);

  return config;
}

/**
 * Get a single config value by dot-notation key
 */
export async function getConfigValue(key: string): Promise<string | undefined> {
  const config = await getConfig();
  const parts = key.split(".");

  let value: unknown = config;
  for (const part of parts) {
    if (value && typeof value === "object" && part in value) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return typeof value === "string" ? value : undefined;
}

/**
 * Set a config value by dot-notation key
 */
export async function setConfigValue(key: string, value: string): Promise<void> {
  const fileConfig = await loadConfigFile();
  const parts = key.split(".");

  if (parts.length !== 2) {
    throw new Error(`Invalid config key: ${key}`);
  }

  const [section, field] = parts;

  // Validate key
  const validKeys = [
    "output.directory",
    "state.directory",
    "openai.model",
    "openai.apiKey",
  ];
  if (!validKeys.includes(key)) {
    throw new Error(`Unknown config key: ${key}. Valid keys: ${validKeys.join(", ")}`);
  }

  // Expand ~ in paths
  const expandedValue = value.startsWith("~")
    ? join(homedir(), value.slice(1))
    : value;

  // Set the value
  if (!fileConfig[section as keyof Config]) {
    (fileConfig as Record<string, Record<string, string>>)[section] = {};
  }
  (fileConfig as Record<string, Record<string, string>>)[section][field] = expandedValue;

  await saveConfigFile(fileConfig);
}

/**
 * Unset a config value (reset to default)
 */
export async function unsetConfigValue(key: string): Promise<void> {
  const fileConfig = await loadConfigFile();
  const parts = key.split(".");

  if (parts.length !== 2) {
    throw new Error(`Invalid config key: ${key}`);
  }

  const [section, field] = parts;

  if (fileConfig[section as keyof Config]) {
    delete (fileConfig as Record<string, Record<string, string>>)[section][field];

    // Remove empty section
    if (Object.keys((fileConfig as Record<string, Record<string, string>>)[section]).length === 0) {
      delete (fileConfig as Record<string, unknown>)[section];
    }
  }

  await saveConfigFile(fileConfig);
}

/**
 * Get config file path
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Get all config values with their sources for display
 */
export async function getConfigWithSources(): Promise<
  Array<{ key: string; value: string; source: string }>
> {
  const defaults = getDefaults();
  const fileConfig = await loadConfigFile();
  const envOverrides = getEnvOverrides();
  const resolved = await getConfig();

  const entries: Array<{ key: string; value: string; source: string }> = [];

  const keys = [
    "output.directory",
    "state.directory",
    "openai.model",
    "openai.apiKey",
  ];

  for (const key of keys) {
    const parts = key.split(".");
    const [section, field] = parts;

    const resolvedValue = (resolved as Record<string, Record<string, string>>)[section][field];

    // Determine source
    let source = "default";

    if (runtimeOverrides.outputDirectory && key === "output.directory") {
      source = "cli";
    } else if (runtimeOverrides.model && key === "openai.model") {
      source = "cli";
    } else if (
      envOverrides[section as keyof Config] &&
      (envOverrides as Record<string, Record<string, string>>)[section][field]
    ) {
      source = "env";
    } else if (
      fileConfig[section as keyof Config] &&
      (fileConfig as Record<string, Record<string, string>>)[section][field]
    ) {
      source = "config.json";
    }

    // Redact API key
    let displayValue = resolvedValue || "";
    if (key === "openai.apiKey" && displayValue) {
      displayValue = displayValue.slice(0, 7) + "..." + displayValue.slice(-4);
    }

    entries.push({ key, value: displayValue, source });
  }

  return entries;
}
