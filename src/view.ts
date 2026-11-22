/**
 * Standalone viewer: `sketchpad-3d-model-mcp view [folder] [--port N] [--no-open]`.
 * Serves the browser viewer with the project browser for `folder`, without an
 * MCP client. Runs until Ctrl+C.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "./config.js";
import { WasmEngine } from "./engine/index.js";
import { expandHome } from "./engine/source.js";
import { ModelService } from "./model-service.js";
import { createProjectRenderer } from "./project-render.js";
import { openInBrowser } from "./server.js";
import { ViewerServer } from "./viewer/index.js";

export const DEFAULT_VIEW_PORT = 5317;

export interface ViewArgs {
  root: string;
  port: number;
  open: boolean;
}

export function parseViewArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ViewArgs {
  let folder: string | undefined;
  let port = DEFAULT_VIEW_PORT;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port "${argv[i]}"`);
    } else if (a === "--no-open") open = false;
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}`);
    else folder = a;
  }
  const root = resolve(cwd, expandHome(folder ?? env.OPENSCAD_PROJECTS_DIR ?? "."));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Not a folder: ${root}`);
  return { root, port, open };
}

export async function runView(argv: string[]): Promise<void> {
  const log = (m: string) => console.error(`[sketchpad-3d] ${m}`);
  const args = parseViewArgs(argv);
  const { config, warnings } = readConfig();
  warnings.forEach(log);

  const engine = new WasmEngine({ timeoutMs: config.timeoutMs });
  const models = new ModelService(engine);
  const viewer = new ViewerServer({ port: args.port });
  viewer.setProjects(createProjectRenderer(models, viewer, args.root));

  let url: string;
  try {
    url = await viewer.start();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const existing = `http://localhost:${args.port}`;
      log(`Port ${args.port} is busy — a viewer is probably already running at ${existing}`);
      if (args.open) openInBrowser(existing);
      await engine.dispose();
      return;
    }
    throw e;
  }
  log(`Viewer for ${args.root}: ${url}  (Ctrl+C to stop)`);
  if (args.open) openInBrowser(url);

  const shutdown = async () => {
    await viewer.stop().catch(() => {});
    await engine.dispose().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
