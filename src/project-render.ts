/**
 * Renders a .scad file from the projects folder on behalf of the viewer page
 * and pushes the result to the viewer, like a render tool call would.
 */

import { basename } from "node:path";
import { paramAssignments } from "./engine/params.js";
import { prepareSource } from "./engine/source.js";
import type { Params } from "./engine/types.js";
import type { ModelService } from "./model-service.js";
import { projectRelativePath } from "./viewer/projects.js";
import type { ProjectsConfig, ViewerServer } from "./viewer/viewer-server.js";

export function createProjectRenderer(models: ModelService, viewer: ViewerServer, root: string): ProjectsConfig {
  return {
    root,
    async render(file: string, params: Params | undefined) {
      const src = prepareSource({ file });
      const outcome = await models.getModel(src, params);
      if (!outcome.ok) {
        const errors = outcome.log.errors.length ? outcome.log.errors : ["OpenSCAD produced no geometry."];
        return { ok: false, errors, warnings: outcome.log.warnings };
      }
      const { model } = outcome;
      const rel = projectRelativePath(root, file) ?? basename(file);
      const overrides = paramAssignments(params);
      const entry = viewer.pushModel({
        mesh: model.mesh,
        stats: model.stats,
        is2D: model.is2D,
        title: rel,
        key: model.key,
        source: { code: src.code, file: basename(file), params: overrides.length ? overrides : undefined },
        projectPath: rel,
        params: params && Object.keys(params).length ? params : undefined,
      });
      return { ok: true, version: entry.version };
    },
  };
}
