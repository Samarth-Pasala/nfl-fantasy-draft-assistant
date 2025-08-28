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

/** -------- Small helpers -------- */
function pickNum(row: Record<string, any>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return undefined
}

function computePprFromRaw(s: Record<string, any>): number | undefined {
  const passY = pickNum(s, ['pass_yd','passing_yards']) ?? 0
  const passTD = pickNum(s, ['pass_td','passing_tds']) ?? 0
  const passInt = pickNum(s, ['pass_int','interceptions']) ?? 0
  const rushY = pickNum(s, ['rush_yd','rushing_yards']) ?? 0
  const rushTD = pickNum(s, ['rush_td','rushing_tds']) ?? 0
  const recY  = pickNum(s, ['rec_yd','receiving_yards']) ?? 0
  const recTD = pickNum(s, ['rec_td','receiving_tds']) ?? 0
  const rec   = pickNum(s, ['rec','receptions']) ?? 0
  const total = passY * 0.04 + passTD * 4 - passInt + rushY * 0.1 + rushTD * 6 + recY * 0.1 + recTD * 6 + rec
  return Number.isFinite(total) ? total : undefined
}

/** -------- Fetch with in-process cache -------- */
// Cache league weekly pages: key = `${season}:${week}` -> array
const weekCache = new Map<string, any[]>()
const CACHE_TTL_MS = 15 * 60 * 1000
const weekCacheTime = new Map<string, number>()

async function fetchWeek(season: number, week: number): Promise<any[]> {
  const key = `${season}:${week}`
  const now = Date.now()
  const ts = weekCacheTime.get(key)
  if (ts && now - ts < CACHE_TTL_MS && weekCache.has(key)) {
    return weekCache.get(key) as any[]
  }

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
        const arr: any[] = Array.isArray(data) ? data : Array.isArray((data as any)?.stats) ? (data as any).stats : []
        weekCache.set(key, arr)
        weekCacheTime.set(key, now)
        return arr
      }
    } catch {
      // try next url
    }
  }
  weekCache.set(key, [])
  weekCacheTime.set(key, now)
  return []
}

/** -------- Route handler (await params!) -------- */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> } // 👈 note Promise here
) {
  // ✅ await params per Next.js 15 dynamic API requirement
  const { id } = await ctx.params
  if (!id) return new Response('Missing id', { status: 400 })

  const { searchParams } = new URL(req.url)
  const seasons = (searchParams.get('seasons') || '2020,2021,2022,2023,2024')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => b - a) // newest first

  const idNum = Number(id)
  const hasNum = !Number.isNaN(idNum)

  const out: WeeklyStat[] = []
  let collected = 0
  const TARGET = 50 // stop once we have last 50 played games

  // Concurrency control per season to avoid fetching all 18 weeks at once
  const MAX_CONCURRENCY = 4

  for (const season of seasons) {
    if (collected >= TARGET) break
    let week = 18
    const queue: Promise<void>[] = []

    const worker = async () => {
      while (week >= 1 && collected < TARGET) {
        const wk = week--
        const arr = await fetchWeek(season, wk)
        if (!arr.length) continue

        const row =
          arr.find((x: any) => String(x.player_id) === String(id)) ??
          (hasNum ? arr.find((x: any) => Number(x.player_id) === idNum) : undefined)
        if (!row) continue

        // Sleeper sometimes nests stats under row.stats
        const stats = (row.stats ?? row) as Record<string, any>

        const pass_yd = pickNum(stats, ['pass_yd','passing_yards'])
        const pass_td = pickNum(stats, ['pass_td','passing_tds'])
        const pass_int = pickNum(stats, ['pass_int','interceptions'])

        const rush_yd = pickNum(stats, ['rush_yd','rushing_yards'])
        const rush_td = pickNum(stats, ['rush_td','rushing_tds'])
        const carries = pickNum(stats, ['carries','rush_att','rushing_att'])

        const rec = pickNum(stats, ['rec','receptions'])
        const rec_yd = pickNum(stats, ['rec_yd','receiving_yards'])
        const rec_td = pickNum(stats, ['rec_td','receiving_tds'])
        const targets = pickNum(stats, ['targets','tgt','rec_tgt'])

        const pts_ppr = pickNum(stats, ['pts_ppr','ppr_points']) ?? computePprFromRaw(stats)
        const pts_half_ppr = pickNum(stats, ['pts_half_ppr','half_ppr_points'])
        const pts_std = pickNum(stats, ['pts_std','standard_points'])

        out.push({
          week: wk,
          season,
          player_id: String(row.player_id),
          pts_ppr,
          pts_half_ppr,
          pts_std,
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
        collected++
      }
    }

    // Kick off a few workers
    for (let i = 0; i < MAX_CONCURRENCY; i++) queue.push(worker())
    await Promise.all(queue)

    if (collected >= TARGET) break
  }

  // Return newest first or chronological? Your UI uses chronological per season; keep as collected order newest→older:
  out.sort((a, b) => (a.season === b.season ? a.week - b.week : a.season - b.season))

  return new Response(JSON.stringify({ weeks: out }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}