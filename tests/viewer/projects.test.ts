import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listProjectTree, parseXrayFocus, projectRelativePath, readProjectParams, resolveProjectFile } from "../../src/viewer/projects.js";
import { ViewerServer } from "../../src/viewer/viewer-server.js";
import { parseViewArgs } from "../../src/view.js";

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "s3d-projects-"));
  outside = mkdtempSync(join(tmpdir(), "s3d-outside-"));
  mkdirSync(join(root, "lib/home"), { recursive: true });
  mkdirSync(join(root, "projects/desk/cad/scene"), { recursive: true });
  mkdirSync(join(root, "projects/desk/photos"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules/x"), { recursive: true });
  writeFileSync(join(root, "lib/home/params.scad"), [
    "desk_z_min = 720;",
    "desk_z = 720;        // [700:10:1300] desktop height",
    "mode = \"a\";         // [a, b, c]",
    "plain = 5;           // no annotation: not shown from an included file",
    "tagged = 9;          // [MEASURED] a status tag, not a choice list",
    "one = 2;             // [2] a single choice is not a list",
    "",
  ].join("\n"));
  writeFileSync(join(root, "lib/home/chest.scad"), "include <params.scad>\nmodule chest() { cube(10); }\nchest();\n");
  writeFileSync(join(root, "projects/desk/cad/scene/scene.scad"), [
    "include <../../../../lib/home/params.scad>",
    "show_cables = false;  // routes",
    "width = 40;           // [10:100]",
    "count = 3;            // plain number in the main file: not shown",
    "module m() {",
    "  inner = true;       // inside a module: not a parameter",
    "}",
    "desk_z = 800;         // redefined later without annotation",
    "cube(width);",
    "",
  ].join("\n"));
  writeFileSync(join(root, "projects/desk/photos/note.txt"), "x");
  writeFileSync(join(root, ".git/hidden.scad"), "cube(1);");
  writeFileSync(join(root, "node_modules/x/dep.scad"), "cube(1);");
  writeFileSync(join(outside, "secret.scad"), "cube(1);");
  symlinkSync(outside, join(root, "escape"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("listProjectTree", () => {
  it("lists folders and .scad files, skipping hidden, bulky, symlinked and empty folders", () => {
    const tree = listProjectTree(root);
    expect(tree.map((n) => n.name)).toEqual(["lib", "projects"]);
    const flat: string[] = [];
    const walk = (ns: typeof tree) => ns.forEach((n) => (n.type === "file" ? flat.push(n.path) : walk(n.children ?? [])));
    walk(tree);
    expect(flat).toEqual(["lib/home/chest.scad", "lib/home/params.scad", "projects/desk/cad/scene/scene.scad"]);
  });
});

describe("resolveProjectFile", () => {
  it("resolves a .scad file inside the root", () => {
    expect(resolveProjectFile(root, "lib/home/chest.scad")).toMatch(/lib\/home\/chest\.scad$/);
  });
  it.each([
    ["../outside.scad"],
    ["lib/../../x.scad"],
    ["/etc/passwd.scad"],
    ["escape/secret.scad"],
    ["lib/home/missing.scad"],
    ["projects/desk/photos/note.txt"],
    [42],
    [""],
  ])("rejects %s", (p) => {
    expect(() => resolveProjectFile(root, p)).toThrow();
  });
  it("gives paths relative to the root", () => {
    expect(projectRelativePath(root, join(root, "lib/home/chest.scad"))).toBe("lib/home/chest.scad");
    expect(projectRelativePath(root, join(outside, "secret.scad"))).toBeUndefined();
  });
});

describe("readProjectParams", () => {
  it("reads annotated params from includes, booleans/annotated from the main file", () => {
    const params = readProjectParams(join(root, "projects/desk/cad/scene/scene.scad"), root);
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["desk_z", "mode", "show_cables", "width"]);
    expect(byName.desk_z).toMatchObject({ type: "number", value: 800, min: 700, step: 10, max: 1300, description: "desktop height", file: "lib/home/params.scad" });
    expect(byName.mode).toMatchObject({ type: "string", value: "a", options: ["a", "b", "c"] });
    expect(byName.show_cables).toMatchObject({ type: "boolean", value: false, description: "routes" });
    expect(byName.width).toMatchObject({ min: 10, max: 100 });
  });
});

describe("parseViewArgs", () => {
  it("parses folder, port and --no-open", () => {
    expect(parseViewArgs([root, "--port", "6000", "--no-open"], {}, "/")).toEqual({ root, port: 6000, open: false });
    expect(parseViewArgs([], { OPENSCAD_PROJECTS_DIR: root }, "/").root).toBe(root);
    expect(() => parseViewArgs(["--port", "x"], {}, root)).toThrow();
    expect(() => parseViewArgs([join(root, "nope")], {}, "/")).toThrow();
  });
});

describe("ViewerServer project API", () => {
  let server: ViewerServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const rendered: Array<{ file: string; params: unknown }> = [];
  const start = async (projects = true) => {
    server = new ViewerServer(
      projects ? { projects: { root, render: async (file, params) => (rendered.push({ file, params }), { ok: true, version: 7 }) } } : {},
    );
    return server.start();
  };

  it("404s when no projects folder is configured", async () => {
    const url = await start(false);
    expect((await fetch(`${url}/api/projects`)).status).toBe(404);
  });

  it("serves the tree and the params of a file", async () => {
    const url = await start();
    const tree = await (await fetch(`${url}/api/projects`)).json();
    expect(tree.tree.map((n: { name: string }) => n.name)).toEqual(["lib", "projects"]);
    const res = await fetch(`${url}/api/params?path=${encodeURIComponent("projects/desk/cad/scene/scene.scad")}`);
    expect(res.status).toBe(200);
    expect((await res.json()).params.length).toBe(4);
    expect((await fetch(`${url}/api/params?path=${encodeURIComponent("../x.scad")}`)).status).toBe(400);
  });

  it("renders a file with params, and refuses bad input and foreign origins", async () => {
    const url = await start();
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}/api/render`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const ok = await post({ path: "lib/home/chest.scad", params: { desk_z: 900, show_cables: true } });
    expect(await ok.json()).toEqual({ ok: true, version: 7 });
    expect(rendered.at(-1)).toMatchObject({ params: { desk_z: 900, show_cables: true } });
    expect(rendered.at(-1)!.file).toMatch(/lib\/home\/chest\.scad$/);
    expect((await post({ path: "escape/secret.scad" })).status).toBe(400);
    expect((await post({ path: "lib/home/chest.scad", params: { x: { nested: 1 } } })).status).toBe(400);
    expect((await post({ path: "lib/home/chest.scad" }, { Origin: "https://evil.example" })).status).toBe(403);
  });

  it("listens on a fixed port when asked", async () => {
    server = new ViewerServer({ port: 0 });
    const url = await server.start();
    const port = Number(new URL(url).port);
    await server.stop();
    server = new ViewerServer({ port });
    expect(await server.start()).toBe(`http://localhost:${port}`);
  });
});

describe("parseXrayFocus", () => {
  it("reads the colour list from an echo line", () => {
    expect(parseXrayFocus(['"hello"', 'xray_focus = ["red", "#c0392b", "gold"]'])).toEqual(["red", "#c0392b", "gold"]);
  });
  it("ignores other lines, non-strings and bad syntax", () => {
    expect(parseXrayFocus(["x = 1"])).toBeUndefined();
    expect(parseXrayFocus(['xray_focus = ["red", 3, "blue"]'])).toEqual(["red", "blue"]);
    expect(parseXrayFocus(["xray_focus = [red]"])).toBeUndefined();
  });
});
