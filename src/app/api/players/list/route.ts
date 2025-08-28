// src/app/api/players/list/route.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'edge'

type PlayerLite = {
  player_id: string
  full_name: string
  position: string
  team?: string
  birth_date?: string
}

let _cache: PlayerLite[] | null = null

async function fetchPlayers(): Promise<PlayerLite[]> {
  if (_cache) return _cache
  const res = await fetch('https://api.sleeper.app/v1/players/nfl', { next: { revalidate: 60 * 60 * 6 } })
  const json = await res.json()
  const arr: PlayerLite[] = Object.values(json).map((p: any) => ({
    player_id: String(p.player_id ?? p.playerId ?? p.id ?? ''),
    full_name: p.full_name || (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name ?? ''),
    position: p.position,
    team: p.team,
    birth_date: p.birth_date || p.birthdate || p.birthDate,
  })).filter(p => p.player_id && p.full_name && ['QB','RB','WR','TE'].includes(p.position))
  _cache = arr
  return arr
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const pos = searchParams.get('pos')?.toUpperCase()
  const all = await fetchPlayers()
  const filtered = pos && ['QB','RB','WR','TE'].includes(pos) ? all.filter(p => p.position === pos) : all
  return new Response(JSON.stringify({ players: filtered }), {
    headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=3600, stale-while-revalidate=86400' },
  })
}