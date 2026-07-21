<script lang="ts">
  // Three routes: JOIN (default), BOARD (#/board/PIN), and the WIKI (/wiki —
  // a real pathname so it's linkable/curl-able; #/wiki works too).
  import Board from './Board.svelte'
  import Join from './Join.svelte'
  import Wiki from './Wiki.svelte'

  let route = $state(location.hash)
  window.addEventListener('hashchange', () => (route = location.hash))
  const boardPin = $derived(route.match(/^#\/board\/([A-Za-z]{4})/)?.[1]?.toUpperCase() ?? null)
  const wiki = $derived(location.pathname.replace(/\/+$/, '') === '/wiki' || route.startsWith('#/wiki'))
</script>

{#if wiki}
  <Wiki />
{:else if boardPin}
  <Board pin={boardPin} />
{:else}
  <Join />
{/if}
