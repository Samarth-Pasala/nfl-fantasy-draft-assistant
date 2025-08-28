/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'nodejs'

// ============================== Types ===============================

type ScoringPreset = 'PPR' | 'HALF_PPR' | 'STANDARD'
type PosKey = 'QB' | 'RB' | 'WR' | 'TE'

type PlayerLite = {
  player_id: string
  full_name: string
  position: PosKey | string
  team?: string
  birth_date?: string
}

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

type ProjectionRow = {
  player_id: string
  full_name: string
  position: PosKey | string
  team?: string
  ppg: number
}

// ============================== Helpers =============================

const POSITIONS: PosKey[] = ['QB', 'RB', 'WR', 'TE']
const STALE_MS = 12 * 60 * 60 * 1000 // 12h
const DEFAULT_SEASONS = [2022, 2023, 2024] // ~50 played games for most
const FETCH_TIMEOUT_MS = 12000
const MAX_CONCURRENCY = 6

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}
function yearsSince(dateISO?: string) {
  if (!dateISO) return undefined
  const d = new Date(dateISO)
  if (Number.isNaN(d.getTime())) return undefined
  const now = new Date()
  return (now.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000)
}
function ageMultiplier(pos: string, age?: number) {
  if (!age) return 1
  let mult = 1
  if (pos === 'RB') {
    const d = age - 26
    if (d > 0) mult *= 1 - clamp(0.06 * d, 0, 0.25)
    else mult *= 1 + clamp(0.02 * -d, 0, 0.08)
  } else if (pos === 'WR') {
    const d = age - 27
    if (d > 0) mult *= 1 - clamp(0.03 * d, 0, 0.18)
    else mult *= 1 + clamp(0.015 * -d, 0, 0.06)
  } else if (pos === 'TE') {
    const d = age - 28
    if (d > 0) mult *= 1 - clamp(0.02 * d, 0, 0.12)
    else mult *= 1 + clamp(0.01 * -d, 0, 0.05)
  } else if (pos === 'QB') {
    const d = age - 32
    if (d > 0) mult *= 1 - clamp(0.015 * d, 0, 0.12)
    else mult *= 1 + clamp(0.01 * -d, 0, 0.05)
  }
  return mult
}
function weeklyPoints(stat: WeeklyStat, preset: ScoringPreset, passTd: 4 | 6) {
  if (preset === 'PPR' && stat.pts_ppr != null) return stat.pts_ppr
  if (preset === 'HALF_PPR' && stat.pts_half_ppr != null) return stat.pts_half_ppr
  if (preset === 'STANDARD' && stat.pts_std != null) return stat.pts_std
  const pass =
    (stat.pass_yd ?? 0) * 0.04 +
    (stat.pass_td ?? 0) * passTd +
    (stat.pass_int ?? 0) * -1
  const rush =
    (stat.rush_yd ?? 0) * 0.1 + (stat.rush_td ?? 0) * 6
  const catchBonus = preset === 'PPR' ? 1 : preset === 'HALF_PPR' ? 0.5 : 0
  const rec =
    (stat.rec_yd ?? 0) * 0.1 + (stat.rec_td ?? 0) * 6 + (stat.rec ?? 0) * catchBonus
  return pass + rush + rec
}
/** "Played" if there were meaningful stats (avoids DNP zeros). */
function didPlay(w: WeeklyStat) {
  return (
    (w.pts_ppr != null && w.pts_ppr !== 0) ||
    (w.pass_td ?? 0) > 0 ||
    (w.pass_yd ?? 0) > 0 ||
    (w.rush_td ?? 0) > 0 ||
    (w.rush_yd ?? 0) > 0 ||
    (w.rec ?? 0) > 0 ||
    (w.rec_td ?? 0) > 0 ||
    (w.rec_yd ?? 0) > 0 ||
    (w.targets ?? 0) > 0 ||
    (w.carries ?? 0) > 0
  )
}
function lastNPlayedPoints(weeks: WeeklyStat[], n: number, preset: ScoringPreset, passTd: 4 | 6) {
  const ordered = [...weeks].sort((a, b) =>
    a.season !== b.season ? a.season - b.season : a.week - b.week
  )
  const pts = ordered.filter(didPlay).map(w => weeklyPoints(w, preset, passTd))
  return pts.slice(Math.max(0, pts.length - n))
}
function average(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}
function projectPPG(weeks: WeeklyStat[], preset: ScoringPreset, passTd: 4 | 6, pos?: string, birth?: string) {
  const last = lastNPlayedPoints(weeks, 50, preset, passTd)
  const base = average(last)
  const ageYears = yearsSince(birth)
  const age = typeof ageYears === 'number' ? Math.floor(ageYears) : undefined
  return base * ageMultiplier(pos || '', age)
}

