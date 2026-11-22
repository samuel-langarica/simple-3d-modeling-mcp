/**
 * Project browser: lists the .scad files under a root folder, resolves paths
 * the page sends back (never leaving the root), and reads the adjustable
 * parameters of a file (OpenSCAD Customizer-style annotations).
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { UserError } from "../errors.js";

export interface ProjectNode {
  name: string;
  /** Path relative to the root, with "/" separators. */
  path: string;
  type: "dir" | "file";
  children?: ProjectNode[];
}

const SKIP_DIRS = new Set(["node_modules", "exports", "raw", "dist", "assets"]);
const MAX_DEPTH = 10;
const MAX_ENTRIES = 5000;

/**
 * Folders and .scad files under `root`. Hidden entries, symbolic links and a few
 * bulky folders are skipped; folders without any .scad file are left out.
 */
export function listProjectTree(root: string): ProjectNode[] {
  let budget = MAX_ENTRIES;
  const walk = (abs: string, rel: string, depth: number): ProjectNode[] => {
    if (depth > MAX_DEPTH) return [];
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const out: ProjectNode[] = [];
    for (const e of entries) {
      if (--budget < 0) break;
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const children = walk(resolve(abs, e.name), childRel, depth + 1);
        if (children.length) out.push({ name: e.name, path: childRel, type: "dir", children });
      } else if (e.isFile() && extname(e.name).toLowerCase() === ".scad") {
        out.push({ name: e.name, path: childRel, type: "file" });
      }
    }
    return out;
  };
  return walk(root, "", 0);
}

/**
 * Turns a path the page sent into an absolute path of a .scad file inside the
 * root. Rejects absolute paths, "..", and anything whose real path (symbolic
 * links followed) lands outside the root.
 */
export function resolveProjectFile(root: string, relPath: unknown): string {
  if (typeof relPath !== "string" || !relPath || relPath.length > 1024) throw new UserError("Invalid path");
  if (isAbsolute(relPath) || relPath.split(/[\\/]/).some((p) => p === "..")) throw new UserError("Invalid path");
  if (extname(relPath).toLowerCase() !== ".scad") throw new UserError("Not a .scad file");
  const rootReal = realpathSync(root);
  let real: string;
  try {
    real = realpathSync(resolve(rootReal, relPath));
  } catch {
    throw new UserError("File not found");
  }
  if (!real.startsWith(rootReal + sep)) throw new UserError("Invalid path");
  if (!statSync(real).isFile()) throw new UserError("File not found");
  return real;
}

/** `abs` relative to the root ("a/b.scad"), or undefined when it is outside. */
export function projectRelativePath(root: string, abs: string): string | undefined {
  try {
    const rootReal = realpathSync(root);
    const real = realpathSync(abs);
    if (!real.startsWith(rootReal + sep)) return undefined;
    return relative(rootReal, real).split(sep).join("/");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface ProjectParam {
  name: string;
  type: "number" | "boolean" | "string";
  value: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  /** Choices, from a `// [a, b, c]` annotation. */
  options?: Array<number | string>;
  /** Text of the comment after the annotation (or the whole comment when there is none). */
  description?: string;
  /** File (relative to the root when possible) that defines it. */
  file: string;
}

// name = literal;   // optional comment
const ASSIGN_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?|true|false|"(?:[^"\\]|\\.)*")\s*;\s*(?:\/\/\s*(.*))?$/;
const INCLUDE_RE = /^\s*include\s*<([^>\n]+)>/;

function parseLiteral(raw: string): number | boolean | string {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  return Number(raw);
}

/**
 * Parses "[min:max]", "[min:step:max]" or "[a, b, c]" at the start of a comment.
 * A choice list needs at least two choices of the value's type, so tags such as
 * "// [MEASURED]" or "// [GUESS]" on a number are not mistaken for one.
 */
function parseAnnotation(comment: string, value: number | boolean | string): { ann?: Partial<ProjectParam>; rest: string } {
  const m = /^\[([^\]]*)\]\s*(.*)$/.exec(comment.trim());
  if (!m) return { rest: comment.trim() };
  const body = m[1].trim();
  const rest = m[2].trim();
  if (body.includes(":")) {
    const nums = body.split(":").map((s) => Number(s.trim()));
    if (nums.every(Number.isFinite)) {
      if (nums.length === 2) return { ann: { min: nums[0], max: nums[1] }, rest };
      if (nums.length === 3) return { ann: { min: nums[0], step: nums[1], max: nums[2] }, rest };
    }
    return { rest: comment.trim() };
  }
  const options = body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (Number.isFinite(Number(s)) ? Number(s) : s.replace(/^"(.*)"$/, "$1")));
  const sameType = options.every((o) => typeof o === typeof value || (typeof value === "string" && typeof o === "number"));
  if (options.length < 2 || typeof value === "boolean" || !sameType) return { rest: comment.trim() };
  return { ann: { options: typeof value === "string" ? options.map(String) : options }, rest };
}

/**
 * Adjustable parameters of a .scad file:
 *  - in the main file: every top-level literal assignment that is a boolean, or
 *    carries a Customizer annotation (`x = 5; // [0:10]`);
 *  - in files it `include`s (recursively): annotated ones only.
 * A later definition replaces an earlier one, as in OpenSCAD.
 */
export function readProjectParams(mainFile: string, root?: string): ProjectParam[] {
  const found = new Map<string, ProjectParam>();
  const seen = new Set<string>();
  const label = (abs: string) => (root && projectRelativePath(root, abs)) || basename(abs);

  const visit = (abs: string, isMain: boolean) => {
    if (seen.has(abs) || seen.size > 200) return;
    seen.add(abs);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    let depth = 0; // only top-level assignments (outside modules/functions/blocks)
    for (const line of text.split(/\r?\n/)) {
      const inc = depth === 0 ? INCLUDE_RE.exec(line) : null;
      if (inc) {
        const target = resolve(dirname(abs), inc[1].trim());
        try {
          if (lstatSync(target).isFile()) visit(target, false);
        } catch {
          // library include (e.g. BOSL2) or missing file
        }
      }
      const m = depth === 0 ? ASSIGN_RE.exec(line) : null;
      if (m) {
        const [, name, raw, comment = ""] = m;
        const value = parseLiteral(raw);
        const { ann, rest } = parseAnnotation(comment, value);
        const type = typeof value as ProjectParam["type"];
        if (isMain ? ann || type === "boolean" : ann) {
          found.delete(name);
          found.set(name, { name, type, value, ...ann, description: rest || undefined, file: label(abs) });
        } else if (found.has(name)) {
          found.get(name)!.value = value; // redefined later without annotation: keep the control, update the default
        }
      }
      const code = line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, "");
      for (const ch of code) {
        if (ch === "{") depth++;
        else if (ch === "}") depth = Math.max(0, depth - 1);
      }
    }
  };

  visit(resolve(mainFile), true);
  return [...found.values()];
}

/**
 * Colours a model marks as its focus for the viewer's X-ray mode, from an
 * `echo(xray_focus = ["red", "#c0392b", …]);` line in its echo output.
 */
export function parseXrayFocus(echo: readonly string[]): string[] | undefined {
  for (const line of echo) {
    const m = /^\s*xray_focus\s*=\s*(\[.*\])\s*$/.exec(line);
    if (!m) continue;
    try {
      const list = JSON.parse(m[1]);
      if (Array.isArray(list)) return list.filter((x): x is string => typeof x === "string").slice(0, 64);
    } catch {
      // not a plain list of strings
    }
  }
  return undefined;
}
