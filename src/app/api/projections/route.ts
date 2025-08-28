/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = 'nodejs'

type PlayerLite = {
  player_id: string
  full_name: string
  position: 'QB' | 'RB' | 'WR' | 'TE' | string
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
  position: 'QB'|'RB'|'WR'|'TE'|string
  team?: string
  ppg: number
}

const SEASONS = [2020, 2021, 2022, 2023, 2024]
const LAST_N = 50
const BUILD_TTL_MS = 1000 * 60 * 60 // 1 hour cache
const MAX_CONCURRENCY = 10

/* ---------------- shared tiny utils ---------------- */
function yearsSince(dateISO?: string) {
  if (!dateISO) return undefined
  const d = new Date(dateISO); if (Number.isNaN(d.getTime())) return undefined
  const now = new Date()
  return (now.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000)
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}
function ageMultiplier(pos: string, age?: number) {
  if (!age) return 1
  let mult = 1
  if (pos === 'RB') {
    const d = age - 26
    if (d > 0) mult *= 1 - clamp(0.06 * d, 0, 0.25)
    if (d < 0) mult *= 1 + clamp(0.02 * -d, 0, 0.08)
  } else if (pos === 'WR') {
    const d = age - 27
    if (d > 0) mult *= 1 - clamp(0.03 * d, 0, 0.18)
    if (d < 0) mult *= 1 + clamp(0.015 * -d, 0, 0.06)
  } else if (pos === 'TE') {
    const d = age - 28
    if (d > 0) mult *= 1 - clamp(0.02 * d, 0, 0.12)
    if (d < 0) mult *= 1 + clamp(0.01 * -d, 0, 0.05)
  } else if (pos === 'QB') {
    const d = age - 32
    if (d > 0) mult *= 1 - clamp(0.015 * d, 0, 0.12)
    if (d < 0) mult *= 1 + clamp(0.01 * -d, 0, 0.05)
  }
  return mult
}
function pickNum(row: Record<string, any>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return undefined
}
function weeklyPoints(stat: WeeklyStat, preset: 'PPR'|'HALF_PPR'|'STANDARD', passTd: 4|6) {
  if (preset === 'PPR' && stat.pts_ppr != null) return stat.pts_ppr!
  if (preset === 'HALF_PPR' && stat.pts_half_ppr != null) return stat.pts_half_ppr!
  if (preset === 'STANDARD' && stat.pts_std != null) return stat.pts_std!
  const passPoints = (stat.pass_yd ?? 0) * 0.04 + (stat.pass_td ?? 0) * passTd + (stat.pass_int ?? 0) * -1
  const rushPoints = (stat.rush_yd ?? 0) * 0.1 + (stat.rush_td ?? 0) * 6
  const catchBonus = preset === 'PPR' ? 1 : preset === 'HALF_PPR' ? 0.5 : 0
  const recPoints = (stat.rec_yd ?? 0) * 0.1 + (stat.rec_td ?? 0) * 6 + (stat.rec ?? 0) * catchBonus
  return passPoints + rushPoints + recPoints
}

/* -------------- fetch players + cache -------------- */
let _playersCache: { at: number; players: PlayerLite[] } | null = null
async function loadPlayers(): Promise<PlayerLite[]> {
  if (_playersCache && Date.now() - _playersCache.at < BUILD_TTL_MS) return _playersCache.players
  const r = await fetch('https://api.sleeper.app/v1/players/nfl', { cache: 'no-store' })
  const json = await r.json()
  const players: PlayerLite[] = Object.values(json).map((p: any) => ({
    player_id: String(p.player_id ?? p.id ?? ''),
    full_name: p.full_name || (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name ?? ''),
    position: p.position,
    team: p.team,
    birth_date: p.birth_date || p.birthdate || p.birthDate,
  })).filter(p => p.player_id && p.full_name && ['QB','RB','WR','TE'].includes(p.position))
  _playersCache = { at: Date.now(), players }
  return players
}

/* -------------- week fetch cache (shared) ---------- */
const weekCache = new Map<string, any[]>()
const weekCacheTime = new Map<string, number>()
const WEEK_TTL_MS = 15 * 60 * 1000

async function fetchWeek(season: number, week: number): Promise<any[]> {
  const key = `${season}:${week}`
  const now = Date.now()
  const ts = weekCacheTime.get(key)
  if (ts && now - ts < WEEK_TTL_MS && weekCache.has(key)) {
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
        weekCache.set(key, arr); weekCacheTime.set(key, now)
        return arr
      }
    } catch {}
  }
  weekCache.set(key, []); weekCacheTime.set(key, now)
  return []
}

/* -------------- compute last-50 PPG ---------------- */
function lastNPlayedPoints(weeks: WeeklyStat[], n: number, preset: 'PPR'|'HALF_PPR'|'STANDARD', passTd: 4|6) {
  // weeks may arrive mixed; we only need non-zero fantasy outputs
  const pts: number[] = []
  // prefer newest first for “last N”
  const sorted = [...weeks].sort((a, b) => (b.season - a.season) || (b.week - a.week))
  for (const w of sorted) {
    const p = weeklyPoints(w, preset, passTd)
    if (p !== 0) {
      pts.push(p)
      if (pts.length >= n) break
    }
  }
  return pts
}

