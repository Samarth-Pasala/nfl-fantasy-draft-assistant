/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'nodejs'

type ScoringPreset = 'PPR' | 'HALF_PPR' | 'STANDARD'

type PlayerLite = {
  player_id: string
  full_name: string
  position: 'QB'|'RB'|'WR'|'TE'|string
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
  position: string
  team?: string
  ppg: number
}

/* ---------------- helpers ---------------- */
function weeklyPoints(stat: WeeklyStat, preset: ScoringPreset, passTd: 4 | 6) {
  if (preset === 'PPR' && stat.pts_ppr != null) return stat.pts_ppr
  if (preset === 'HALF_PPR' && stat.pts_half_ppr != null) return stat.pts_half_ppr
  if (preset === 'STANDARD' && stat.pts_std != null) return stat.pts_std
  const pass = (stat.pass_yd ?? 0) * 0.04 + (stat.pass_td ?? 0) * passTd + (stat.pass_int ?? 0) * -1
  const rush = (stat.rush_yd ?? 0) * 0.1 + (stat.rush_td ?? 0) * 6
  const catchBonus = preset === 'PPR' ? 1 : preset === 'HALF_PPR' ? 0.5 : 0
  const rec = (stat.rec_yd ?? 0) * 0.1 + (stat.rec_td ?? 0) * 6 + (stat.rec ?? 0) * catchBonus
  return pass + rush + rec
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
    if (d > 0) mult *= 1 - Math.min(0.25, 0.06 * d)
    if (d < 0) mult *= 1 + Math.min(0.08, 0.02 * -d)
  } else if (pos === 'WR') {
    const d = age - 27
    if (d > 0) mult *= 1 - Math.min(0.18, 0.03 * d)
    if (d < 0) mult *= 1 + Math.min(0.06, 0.015 * -d)
  } else if (pos === 'TE') {
    const d = age - 28
    if (d > 0) mult *= 1 - Math.min(0.12, 0.02 * d)
    if (d < 0) mult *= 1 + Math.min(0.05, 0.01 * -d)
  } else if (pos === 'QB') {
    const d = age - 32
    if (d > 0) mult *= 1 - Math.min(0.12, 0.015 * d)
    if (d < 0) mult *= 1 + Math.min(0.05, 0.01 * -d)
  }
  return mult
}
function lastNPlayedPoints(
  weeks: WeeklyStat[],
  n: number,
  preset: ScoringPreset,
  passTd: 4 | 6
) {
  const sorted = [...weeks].sort((a, b) => (b.season - a.season) || (b.week - a.week))
  const pts: number[] = []
  for (const w of sorted) {
    const p = weeklyPoints(w, preset, passTd)
    if (Number.isFinite(p) && p !== 0) {
      pts.push(p)
      if (pts.length >= n) break
    }
  }
  return pts
}
function average(arr: number[]) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

/* ---------------- small fetchers ---------------- */
async function fetchPlayers(): Promise<PlayerLite[]> {
  const r = await fetch('https://api.sleeper.app/v1/players/nfl', { cache: 'no-store' })
  const json = await r.json()
  return Object.values(json).map((p: any) => ({
    player_id: String(p.player_id ?? p.id ?? ''),
    full_name: p.full_name || (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name ?? ''),
    position: p.position,
    team: p.team,
    birth_date: p.birth_date || p.birthdate || p.birthDate,
  })).filter(p => p.player_id && p.full_name && ['QB','RB','WR','TE'].includes(p.position))
}

async function fetchWeek(season: number, week: number): Promise<any[]> {
  const urls = [
    `https://api.sleeper.app/stats/nfl/${season}/${week}?season_type=regular`,
    `https://api.sleeper.app/v1/stats/nfl/${season}/${week}?season_type=regular`,
    `https://api.sleeper.app/v1/stats/nfl/regular/${season}/${week}`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        return Array.isArray(data) ? data : Array.isArray((data as any)?.stats) ? (data as any).stats : []
      }
    } catch {}
  }
  return []
}

/* ---------------- cache ---------------- */
type PosKey = 'QB'|'RB'|'WR'|'TE'
const POSITIONS: PosKey[] = ['QB','RB','WR','TE']
const posCache = new Map<string, { at: number; rows: ProjectionRow[] }>() // `${preset}-${passTd}-${pos}`
const IDS_CACHE = new Map<string, { at: number; row?: ProjectionRow }>()   // `${preset}-${passTd}-${id}`
const STALE_MS = 12 * 60 * 60 * 1000 // 12 hours
const SEASONS_DEFAULT = [2022, 2023, 2024]

