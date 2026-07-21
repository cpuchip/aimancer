<script lang="ts">
  // Two routes only (D1): JOIN (default) and BOARD (#/board/PIN).
  import Board from './Board.svelte'
  import Join from './Join.svelte'

  let route = $state(location.hash)
  window.addEventListener('hashchange', () => (route = location.hash))
  const boardPin = $derived(route.match(/^#\/board\/([A-Za-z]{4})/)?.[1]?.toUpperCase() ?? null)
</script>

{#if boardPin}
  <Board pin={boardPin} />
{:else}
  <Join />
{/if}