async function fetchLast50ForPlayer(p: PlayerLite, preset: 'PPR'|'HALF_PPR'|'STANDARD', passTd: 4|6): Promise<number> {
  const id = p.player_id
  const idNum = Number(id); const hasNum = !Number.isNaN(idNum)
  const weeks: WeeklyStat[] = []
  let collected = 0

  for (const season of [...SEASONS].sort((a,b)=>b-a)) {
    if (collected >= LAST_N) break
    for (let wk = 18; wk >= 1; wk--) {
      const arr = await fetchWeek(season, wk)
      if (!arr.length) continue
      const row =
        arr.find((x: any) => String(x.player_id) === String(id)) ??
        (hasNum ? arr.find((x: any) => Number(x.player_id) === idNum) : undefined)
      if (!row) continue

      const s = (row.stats ?? row) as Record<string, any>
      const stat: WeeklyStat = {
        week: wk, season, player_id: id,
        pts_ppr: pickNum(s, ['pts_ppr','ppr_points']),
        pts_half_ppr: pickNum(s, ['pts_half_ppr','half_ppr_points']),
        pts_std: pickNum(s, ['pts_std','standard_points']),
        pass_yd: pickNum(s, ['pass_yd','passing_yards']),
        pass_td: pickNum(s, ['pass_td','passing_tds']),
        pass_int: pickNum(s, ['pass_int','interceptions']),
        rush_yd: pickNum(s, ['rush_yd','rushing_yards']),
        rush_td: pickNum(s, ['rush_td','rushing_tds']),
        rec: pickNum(s, ['rec','receptions']),
        rec_yd: pickNum(s, ['rec_yd','receiving_yards']),
        rec_td: pickNum(s, ['rec_td','receiving_tds']),
        targets: pickNum(s, ['targets','tgt','rec_tgt']),
        carries: pickNum(s, ['carries','rush_att','rushing_att']),
      }
      // if all undefined, skip; else accept
      if (
        stat.pts_ppr != null || stat.pts_half_ppr != null || stat.pts_std != null ||
        stat.pass_yd != null || stat.rush_yd != null || stat.rec_yd != null || stat.rec != null
      ) {
        weeks.push(stat)
        collected++
        if (collected >= LAST_N) break
      }
    }
  }

  if (!weeks.length) return 0
  const pts = lastNPlayedPoints(weeks, LAST_N, preset, passTd)
  const base = pts.length ? pts.reduce((s,v)=>s+v,0)/pts.length : 0
  const ageYears = p.birth_date ? Math.floor(yearsSince(p.birth_date) || 0) : undefined
  return base * ageMultiplier(p.position, ageYears)
}

/* -------------- cache build ---------------- */
let _projectionsCache:
  | { at: number; preset: 'PPR'|'HALF_PPR'|'STANDARD'; passTd: 4|6; rows: ProjectionRow[] }
  | null = null
let _building: Promise<void> | null = null

async function ensureProjections(preset: 'PPR'|'HALF_PPR'|'STANDARD', passTd: 4|6) {
  const fresh = _projectionsCache &&
    Date.now() - _projectionsCache.at < BUILD_TTL_MS &&
    _projectionsCache.preset === preset &&
    _projectionsCache.passTd === passTd
  if (fresh) return

  if (_building) { await _building; return }

  _building = (async () => {
    const players = await loadPlayers()

    // Prioritize players with a current team & cap the pool a bit for speed
    const withTeam = players.filter(p => !!p.team)
    const withoutTeam = players.filter(p => !p.team)
    const pool = [...withTeam.slice(0, 1200), ...withoutTeam.slice(0, 400)] // tune caps as needed

    const rows: ProjectionRow[] = []
    let idx = 0

    async function worker() {
      while (idx < pool.length) {
        const p = pool[idx++]
        try {
          const ppg = await fetchLast50ForPlayer(p, preset, passTd)
          if (ppg > 0) {
            rows.push({
              player_id: p.player_id,
              full_name: p.full_name,
              position: p.position,
              team: p.team,
              ppg,
            })
          }
        } catch { /* skip on error */ }
      }
    }

    await Promise.all(Array.from({ length: MAX_CONCURRENCY }, () => worker()))

    _projectionsCache = { at: Date.now(), preset, passTd, rows }
  })()

  try { await _building } finally { _building = null }
}

/* -------------- GET handler ---------------- */
export async function GET(req: Request) {
    const url = new URL(req.url)
    const preset = (url.searchParams.get('preset') || 'PPR') as 'PPR'|'HALF_PPR'|'STANDARD'
    const passTd = (Number(url.searchParams.get('passTd') || 4) === 6 ? 6 : 4) as 4|6
    const pos = (url.searchParams.get('pos') || '').toUpperCase()
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)))
    const exclude = new Set((url.searchParams.get('exclude') || '')
      .split(',').map(s => s.trim()).filter(Boolean))
  
    // NEW: ids=4866,4034 to fetch specific players
    const idsParam = url.searchParams.get('ids')
    const ids = idsParam ? new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean)) : null
  
    await ensureProjections(preset, passTd)
    const rows = _projectionsCache?.rows || []
  
    let filtered = rows
  
    if (ids) {
      filtered = rows.filter(r => ids.has(r.player_id))
    } else {
      // original position/limit path
      if (pos && ['QB','RB','WR','TE'].includes(pos)) filtered = filtered.filter(r => r.position === pos)
      filtered = filtered.filter(r => !exclude.has(r.player_id)).sort((a,b)=>b.ppg - a.ppg).slice(0, limit)
    }
  
    return new Response(JSON.stringify({
      updatedAt: _projectionsCache?.at ?? Date.now(),
      preset,
      passTd,
      players: filtered,
    }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    })
  }  