async function buildProjectionsFor(
  players: PlayerLite[],
  opts: { preset: ScoringPreset; passTd: 4|6; seasons?: number[] }
): Promise<ProjectionRow[]> {
  const seasons = opts.seasons ?? SEASONS_DEFAULT

  const weeks: any[][] = []
  for (const season of seasons) {
    for (let wk = 1; wk <= 18; wk++) {
      weeks.push(await fetchWeek(season, wk))
    }
  }

  const bucket = new Map<string, WeeklyStat[]>()
  for (const arr of weeks) {
    for (const row of arr) {
      const id = String(row.player_id)
      const stats = (row.stats ?? row) as any
      const w: WeeklyStat = {
        week: Number(row.week),
        season: Number(row.season),
        player_id: id,
        pts_ppr: stats.pts_ppr ?? stats.ppr_points,
        pts_half_ppr: stats.pts_half_ppr,
        pts_std: stats.pts_std,
        pass_yd: stats.pass_yd ?? stats.passing_yards,
        pass_td: stats.pass_td ?? stats.passing_tds,
        pass_int: stats.pass_int ?? stats.interceptions,
        rush_yd: stats.rush_yd ?? stats.rushing_yards,
        rush_td: stats.rush_td ?? stats.rushing_tds,
        rec: stats.rec ?? stats.receptions,
        rec_yd: stats.rec_yd ?? stats.receiving_yards,
        rec_td: stats.rec_td ?? stats.receiving_tds,
        targets: stats.targets ?? stats.rec_tgt ?? stats.tgt,
        carries: stats.carries ?? stats.rush_att ?? stats.rushing_att,
      }
      if (!Number.isFinite(w.week) || !Number.isFinite(w.season)) continue
      if (!bucket.has(id)) bucket.set(id, [])
      bucket.get(id)!.push(w)
    }
  }

  const rows: ProjectionRow[] = []
  for (const p of players) {
    const arr = bucket.get(p.player_id) ?? []
    const last50 = lastNPlayedPoints(arr, 50, opts.preset, opts.passTd)
    const base = average(last50)
    const age = yearsSince(p.birth_date) ? Math.floor(yearsSince(p.birth_date)!) : undefined
    const adj = base * ageMultiplier(p.position, age)
    rows.push({
      player_id: p.player_id,
      full_name: p.full_name,
      position: p.position,
      team: p.team,
      ppg: Number.isFinite(adj) ? adj : 0,
    })
  }
  return rows
}

/* ---------------- route ---------------- */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const preset = (url.searchParams.get('preset') || 'PPR').toUpperCase() as ScoringPreset
  const passTd = (Number(url.searchParams.get('passTd') || 4) === 6 ? 6 : 4) as 4|6
  const pos = (url.searchParams.get('pos') || '').toUpperCase()
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)))
  const exclude = new Set((url.searchParams.get('exclude') || '').split(',').map(s => s.trim()).filter(Boolean))
  const idsParam = url.searchParams.get('ids')
  const fast = url.searchParams.get('fast') === '1'

  // ids → pull specific players fast
  if (idsParam) {
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean)
    const players = await fetchPlayers()
    const subset = players.filter(p => ids.includes(p.player_id))
    const keyPrefix = `${preset}-${passTd}-`
    const out: ProjectionRow[] = []
    for (const p of subset) {
      const k = keyPrefix + p.player_id
      const cached = IDS_CACHE.get(k)
      if (cached && Date.now() - cached.at < STALE_MS && cached.row) {
        out.push(cached.row)
        continue
      }
      const row = (await buildProjectionsFor([p], { preset, passTd }))[0]
      IDS_CACHE.set(k, { at: Date.now(), row })
      out.push(row)
    }
    return new Response(JSON.stringify({ preset, passTd, players: out }), {
      headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=21600, stale-while-revalidate=86400' }
    })
  }

  // ---------- ALL → merge per-position, honor exclude, sort/slice ----------
  if (pos === 'ALL') {
    let merged: ProjectionRow[] = []

    for (const P of POSITIONS) {
      const cacheKey = `${preset}-${passTd}-${P}`
      const cached = posCache.get(cacheKey)

      // use cache if fresh
      if (cached && Date.now() - cached.at < STALE_MS) {
        merged = merged.concat(cached.rows)
        continue
      }

      // in fast mode, skip building now (we'll fallback below if nothing)
      if (fast) continue

      // else build & cache this position
      const all = await fetchPlayers()
      const subset = all.filter(p => p.position === P)
      const rows = await buildProjectionsFor(subset, { preset, passTd })
      posCache.set(cacheKey, { at: Date.now(), rows })
      merged = merged.concat(rows)
    }

    // fallback: if fast=1 and nothing was cached, build once so UI isn't empty
    if (merged.length === 0) {
      const allPlayers = await fetchPlayers()
      for (const P of POSITIONS) {
        const cacheKey = `${preset}-${passTd}-${P}`
        const subset = allPlayers.filter(p => p.position === P)
        const rows = await buildProjectionsFor(subset, { preset, passTd })
        posCache.set(cacheKey, { at: Date.now(), rows })
        merged = merged.concat(rows)
      }
    }

    const pruned = merged
      .filter(r => r && !exclude.has(r.player_id))
      .sort((a, b) => (b.ppg || 0) - (a.ppg || 0))
      .slice(0, limit)

    return new Response(JSON.stringify({ preset, passTd, players: pruned }), {
      headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=21600, stale-while-revalidate=86400' }
    })
  }

  // ---------- per-position ----------
  const POSITIONS_SET = new Set(POSITIONS)
  if (!POSITIONS_SET.has(pos as PosKey)) {
    return new Response(JSON.stringify({ error: 'Provide ?pos=QB|RB|WR|TE or ids=... or pos=ALL' }), { status: 400 })
  }

  const cacheKey = `${preset}-${passTd}-${pos}`
  const cached = posCache.get(cacheKey)
  if (cached && Date.now() - cached.at < STALE_MS) {
    const pruned = cached.rows.filter(r => !exclude.has(r.player_id)).sort((a,b)=>b.ppg-a.ppg).slice(0, limit)
    return new Response(JSON.stringify({ preset, passTd, players: pruned }), {
      headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=21600, stale-while-revalidate=86400' }
    })
  }

  const all = await fetchPlayers()
  const subset = all.filter(p => p.position === pos)
  const rows = await buildProjectionsFor(subset, { preset, passTd })
  posCache.set(cacheKey, { at: Date.now(), rows })

  const pruned = rows.filter(r => !exclude.has(r.player_id)).sort((a,b)=>b.ppg-a.ppg).slice(0, limit)
  return new Response(JSON.stringify({ preset, passTd, players: pruned }), {
    headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=21600, stale-while-revalidate=86400' }
  })
}