// ============================ Sleeper fetchers =============================

function withTimeout(url: string, ms = FETCH_TIMEOUT_MS, init?: RequestInit) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...init, signal: ctrl.signal })
    .finally(() => clearTimeout(t))
}

async function fetchPlayers(): Promise<PlayerLite[]> {
  const r = await withTimeout('https://api.sleeper.app/v1/players/nfl', FETCH_TIMEOUT_MS, { cache: 'no-store' })
  const json = await r.json()
  const arr: PlayerLite[] = Object.values(json).map((p: any) => ({
    player_id: String(p.player_id ?? p.id ?? ''),
    full_name: p.full_name || (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name ?? ''),
    position: String(p.position || '').toUpperCase(),
    team: p.team,
    birth_date: p.birth_date || p.birthdate || p.birthDate,
  }))
  return arr.filter(p => p.player_id && p.full_name && POSITIONS.includes(p.position as PosKey))
}

async function fetchWeek(season: number, week: number): Promise<any[]> {
  const urls = [
    `https://api.sleeper.app/stats/nfl/${season}/${week}?season_type=regular`,
    `https://api.sleeper.app/v1/stats/nfl/${season}/${week}?season_type=regular`,
    `https://api.sleeper.app/v1/stats/nfl/regular/${season}/${week}`,
  ]
  for (const url of urls) {
    try {
      const res = await withTimeout(url, FETCH_TIMEOUT_MS, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        return Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.stats)
          ? (data as any).stats
          : []
      }
    } catch {
      // try next shape
    }
  }
  return []
}

// bounded concurrency for week pulls
async function fetchWeeksBatched(seasons: number[]) {
  const jobs: Array<() => Promise<any[]>> = []
  for (const s of seasons) for (let w = 1; w <= 18; w++) jobs.push(() => fetchWeek(s, w))

  const results: any[][] = []
  let i = 0
  async function worker() {
    while (i < jobs.length) {
      const j = i++
      results[j] = await jobs[j]()
    }
  }
  const workers = Array.from({ length: MAX_CONCURRENCY }, worker)
  await Promise.all(workers)
  return results
}

// ================================ Cache ====================================

const posCache = new Map<string, { at: number; rows: ProjectionRow[] }>() // key: `${preset}-${passTd}-${pos}`
const idsCache = new Map<string, { at: number; row?: ProjectionRow }>()     // key: `${preset}-${passTd}-${id}`

// ============================== Core build =================================

async function buildProjectionsFor(
  players: PlayerLite[],
  { preset, passTd, seasons = DEFAULT_SEASONS }: { preset: ScoringPreset; passTd: 4 | 6; seasons?: number[] }
): Promise<ProjectionRow[]> {
  const weeksAll = await fetchWeeksBatched(seasons)

  // bucket stats by player_id
  const bucket = new Map<string, WeeklyStat[]>()
  for (const arr of weeksAll) {
    for (const row of arr) {
      const id = String((row as any).player_id)
      const s = (row as any).season
      const w = (row as any).week
      if (!id || !Number.isFinite(+s) || !Number.isFinite(+w)) continue
      const st = (row as any).stats ?? row
      const ws: WeeklyStat = {
        week: Number(w),
        season: Number(s),
        player_id: id,
        pts_ppr: st.pts_ppr ?? st.ppr_points,
        pts_half_ppr: st.pts_half_ppr,
        pts_std: st.pts_std,
        pass_yd: st.pass_yd ?? st.passing_yards,
        pass_td: st.pass_td ?? st.passing_tds,
        pass_int: st.pass_int ?? st.interceptions,
        rush_yd: st.rush_yd ?? st.rushing_yards,
        rush_td: st.rush_td ?? st.rushing_tds,
        rec: st.rec ?? st.receptions,
        rec_yd: st.rec_yd ?? st.receiving_yards,
        rec_td: st.rec_td ?? st.receiving_tds,
        targets: st.targets ?? st.rec_tgt ?? st.tgt,
        carries: st.carries ?? st.rush_att ?? st.rushing_att,
      }
      const list = bucket.get(id)
      if (list) list.push(ws)
      else bucket.set(id, [ws])
    }
  }

  // compute ppg rows
  const out: ProjectionRow[] = []
  for (const p of players) {
    const weeks = bucket.get(p.player_id) ?? []
    const ppg = projectPPG(weeks, preset, passTd, p.position, p.birth_date)
    out.push({
      player_id: p.player_id,
      full_name: p.full_name,
      position: String(p.position || '').toUpperCase(),
      team: p.team,
      ppg: Number.isFinite(ppg) ? ppg : 0,
    })
  }
  return out
}

