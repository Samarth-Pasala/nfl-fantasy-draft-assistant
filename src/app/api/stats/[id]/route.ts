/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'nodejs'

type WeeklyStat = {
  week: number
  season: number
  player_id: string
  pts_ppr?: number
  pts_half_ppr?: number
  pts_std?: number
  pass_yd?: number
  pass_td?: number
  pass_int?: number
  rush_yd?: number
  rush_td?: number
  rec?: number
  rec_yd?: number
  rec_td?: number
  targets?: number
  carries?: number
}

function pickNum(row: Record<string, any>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'number') return v
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  }
  return undefined
}

function computePprFromRaw(s: Record<string, any>): number | undefined {
  const passY = pickNum(s, ['pass_yd', 'passing_yards', 'passYds', 'pass_yds']) ?? 0
  const passTD = pickNum(s, ['pass_td', 'passing_tds', 'passing_td']) ?? 0
  const passInt = pickNum(s, ['pass_int', 'interceptions', 'ints']) ?? 0
  const rushY = pickNum(s, ['rush_yd', 'rushing_yards', 'rushYds', 'rush_yds']) ?? 0
  const rushTD = pickNum(s, ['rush_td', 'rushing_tds', 'rushing_td']) ?? 0
  const recY  = pickNum(s, ['rec_yd', 'receiving_yards', 'recYds', 'rec_yds']) ?? 0
  const recTD = pickNum(s, ['rec_td', 'receiving_tds', 'receiving_td']) ?? 0
  const rec   = pickNum(s, ['rec', 'receptions', 'catches', 'catch']) ?? 0
  const total = passY * 0.04 + passTD * 4 - passInt + rushY * 0.1 + rushTD * 6 + recY * 0.1 + recTD * 6 + rec * 1
  return Number.isFinite(total) ? total : undefined
}

async function fetchWeek(season: string, week: number): Promise<any[]> {
  const urls = [
    `https://api.sleeper.app/stats/nfl/${season}/${week}?season_type=regular`,
    `https://api.sleeper.app/v1/stats/nfl/${season}/${week}?season_type=regular`,
    `https://api.sleeper.app/v1/stats/nfl/regular/${season}/${week}`,
  ]
  for (const url of urls) {
    try {
      const r = await fetch(url, { cache: 'no-store' })
      if (r.ok) {
        const data = await r.json()
        return Array.isArray(data) ? data : Array.isArray((data as any)?.stats) ? (data as any).stats : []
      }
    } catch {}
  }
  return []
}

export async function GET(req: Request, context: any) {
    const { params } = context
    const { searchParams } = new URL(req.url)
    const seasons = (searchParams.get('seasons') || '2020,2021,2022,2023,2024')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  
    const id = params?.id
    if (!id) return new Response('Missing id', { status: 400 })

  const out: WeeklyStat[] = []
  const idNum = Number(id)
  const hasNum = !Number.isNaN(idNum)

  for (const s of seasons) {
    for (let wk = 1; wk <= 18; wk++) {
      const arr = await fetchWeek(s, wk)
      if (!arr.length) continue

      const row = arr.find((x: any) =>
        String(x.player_id) === String(id) || (hasNum && Number(x.player_id) === idNum)
      )
      if (!row) continue

      const stats = (row.stats ?? {}) as Record<string, any> // nested stats in new Sleeper feed

      const pass_yd = pickNum(stats, ['pass_yd', 'passing_yards', 'passYds', 'pass_yds'])
      const pass_td = pickNum(stats, ['pass_td', 'passing_tds', 'passing_td'])
      const pass_int = pickNum(stats, ['pass_int', 'interceptions', 'ints'])

      const rush_yd = pickNum(stats, ['rush_yd', 'rushing_yards', 'rushYds', 'rush_yds'])
      const rush_td = pickNum(stats, ['rush_td', 'rushing_tds', 'rushing_td'])
      const carries = pickNum(stats, ['carries', 'rush_att', 'rushing_att', 'att_rush'])

      const rec = pickNum(stats, ['rec', 'receptions', 'catches', 'catch'])
      const rec_yd = pickNum(stats, ['rec_yd', 'receiving_yards', 'recYds', 'rec_yds'])
      const rec_td = pickNum(stats, ['rec_td', 'receiving_tds', 'receiving_td'])
      const targets = pickNum(stats, ['targets', 'tgt', 'rec_tgt', 'tar'])

      const pts_ppr =
        pickNum(stats, ['pts_ppr', 'ppr_points', 'fantasy_points_ppr', 'ppr']) ??
        computePprFromRaw(stats)

      out.push({
        week: wk,
        season: Number(s),
        player_id: String(row.player_id),
        pts_ppr,
        pts_half_ppr: pickNum(stats, ['pts_half_ppr', 'half_ppr_points', 'half_ppr']),
        pts_std: pickNum(stats, ['pts_std', 'standard_points', 'std']),
        pass_yd,
        pass_td,
        pass_int,
        rush_yd,
        rush_td,
        carries,
        rec,
        rec_yd,
        rec_td,
        targets,
      })
    }
  }

  return new Response(JSON.stringify({ weeks: out }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}