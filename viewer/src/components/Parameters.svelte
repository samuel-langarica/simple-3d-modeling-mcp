<script lang="ts">
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { ParamValue, ProjectParam } from "../lib/protocol.js";
  import Section from "./Section.svelte";

  interface Props {
    /** Project file shown in the viewport (relative path). */
    path: string;
    /** Overrides the shown version was rendered with. */
    applied: Record<string, ParamValue> | undefined;
    onapply: (params: Record<string, ParamValue>) => void;
  }

  let { path, applied, onapply }: Props = $props();

  let params = $state.raw<ProjectParam[]>([]);
  let values = $state<Record<string, ParamValue>>({});
  let error = $state<string | null>(null);

  // Reload the parameter list when the file changes.
  $effect(() => {
    const p = path;
    let cancelled = false;
    fetch(`/api/params?path=${encodeURIComponent(p)}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        params = body.params;
        error = null;
      })
      .catch((e) => {
        if (!cancelled) error = String(e.message ?? e);
      });
    return () => {
      cancelled = true;
    };
  });

  // The controls show what the viewport shows: defaults, plus the overrides of that version.
  $effect(() => {
    const next: Record<string, ParamValue> = {};
    for (const p of params) next[p.name] = applied?.[p.name] ?? p.value;
    values = next;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  function overrides(): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {};
    for (const p of params) if (values[p.name] !== p.value) out[p.name] = values[p.name];
    return out;
  }
  function changed(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(() => onapply(overrides()), delay);
  }
  function reset() {
    for (const p of params) values[p.name] = p.value;
    changed(0);
  }
  const modified = $derived(params.some((p) => values[p.name] !== p.value));
</script>

{#if params.length || error}
  <Section title="Parameters">
    {#snippet aside()}
      {#if modified}
        <button class="icon" title="Reset to defaults" aria-label="Reset to defaults" onclick={reset}><RotateCcw size={13} /></button>
      {/if}
    {/snippet}
    {#if error}<p class="err">{error}</p>{/if}
    <div class="list">
      {#each params as p (p.name)}
        <label class={["param", p.type, { changed: values[p.name] !== p.value }]} title={`${p.name} — ${p.file}`}>
          {#if p.type === "boolean"}
            <input type="checkbox" checked={values[p.name] as boolean} onchange={(e) => { values[p.name] = e.currentTarget.checked; changed(0); }} />
            <span class="name">{p.name}</span>
          {:else if p.options}
            <span class="name">{p.name}</span>
            <select value={String(values[p.name])} onchange={(e) => { const v = e.currentTarget.value; values[p.name] = p.type === "number" ? Number(v) : v; changed(0); }}>
              {#each p.options as o}<option value={String(o)}>{o}</option>{/each}
            </select>
          {:else if p.type === "number" && p.min !== undefined && p.max !== undefined}
            <span class="name">{p.name}</span>
            <span class="val">{values[p.name]}</span>
            <input type="range" min={p.min} max={p.max} step={p.step ?? "any"} value={values[p.name] as number}
              oninput={(e) => { values[p.name] = Number(e.currentTarget.value); changed(); }} />
          {:else if p.type === "number"}
            <span class="name">{p.name}</span>
            <input type="number" step={p.step ?? "any"} value={values[p.name] as number}
              onchange={(e) => { values[p.name] = Number(e.currentTarget.value); changed(0); }} />
          {:else}
            <span class="name">{p.name}</span>
            <input type="text" value={values[p.name] as string} onchange={(e) => { values[p.name] = e.currentTarget.value; changed(0); }} />
          {/if}
          {#if p.description}<span class="desc">{p.description}</span>{/if}
        </label>
      {/each}
    </div>
  </Section>
{/if}

<style>
  .list { display: flex; flex-direction: column; gap: 10px; }
  .param { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px; }
  .param.boolean { grid-template-columns: auto 1fr; }
  .name { font: 500 12px var(--font-mono); overflow: hidden; text-overflow: ellipsis; }
  .changed .name { color: var(--bauhaus-red); font-weight: 650; }
  .val { font: 500 11px var(--font-mono); color: var(--ink-soft); }
  input[type="range"], select, input[type="number"], input[type="text"] { grid-column: 1 / -1; width: 100%; accent-color: var(--ink); }
  .desc { grid-column: 1 / -1; color: var(--ink-faint); font-size: 11px; }
  .icon { display: inline-flex; padding: 3px; border: 0; background: none; color: inherit; cursor: pointer; }
  .err { color: var(--bauhaus-red); font-size: 12px; }
</style>