// ================================ Route ====================================

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const preset = (url.searchParams.get('preset') || 'PPR').toUpperCase() as ScoringPreset
    const passTd = (Number(url.searchParams.get('passTd') || 4) === 6 ? 6 : 4) as 4 | 6
    const limit = clamp(Number(url.searchParams.get('limit') || 50), 1, 200)
    const exclude = new Set(
      (url.searchParams.get('exclude') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    )

    // optional explicit seasons: ?seasons=2022,2023,2024
    const seasonsParam = (url.searchParams.get('seasons') || '')
      .split(',')
      .map(s => Number(s))
      .filter(n => Number.isFinite(n))
    const seasons = seasonsParam.length ? seasonsParam : DEFAULT_SEASONS

    const idsParam = url.searchParams.get('ids')
    const posParam = String(url.searchParams.get('pos') || '').toUpperCase()
    const wantPos: PosKey | null = POSITIONS.includes(posParam as PosKey)
      ? (posParam as PosKey)
      : null

    // ---------- Fast path: ids ----------
    if (idsParam) {
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean)
      const allPlayers = await fetchPlayers()
      const subset = allPlayers.filter(p => ids.includes(p.player_id))

      const out: ProjectionRow[] = []
      const keyPrefix = `${preset}-${passTd}-`
      for (const p of subset) {
        const k = keyPrefix + p.player_id
        const c = idsCache.get(k)
        if (c && Date.now() - c.at < STALE_MS && c.row) {
          out.push(c.row)
          continue
        }
        const row = (await buildProjectionsFor([p], { preset, passTd, seasons }))[0]
        idsCache.set(k, { at: Date.now(), row })
        out.push(row)
      }

      return new Response(JSON.stringify({ preset, passTd, players: out }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': 's-maxage=21600, stale-while-revalidate=86400',
        },
      })
    }

    // ---------- Position path ----------
    if (!wantPos) {
      return new Response(JSON.stringify({ error: 'Provide ?pos=QB|RB|WR|TE or ids=...' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }

    const cacheKey = `${preset}-${passTd}-${wantPos}`
    const cached = posCache.get(cacheKey)
    if (cached && Date.now() - cached.at < STALE_MS) {
      const pruned = cached.rows
        .filter(r => !exclude.has(r.player_id))
        .filter(r => String(r.position).toUpperCase() === wantPos) // safety
        .sort((a, b) => b.ppg - a.ppg)
        .slice(0, limit)
      return new Response(JSON.stringify({ preset, passTd, players: pruned }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': 's-maxage=21600, stale-while-revalidate=86400',
        },
      })
    }

    const allPlayers = await fetchPlayers()
    // STRICT server-side filter by requested position
    const subset = allPlayers.filter(p => String(p.position).toUpperCase() === wantPos)

    const rows = await buildProjectionsFor(subset, { preset, passTd, seasons })
    // normalize positions to uppercase and pin to requested bucket
    const normalized = rows.map(r => ({
      ...r,
      position: wantPos,
    }))

    posCache.set(cacheKey, { at: Date.now(), rows: normalized })

    const pruned = normalized
      .filter(r => !exclude.has(r.player_id))
      .sort((a, b) => b.ppg - a.ppg)
      .slice(0, limit)

    return new Response(JSON.stringify({ preset, passTd, players: pruned }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 's-maxage=21600, stale-while-revalidate=86400',
      },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'projections failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
}