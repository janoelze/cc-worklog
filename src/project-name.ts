import { readFile, stat, access } from "fs/promises";
import { join, basename, dirname } from "path";

interface ProjectNameResult {
  name: string;
  source: "package.json" | "git-remote" | "pyproject.toml" | "cargo.toml" | "go.mod" | "directory" | "path-segment";
  confidence: "high" | "medium" | "low";
}

/**
 * Try to extract project name from package.json
 */
async function fromPackageJson(projectPath: string): Promise<ProjectNameResult | null> {
  try {
    const pkgPath = join(projectPath, "package.json");
    const content = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    if (pkg.name && typeof pkg.name === "string" && !pkg.name.startsWith("@")) {
      return { name: pkg.name, source: "package.json", confidence: "high" };
    }
    // Scoped packages like @org/name - extract the name part
    if (pkg.name && pkg.name.includes("/")) {
      const name = pkg.name.split("/").pop();
      if (name) {
        return { name, source: "package.json", confidence: "high" };
      }
    }
  } catch {
    // File doesn't exist or invalid JSON
  }
  return null;
}

/**
 * Try to extract project name from git remote URL
 */
async function fromGitRemote(projectPath: string): Promise<ProjectNameResult | null> {
  try {
    const gitConfigPath = join(projectPath, ".git", "config");
    const content = await readFile(gitConfigPath, "utf-8");

    // Parse git config for remote origin URL
    const remoteMatch = content.match(/\[remote "origin"\][^\[]*url\s*=\s*(.+)/m);
    if (remoteMatch) {
      const url = remoteMatch[1].trim();
      // Extract repo name from various URL formats:
      // git@github.com:user/repo.git
      // https://github.com/user/repo.git
      // https://github.com/user/repo
      const repoMatch = url.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (repoMatch) {
        const repoName = repoMatch[2];
        return { name: repoName, source: "git-remote", confidence: "high" };
      }
    }
  } catch {
    // Not a git repo or can't read config
  }
  return null;
}

/**
 * Try to extract project name from pyproject.toml
 */
async function fromPyprojectToml(projectPath: string): Promise<ProjectNameResult | null> {
  try {
    const tomlPath = join(projectPath, "pyproject.toml");
    const content = await readFile(tomlPath, "utf-8");
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      return { name: nameMatch[1], source: "pyproject.toml", confidence: "high" };
    }
  } catch {
    // File doesn't exist
  }
  return null;
}

/**
 * Try to extract project name from Cargo.toml (Rust)
 */
async function fromCargoToml(projectPath: string): Promise<ProjectNameResult | null> {
  try {
    const tomlPath = join(projectPath, "Cargo.toml");
    const content = await readFile(tomlPath, "utf-8");
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      return { name: nameMatch[1], source: "cargo.toml", confidence: "high" };
    }
  } catch {
    // File doesn't exist
  }
  return null;
}

/**
 * Try to extract project name from go.mod
 */
async function fromGoMod(projectPath: string): Promise<ProjectNameResult | null> {
  try {
    const goModPath = join(projectPath, "go.mod");
    const content = await readFile(goModPath, "utf-8");
    const moduleMatch = content.match(/^module\s+(.+)/m);
    if (moduleMatch) {
      // Extract last path segment as project name
      const modulePath = moduleMatch[1].trim();
      const name = modulePath.split("/").pop();
      if (name) {
        return { name, source: "go.mod", confidence: "high" };
      }
    }
  } catch {
    // File doesn't exist
  }
  return null;
}

/**
 * Create a meaningful slug from path segments
 * /Users/jane/src/company/project/subdir -> "company-project-subdir" or just "project"
 */
function fromPathSegments(projectPath: string): ProjectNameResult {
  const parts = projectPath.split("/").filter(Boolean);

  // Common parent directories to skip (case-insensitive)
  // Note: "work" removed - it's often meaningful (e.g., "work/log")
  const skipDirs = new Set([
    "users", "home", "src", "projects", "code", "dev", "repos",
    "github", "gitlab", "documents", "desktop", "downloads",
    "var", "opt", "usr", "tmp", "private"
  ]);

  // Common username patterns to skip
  const usernamePattern = /^[a-z][a-z0-9_-]{2,20}$/i;

  // Find meaningful segments (after common dirs, skip usernames)
  const meaningfulParts: string[] = [];
  let skippedUsername = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith(".")) continue; // Skip hidden

    const lowerPart = part.toLowerCase();

    // Skip common directories
    if (skipDirs.has(lowerPart)) continue;

    // Skip what looks like a username (first non-skipped dir after /Users or /home)
    if (!skippedUsername && i > 0) {
      const prevLower = parts[i - 1]?.toLowerCase();
      if ((prevLower === "users" || prevLower === "home") && usernamePattern.test(part)) {
        skippedUsername = true;
        continue;
      }
    }

    meaningfulParts.push(part);
  }

  if (meaningfulParts.length === 0) {
    // Fallback to just the directory name
    return { name: basename(projectPath), source: "directory", confidence: "low" };
  }

  if (meaningfulParts.length === 1) {
    return { name: meaningfulParts[0], source: "path-segment", confidence: "medium" };
  }

  // For paths with 2+ meaningful parts, join them
  // But limit to last 3 to avoid overly long names
  const partsToUse = meaningfulParts.length > 3
    ? meaningfulParts.slice(-3)
    : meaningfulParts;

  const slug = partsToUse.join("-").toLowerCase();
  return { name: slug, source: "path-segment", confidence: "medium" };
}

/**
 * Detect the best project name for a given path
 * Tries multiple strategies in order of preference
 */
export async function detectProjectName(projectPath: string): Promise<ProjectNameResult> {
  // Check if directory exists first
  try {
    await access(projectPath);
  } catch {
    // Directory doesn't exist, use path-based detection only
    return fromPathSegments(projectPath);
  }

  // Try strategies in order of preference
  const strategies = [
    fromPackageJson,
    fromGitRemote,
    fromPyprojectToml,
    fromCargoToml,
    fromGoMod,
  ];

  for (const strategy of strategies) {
    const result = await strategy(projectPath);
    if (result) {
      return result;
    }
  }

  // Fallback to path-based naming
  return fromPathSegments(projectPath);
}

/**
 * Create a URL-safe slug from project name
 */
export function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
