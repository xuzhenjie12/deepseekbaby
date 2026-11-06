/**
 * Path resolution for the fs tools.
 *
 * Two modes:
 *  - `computer` (default): absolute paths may point anywhere; relative paths
 *    resolve against the workspace root. Optional `roots` narrows this.
 *  - `workspace`: every path must stay inside the workspace root.
 *
 * In both modes the deepest existing ancestor is realpath-ed first, so a
 * symlink cannot be used to slip outside the allowed roots.
 */
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

function defaultRoot(ctx) {
  try {
    const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : undefined;
    if (registry && typeof registry.list === "function") {
      const workspaces = registry.list();
      const first = Array.isArray(workspaces) ? workspaces.find((item) => item && typeof item.path === "string") : undefined;
      if (first) return first.path;
    }
  } catch (error) {
    // Fall through to the DSH default directory.
  }
  try {
    const service = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
    const value = service && typeof service.defaultDirectory === "string" ? service.defaultDirectory : "";
    if (value) return value;
  } catch (error) {
    // Fall through to the process directory.
  }
  return process.cwd();
}

export function createWorkspace(cfg, ctx) {
  const configured = cfg.workspaceRoot;
  let rootPromise = null;
  let rootsPromise = null;
  // Set for the duration of one turn: a main task's own workspace.
  let taskRoot = null;

  /** Configured root, else the newest DSH session's cwd, else the first registered workspace. */
  async function resolveDefaultRoot() {
    try {
      const query = typeof ctx.get === "function" ? ctx.get("sessionQuery") : undefined;
      if (query && typeof query.listSessions === "function") {
        const records = await query.listSessions();
        const newest = Array.isArray(records) ? records[0] : undefined;
        const cwd = newest && newest.header ? newest.header.cwd : "";
        if (typeof cwd === "string" && cwd) {
          const info = await fs.stat(cwd).catch(() => null);
          if (info && info.isDirectory()) return cwd;
        }
      }
    } catch (error) {
      // Fall through to the registry default.
    }
    return defaultRoot(ctx);
  }

  async function deploymentRoot() {
    if (rootPromise === null) {
      rootPromise = (configured ? fs.realpath(configured).catch(() => resolve(configured)) : resolveDefaultRoot())
        .then((value) => fs.realpath(value).catch(() => resolve(value)));
    }
    return rootPromise;
  }

  async function root() {
    if (taskRoot !== null) return taskRoot;
    return deploymentRoot();
  }

  /**
   * Point the tools at one main task's workspace. While set, that directory is
   * also the only allowed root, so sibling tasks cannot read each other's files.
   * `null` restores the deployment default (legacy tasks without a workspace).
   */
  function setRoot(value) {
    taskRoot = typeof value === "string" && value.trim() ? value : null;
    rootsPromise = null;
  }

  /** Allowed roots, or null when any path is allowed. Resolution is lazy and cached. */
  async function allowedRoots() {
    if (taskRoot !== null) return [taskRoot];
    if (rootsPromise === null) {
      rootsPromise = (async () => {
        if (Array.isArray(cfg.roots) && cfg.roots.length > 0) {
          const list = [];
          for (const item of cfg.roots) {
            const absolute = resolve(item);
            list.push(await fs.realpath(absolute).catch(() => absolute));
          }
          return list;
        }
        if (cfg.fileAccess === "workspace") return [await root()];
        return null;
      })();
    }
    return rootsPromise;
  }

  /** Resolve symlinks on the deepest existing ancestor, then append missing parts. */
  async function realish(absolute) {
    const pending = [];
    let current = absolute;
    for (;;) {
      try {
        const real = await fs.realpath(current);
        return pending.length === 0 ? real : join(real, ...pending.reverse());
      } catch (error) {
        const parent = dirname(current);
        if (parent === current) throw new Error("path outside allowed roots");
        pending.push(basename(current));
        current = parent;
      }
    }
  }

  /** Resolve one user-supplied path; throws the stable `path outside allowed roots`. */
  async function resolveIn(inputPath) {
    if (typeof inputPath !== "string" || inputPath.trim() === "") {
      throw new Error("invalid path");
    }
    const base = await root();
    const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(base, inputPath);
    const real = await realish(absolute);
    const roots = await allowedRoots();
    if (roots !== null) {
      const allowed = roots.some((allowedRoot) => {
        const rel = relative(allowedRoot, real);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      });
      if (!allowed) throw new Error("path outside allowed roots");
    }
    return real;
  }

  return { root, resolveIn, setRoot, allowedRoots, defaultRoot: deploymentRoot };
}
