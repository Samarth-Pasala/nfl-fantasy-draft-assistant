/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'nodejs'

type PlayerLite = {
  player_id: string
  full_name: string
  position: string
  team?: string
  birth_date?: string
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').toLowerCase()

  if (!q) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  const res = await fetch('https://api.sleeper.app/v1/players/nfl', { cache: 'no-store' })
  const json = (await res.json()) as Record<string, any>

  // KEY is the canonical player_id used elsewhere
  const all = Object.entries(json)
    .map(([key, p]) => ({
      player_id: String(key),
      full_name:
        p.full_name ||
        (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : (p.name ?? '')),
      position: p.position,
      team: p.team,
      birth_date: p.birth_date || p.birthdate || p.birthDate,
    }))
    .filter(p => p.full_name && ['QB','RB','WR','TE'].includes(p.position))

  const results = all.filter(p => p.full_name.toLowerCase().includes(q)).slice(0, 12)

  return new Response(JSON.stringify({ results }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}