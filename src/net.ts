// Tiny ws client helpers. Reconnect identity = a localStorage key (chips'
// pattern): the same key reclaims the same seat with the same tokens.

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

export function clientKey(): string {
  let k = localStorage.getItem('aimancer-key')
  if (!k) {
    k = 'k-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
    localStorage.setItem('aimancer-key', k)
  }
  return k
}
