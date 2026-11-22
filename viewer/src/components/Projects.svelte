<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FileBox from "@lucide/svelte/icons/file-box";
  import Folder from "@lucide/svelte/icons/folder";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { ProjectNode, ProjectsResponse } from "../lib/protocol.js";
  import Section from "./Section.svelte";

  interface Props {
    data: ProjectsResponse;
    /** File shown in the viewport (relative path). */
    active: string | undefined;
    /** File being rendered right now. */
    busy: string | null;
    onselect: (path: string) => void;
    onrefresh: () => void;
  }

  let { data, active, busy, onselect, onrefresh }: Props = $props();

  const OPEN_KEY = "viewer-open-folders";
  function loadOpen(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  }
  let open = $state(loadOpen());
  function toggle(path: string) {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    open = next;
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      // not remembered
    }
  }
  // Keep the folders of the active file open.
  $effect(() => {
    if (!active) return;
    const parts = active.split("/");
    const missing = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")).filter((p) => !open.has(p));
    if (missing.length) open = new Set([...open, ...missing]);
  });
</script>

{#snippet tree(nodes: ProjectNode[], depth: number)}
  <ul>
    {#each nodes as n (n.path)}
      <li>
        {#if n.type === "dir"}
          <button class="row dir" style:padding-left="{6 + depth * 14}px" onclick={() => toggle(n.path)} aria-expanded={open.has(n.path)}>
            <span class={["chev", { open: open.has(n.path) }]}><ChevronRight size={13} /></span>
            <Folder size={14} />
            <span class="name">{n.name}</span>
          </button>
          {#if open.has(n.path) && n.children}{@render tree(n.children, depth + 1)}{/if}
        {:else}
          <button
            class={["row file", { active: n.path === active, busy: n.path === busy }]}
            style:padding-left="{6 + depth * 14 + 17}px"
            title={n.path}
            onclick={() => onselect(n.path)}
          >
            <FileBox size={14} />
            <span class="name">{n.name.replace(/\.scad$/, "")}</span>
            {#if n.path === busy}<span class="spin" aria-label="rendering"></span>{/if}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<Section title="Projects" grow>
  {#snippet aside()}
    <span class="root" title={data.root}>{data.name}</span>
    <button class="icon" title="Refresh" aria-label="Refresh" onclick={onrefresh}><RefreshCw size={13} /></button>
  {/snippet}
  {#if data.tree.length}
    {@render tree(data.tree, 0)}
  {:else}
    <p class="none">No .scad files in this folder</p>
  {/if}
</Section>

<style>
  ul { list-style: none; }
  .row {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 4px 8px; border: 0; background: none; text-align: left; cursor: pointer; color: inherit;
  }
  .row:hover .name { text-decoration: underline; text-underline-offset: 3px; }
  .dir { font-weight: 600; }
  .chev { display: inline-flex; transition: transform 0.12s; }
  .chev.open { transform: rotate(90deg); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file.active { background: var(--ink); color: var(--paper); font-weight: 650; }
  .file.busy { opacity: 0.7; }
  .spin {
    margin-left: auto; width: 10px; height: 10px; flex: none;
    border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .root { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none; }
  .icon { display: inline-flex; padding: 3px; border: 0; background: none; color: inherit; cursor: pointer; }
  .none { color: var(--ink-faint); }
</style>
