<script lang="ts">
  // The WIKI — /wiki renders shared/rules.ts (the one source of truth) for
  // humans; GET /api/rules serves the same truth to agents as markdown. The
  // renderer below covers exactly the markdown grammar rules.ts emits
  // (paragraphs, tables, lists, fenced code, inline bold/code) — content is a
  // compile-time constant from our own module, so {@html} is safe here.
  import { rulesSections } from '../shared/rules.ts'

  const sections = rulesSections()

  function esc(s: string): string {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }

  /** Inline markdown: `code` first (protects its contents), then **bold**. */
  function inline(s: string): string {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  }

  function mdToHtml(md: string): string {
    const out: string[] = []
    const lines = md.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.startsWith('```')) {
        const buf: string[] = []
        i++
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
        i++ // closing fence
        out.push(`<pre class="mdcode">${esc(buf.join('\n'))}</pre>`)
        continue
      }
      if (line.startsWith('|')) {
        const rows: string[][] = []
        while (i < lines.length && lines[i].startsWith('|')) {
          const raw = lines[i++]
          if (/^\|[\s:-]+\|/.test(raw) && raw.includes('---')) continue // separator row
          rows.push(raw.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
        }
        const [head, ...body] = rows
        out.push(
          '<div class="tblwrap"><table>' +
            `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
            '</table></div>',
        )
        continue
      }
      if (line.startsWith('- ') || /^\d+\. /.test(line)) {
        const ordered = /^\d+\. /.test(line)
        const items: string[] = []
        while (i < lines.length && (lines[i].startsWith('- ') || /^\d+\. /.test(lines[i]))) {
          items.push(lines[i++].replace(/^(- |\d+\. )/, ''))
        }
        const tag = ordered ? 'ol' : 'ul'
        out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`)
        continue
      }
      if (line.trim() === '') {
        i++
        continue
      }
      const buf: string[] = []
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('|') && !lines[i].startsWith('- ') && !lines[i].startsWith('```') && !/^\d+\. /.test(lines[i])) {
        buf.push(lines[i++])
      }
      out.push(`<p>${inline(buf.join(' '))}</p>`)
    }
    return out.join('\n')
  }
</script>

<div class="wiki">
  <div class="wiki-head">
    <img class="wiki-emblem" src="/assets/emblem.png" alt="" />
    <span class="wordmark">AIMANCER</span>
    <span class="muted">— the complete rules</span>
    <a class="wiki-back" href="/">← back to the game</a>
  </div>
  <p class="muted">
    For humans and their agents alike — every number below comes straight from the
    live game constants. Agents fetch the same truth as markdown:
    <span class="mono">curl -s {location.origin}/api/rules</span>
  </p>
  <nav class="wiki-toc">
    {#each sections as s (s.id)}
      <a href={'#' + s.id}>{s.title}</a>
    {/each}
  </nav>
  {#each sections as s (s.id)}
    <section class="wiki-section" id={s.id}>
      <h2 class="wiki-h">{s.title} <a class="anchor" href={'#' + s.id} aria-label={'link to ' + s.title}>#</a></h2>
      <!-- eslint-disable-next-line svelte/no-at-html-tags — our own constant text -->
      {@html mdToHtml(s.body)}
    </section>
  {/each}
  <p class="faint" style="text-align:center; margin-top:var(--s-6)">
    your agent writes real scripts · the oracle gates the shared works · the launch is a human vote
  </p>
</div>
