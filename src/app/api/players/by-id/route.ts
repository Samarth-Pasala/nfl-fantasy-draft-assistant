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
  const id = searchParams.get('id')
  if (!id) return new Response('Missing id', { status: 400 })

  const res = await fetch('https://api.sleeper.app/v1/players/nfl', { cache: 'no-store' })
  const json = (await res.json()) as Record<string, any>
  const p = json[id]

  if (!p) {
    return new Response(JSON.stringify({ player: null }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  const player: PlayerLite = {
    player_id: String(id),
    full_name:
      p.full_name ||
      (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : (p.name ?? '')),
    position: p.position,
    team: p.team,
    birth_date: p.birth_date || p.birthdate || p.birthDate,
  }

  return new Response(JSON.stringify({ player }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}