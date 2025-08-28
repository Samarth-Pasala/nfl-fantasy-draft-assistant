/* eslint-disable @typescript-eslint/no-explicit-any */

'use client'

import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Loader2, Search, Scale, Info, TrendingUp, X, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Legend,
  Tooltip as RTooltip,
  CartesianGrid,
} from 'recharts'


/* ============================= Types & helpers ============================= */

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
  position: 'QB' | 'RB' | 'WR' | 'TE' | string
  team?: string
  ppg: number
}

type SeasonSummary = {
  season: number
  games: number
  ppg_ppr: number
  carries_pg: number
  targets_pg: number
  pass_att_pg: number
  rush_att_pg: number
}


type ScoringPreset = 'STANDARD' | 'HALF_PPR' | 'PPR'
const PRESET_LABEL: Record<ScoringPreset, string> = {
  STANDARD: 'Standard',
  HALF_PPR: 'Half-PPR',
  PPR: 'PPR',
}

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

/* =========================== Scoring & Projection ========================= */

function weeklyPoints(stat: WeeklyStat, preset: ScoringPreset, passTd: 4 | 6) {
  if (preset === 'PPR' && stat.pts_ppr != null) return stat.pts_ppr
  if (preset === 'HALF_PPR' && stat.pts_half_ppr != null) return stat.pts_half_ppr
  if (preset === 'STANDARD' && stat.pts_std != null) return stat.pts_std

  const passPoints = (stat.pass_yd ?? 0) * 0.04 + (stat.pass_td ?? 0) * passTd + (stat.pass_int ?? 0) * -1
  const rushPoints = (stat.rush_yd ?? 0) * 0.1 + (stat.rush_td ?? 0) * 6
  const catchBonus = preset === 'PPR' ? 1 : preset === 'HALF_PPR' ? 0.5 : 0
  const recPoints = (stat.rec_yd ?? 0) * 0.1 + (stat.rec_td ?? 0) * 6 + (stat.rec ?? 0) * catchBonus
  return passPoints + rushPoints + recPoints
}

function seasonsFromWeekly(
  weeks: WeeklyStat[],
  preset: ScoringPreset,
  passTd: 4 | 6
): SeasonSummary[] {
  const bySeason: Record<number, WeeklyStat[]> = {}
  weeks.forEach(w => { (bySeason[w.season] ||= []).push(w) })

  return Object.entries(bySeason).map(([s, arr]) => {
    const games = arr.length
    const total = arr.reduce((sum, w) => sum + weeklyPoints(w, preset, passTd), 0)
    const carries = arr.reduce((sum, w) => sum + (w.carries ?? 0), 0)
    const targets = arr.reduce((sum, w) => sum + (w.targets ?? w.rec ?? 0), 0)

    return {
      season: Number(s),
      games,
      ppg_ppr: games ? total / games : 0,
      carries_pg: games ? carries / games : 0,
      targets_pg: games ? targets / games : 0,
      pass_att_pg: 0,
      rush_att_pg: games ? carries / games : 0,
    }
  }).sort((a, b) => a.season - b.season)
}


/** A game counts as "played" if any meaningful stat was logged (avoids DNPs). */
function didPlay(w: WeeklyStat): boolean {
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

/** Return last N *played* game point totals (oldest → newest). */
function lastNPlayedPoints(
  weeks: WeeklyStat[],
  N: number,
  preset: ScoringPreset,
  passTd: 4 | 6
): number[] {
  const ordered = [...weeks].sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season
    return a.week - b.week
  })
  const ptsPlayed = ordered.filter(didPlay).map(w => weeklyPoints(w, preset, passTd))
  return ptsPlayed.slice(Math.max(0, ptsPlayed.length - N))
}

/** Small, position-specific age multiplier. */
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

function average(xs: number[]) {
  return xs.length ? xs.reduce((a,b)=>a+b,0) / xs.length : 0
}

function ppgFromLastN(
  weeks: WeeklyStat[],
  preset: ScoringPreset,
  passTd: 4 | 6,
  position?: string,
  birthDateISO?: string
) {
  const pts = lastNPlayedPoints(weeks, 50, preset, passTd) // you already have this helper
  const base = average(pts)

  const ageYears = yearsSince(birthDateISO)
  const age = typeof ageYears === 'number' ? Math.floor(ageYears) : undefined
  const mult = ageMultiplier(position || '', age)

  const ppg = base * mult
  return Number.isFinite(ppg) ? ppg : 0
}


/** Projection: simple average of last 50 *played* games, then age adjustment. */
function projectPPG_Last50Avg(
  weeks: WeeklyStat[],
  preset: ScoringPreset,
  passTd: 4 | 6,
  pos?: string,
  age?: number
): number {
  const pts = lastNPlayedPoints(weeks, 50, preset, passTd)
  const base = pts.length ? pts.reduce((s, x) => s + x, 0) / pts.length : 0
  return base * ageMultiplier(pos || '', age)
}

/* ================================ Hooks =================================== */

function useDebounced<T>(val: T, ms = 300) {
  const [v, setV] = useState<T>(val)
  useEffect(() => {
    const t = setTimeout(() => setV(val), ms)
    return () => clearTimeout(t)
  }, [val, ms])
  return v
}

function usePlayerBundle(
  id?: string,
  preset: ScoringPreset = 'PPR',
  passTd: 4 | 6 = 4
) {
  const [player, setPlayer] = React.useState<PlayerLite | null>(null)
  const [ppg, setPpg] = React.useState<number>(0)
  const [summaries, setSummaries] = React.useState<SeasonSummary[]>([])
  const [weeks, setWeeks] = React.useState<WeeklyStat[]>([])   // ← add this
  const [loading, setLoading] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    let ignore = false

    async function run() {
      if (!id) {
        setPlayer(null)
        setPpg(0)
        setSummaries([])
        setWeeks([])                          // ← clear weeks when no id
        return
      }

      setLoading(true)
      setErr(null)

      try {
        // basic player
        const pRes = await fetch(`/api/players/by-id?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
        const pJson = await pRes.json()
        if (!ignore) setPlayer((pJson.player as PlayerLite) ?? null)

        // projection from cache
        const projRes = await fetch(`/api/projections?ids=${encodeURIComponent(id)}&preset=${preset}&passTd=${passTd}`, { cache: 'no-store' })
        if (projRes.ok) {
          const proj = await projRes.json() as { players: { player_id: string; ppg: number }[] }
          const row = proj.players?.[0]
          if (!ignore && row && row.player_id === id) setPpg(row.ppg || 0)
        } else {
          if (!ignore) setPpg(0)
        }

        // weeks for charts (optional)
        const sRes = await fetch(`/api/stats/${encodeURIComponent(id)}?seasons=2020,2021,2022,2023,2024`, { cache: 'no-store' })
        if (sRes.ok) {
          const sJson = await sRes.json() as { weeks: WeeklyStat[] }
          if (!ignore) {
            setWeeks(Array.isArray(sJson.weeks) ? sJson.weeks : [])         // ← keep raw weeks
            setSummaries(seasonsFromWeekly(sJson.weeks || [], preset, passTd))
          }
        } else {
          if (!ignore) { setWeeks([]); setSummaries([]) }
        }
      } catch (e: any) {
        if (!ignore) setErr(e?.message || 'Failed to load player data')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    run()
    return () => { ignore = true }
  }, [id, preset, passTd])

  // ← include weeks in the return shape
  return { player, summaries, weeks, ppg, loading, err }
}

/* ============================= UI components ============================== */

function PlayerSearch({
  label,
  onPick,
  filterPositions,
}: {
  label: string
  onPick: (p: PlayerLite) => void
  filterPositions?: string[]
}) {
  const [q, setQ] = useState('')
  const deb = useDebounced(q, 250)
  const [results, setResults] = useState<PlayerLite[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let ignore = false
    if (!deb) { setResults([]); return }
    setLoading(true)
    fetch(`/api/players/search?q=${encodeURIComponent(deb)}`)
      .then(r => r.json())
      .then((d: Record<string, unknown>) => {
        if (ignore) return
        let arr = (d.results as PlayerLite[]) || []
        if (filterPositions?.length) {
          const set = new Set(filterPositions.map(s => s.toUpperCase()))
          arr = arr.filter(p => set.has(String(p.position).toUpperCase()))
        }
        setResults(Array.isArray(arr) ? arr : [])
      })
      .catch(() => { if (!ignore) setResults([]) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [deb, filterPositions])

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="relative">
        <Input placeholder="Type a name (e.g., Saquon Barkley)" value={q} onChange={e => setQ(e.target.value)} className="pr-10" />
        <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 opacity-70" />
      </div>
      {loading && (
        <div className="text-xs opacity-80 flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" /> Searching…
        </div>
      )}
      {results.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-xl border border-white/20 bg-white/5 backdrop-blur">
          {results.map(r => (
            <button
              key={r.player_id}
              onClick={() => { onPick(r); setResults([]); setQ('') }}
              className="w-full text-left px-3 py-2 hover:bg-white/10"
            >
              <div className="font-medium">
                {r.full_name}{' '}
                <span className="text-xs opacity-80 ml-1">
                  {r.position} {r.team ? `• ${r.team}` : ''}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================ Roster Builder ============================== */

type SlotDef = { key: string; label: string; types: ('QB'|'RB'|'WR'|'TE')[] }

const STARTER_SLOTS: SlotDef[] = [
  { key: 'QB1',  label: 'QB',   types: ['QB'] },
  { key: 'RB1',  label: 'RB1',  types: ['RB'] },
  { key: 'RB2',  label: 'RB2',  types: ['RB'] },
  { key: 'WR1',  label: 'WR1',  types: ['WR'] },
  { key: 'WR2',  label: 'WR2',  types: ['WR'] },
  { key: 'WR3',  label: 'WR3',  types: ['WR'] },
  { key: 'TE1',  label: 'TE',   types: ['TE'] },
]
const BENCH_SLOTS: SlotDef[] = [
  { key: 'BN1',  label: 'Bench 1', types: ['QB','RB','WR','TE'] },
  { key: 'BN2',  label: 'Bench 2', types: ['QB','RB','WR','TE'] },
  { key: 'BN3',  label: 'Bench 3', types: ['QB','RB','WR','TE'] },
  { key: 'BN4',  label: 'Bench 4', types: ['QB','RB','WR','TE'] },
  { key: 'BN5',  label: 'Bench 5', types: ['QB','RB','WR','TE'] },
  { key: 'BN6',  label: 'Bench 6', types: ['QB','RB','WR','TE'] },
]
const ALL_SLOTS = [...STARTER_SLOTS, ...BENCH_SLOTS]

function RosterSlot({
  slot,
  value,
  onChange,
  preset,
  passTd,
  games,
  takenIds,
}: {
  slot: SlotDef
  value: PlayerLite | null
  onChange: (p: PlayerLite | null) => void
  preset: ScoringPreset
  passTd: 4 | 6
  games: number
  takenIds: Set<string>
}) {
  const bundle = usePlayerBundle(value?.player_id, preset, passTd)
  const proj = useMemo(() => (bundle.ppg || 0) * games, [bundle.ppg, games])

  return (
    <Card className="bg-white/10 border-white/20 text-white">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{slot.label}</div>
          <div className="text-xs opacity-80">{slot.types.join(' / ')}</div>
        </div>

        {!value ? (
          <PlayerSearch
            label="Add player"
            filterPositions={slot.types}
            onPick={(p) => {
              if (takenIds.has(p.player_id)) return
              onChange(p)
            }}
          />
        ) : (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium">{value.full_name}</div>
                <div className="text-xs opacity-80">{value.position}{value.team ? ` • ${value.team}` : ''}</div>
              </div>
              <Button size="icon" variant="ghost" onClick={() => onChange(null)} aria-label="Remove">
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="text-xl font-semibold">
              {bundle.loading ? '…' : proj.toFixed(1)} <span className="text-sm font-normal opacity-80">proj pts</span>
            </div>
            <div className="text-xs opacity-85">≈ {(bundle.ppg || 0).toFixed(2)} PPG × {games}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RosterBuilder({
  preset, passTd, games,
}: { preset: ScoringPreset; passTd: 4 | 6; games: number }) {
  const [slots, setSlots] = useState<Record<string, PlayerLite | null>>(
    () => Object.fromEntries(ALL_SLOTS.map(s => [s.key, null]))
  )
  const [benchOpen, setBenchOpen] = useState(true)

  const takenIds = useMemo(() => {
    const s = new Set<string>()
    for (const v of Object.values(slots)) if (v) s.add(v.player_id)
    return s
  }, [slots])

  const startersFilled = STARTER_SLOTS.reduce((n, s) => n + (slots[s.key] ? 1 : 0), 0)
  const benchFilled = BENCH_SLOTS.reduce((n, s) => n + (slots[s.key] ? 1 : 0), 0)

  return (
    <Card className="bg-white/10 border-white/20 text-white">
      <CardContent className="p-4 space-y-4">
        <div className="text-lg font-semibold">Starters</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {STARTER_SLOTS.map(def => (
            <_RosterRow
              key={def.key}
              def={def}
              player={slots[def.key]}
              setPlayer={(np) => setSlots(prev => ({ ...prev, [def.key]: np }))}
              preset={preset}
              passTd={passTd}
              games={games}
              takenIds={takenIds}
            />
          ))}
        </div>

        <Separator className="bg-white/20" />

        <button
          className="w-full flex items-center justify-between px-2 py-2 rounded-lg hover:bg-white/10 transition"
          onClick={() => setBenchOpen(o => !o)}
        >
          <div className="text-lg font-semibold">Bench</div>
          {benchOpen ? <ChevronDown className="w-4 h-4 ml-auto" /> : <ChevronRight className="w-4 h-4 ml-auto" />}
        </button>

        {benchOpen && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {BENCH_SLOTS.map(def => (
              <_RosterRow
                key={def.key}
                def={def}
                player={slots[def.key]}
                setPlayer={(np) => setSlots(prev => ({ ...prev, [def.key]: np }))}
                preset={preset}
                passTd={passTd}
                games={games}
                takenIds={takenIds}
              />
            ))}
          </div>
        )}

        <Separator className="bg-white/20" />
        <_SumProjected slots={slots} preset={preset} passTd={passTd} games={games} />
      </CardContent>
    </Card>
  )
}

function _RosterRow(props: {
  def: SlotDef
  player: PlayerLite | null
  setPlayer: (p: PlayerLite | null) => void
  preset: ScoringPreset
  passTd: 4 | 6
  games: number
  takenIds: Set<string>
}) {
  const { def, player, setPlayer, preset, passTd, games, takenIds } = props
  return (
    <RosterSlot
      slot={def}
      value={player}
      onChange={setPlayer}
      preset={preset}
      passTd={passTd}
      games={games}
      takenIds={takenIds}
    />
  )
}

function _SumProjected({
  slots, preset, passTd, games
}: { slots: Record<string, PlayerLite | null>, preset: ScoringPreset, passTd: 4 | 6, games: number }) {
  const bundles = Object.entries(slots).map(([key, p]) => ({
    key,
    p,
    bundle: usePlayerBundle(p?.player_id, preset, passTd),
  }))
  const totalPPG = bundles.reduce((sum, r) => sum + (r.p ? (r.bundle.ppg || 0) : 0), 0)
  const totalSeason = totalPPG * games
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div className="text-sm opacity-85">Bench accepts any position (QB / RB / WR / TE)</div>
      <div className="text-right">
        <div className="text-xs opacity-80">Roster projection</div>
        <div className="text-xl font-semibold">{totalSeason.toFixed(1)} <span className="text-sm font-normal opacity-80">pts</span></div>
        <div className="text-xs opacity-75">≈ {totalPPG.toFixed(2)} PPG × {games}</div>
      </div>
    </div>
  )
}

/* =============================== Draft Order ============================== */

type DraftPick = { id: string; team: string; player: PlayerLite }

function DraftOrder({
  draftedIds,
  onChange,
}: {
  draftedIds: Set<string>
  onChange: (picks: DraftPick[]) => void
}) {
  const [teams, setTeams] = useState<string[]>([])
  const [picks, setPicks] = useState<DraftPick[]>([])

  // form state
  const [newTeam, setNewTeam] = useState('')
  const [pickTeam, setPickTeam] = useState<string>('')
  const [pendingPlayer, setPendingPlayer] = useState<PlayerLite | null>(null)

  // hydrate
  useEffect(() => {
    try {
      const t = localStorage.getItem('draft_teams_v1')
      const p = localStorage.getItem('draft_picks_v1')
      if (t) setTeams(JSON.parse(t))
      if (p) setPicks(JSON.parse(p))
    } catch {}
  }, [])

  // persist
  useEffect(() => {
    localStorage.setItem('draft_teams_v1', JSON.stringify(teams))
  }, [teams])
  useEffect(() => {
    localStorage.setItem('draft_picks_v1', JSON.stringify(picks))
    onChange(picks)
  }, [picks, onChange])

  // teams crud
  const addTeam = () => {
    const name = newTeam.trim()
    if (!name) return
    if (teams.some(t => t.toLowerCase() === name.toLowerCase())) return
    const next = [...teams, name]
    setTeams(next)
    setNewTeam('')
    if (!pickTeam) setPickTeam(name)
  }
  const removeTeam = (name: string) => {
    const next = teams.filter(t => t !== name)
    setTeams(next)
    if (pickTeam === name) setPickTeam(next[0] ?? '')
    // also strip any picks tied to that team
    setPicks(prev => prev.filter(p => p.team !== name))
  }
  const clearAll = () => {
    setTeams([])
    setPicks([])
    setPickTeam('')
    setPendingPlayer(null)
    localStorage.removeItem('draft_teams_v1')
    localStorage.removeItem('draft_picks_v1')
  }

  // picks
  const addPick = () => {
    if (!pickTeam || !pendingPlayer) return
    const newPick: DraftPick = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      team: pickTeam,
      player: pendingPlayer,
    }
    setPicks(prev => [newPick, ...prev])
    setPendingPlayer(null)
  }
  const removePick = (id: string) => setPicks(prev => prev.filter(p => p.id !== id))

  return (
    <Card className="bg-white/10 border-white/20 text-white">
      <CardContent className="p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Draft Order</div>
          <Button variant="ghost" size="sm" onClick={clearAll}>Clear All</Button>
        </div>

        {/* Teams first */}
        <div className="space-y-3">
          <div className="text-sm font-medium">Teams / Managers (enter all first)</div>
          <div className="flex gap-2">
            <Input
              placeholder="Team or Manager name"
              value={newTeam}
              onChange={(e) => setNewTeam(e.target.value)}
            />
            <Button onClick={addTeam}><Plus className="w-4 h-4 mr-2" />Add</Button>
          </div>
          {teams.length === 0 ? (
            <div className="text-sm opacity-75">No teams yet. Add them above.</div>
          ) : (
            <div className="space-y-2">
              {teams.map((t) => (
                <div key={t} className="rounded border border-white/15 bg-white/5 px-3 py-2 flex items-center justify-between">
                  <div className="text-sm">{t}</div>
                  <Button variant="ghost" size="icon" onClick={() => removeTeam(t)} aria-label="Remove team">
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <Separator className="bg-white/20" />

        {/* Make a pick */}
        <div className="space-y-3">
          <div className="text-sm font-medium">Make Pick</div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <Label className="text-xs">Team</Label>
              <Select value={pickTeam} onValueChange={setPickTeam}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select a team" />
                </SelectTrigger>

                {/* Dark dropdown panel */}
                <SelectContent
                  className="bg-[#0B1220]/95 text-slate-100 border border-white/10 backdrop-blur-md shadow-xl"
                  position="popper"
                  sideOffset={6}
                >
                  {teams.map((t) => (
                    <SelectItem
                      key={t}
                      value={t}
                      className="text-slate-100 focus:bg-white/10 focus:text-white data-[state=checked]:bg-white/15 data-[state=checked]:text-white"
                    >
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

            </div>

            <PlayerSearch label="Select drafted player" onPick={setPendingPlayer} />

            <Button className="w-full" disabled={!pickTeam || !pendingPlayer} onClick={addPick}>
              <Plus className="w-4 h-4 mr-2" /> Add Pick to {pickTeam || 'Team'}
            </Button>
          </div>
        </div>

        <Separator className="bg-white/20" />

        {/* Picks log */}
        <div className="space-y-2 max-h-[420px] overflow-auto pr-1">
          {picks.length === 0 && <div className="text-sm opacity-75">No picks yet. Use “Make Pick”.</div>}
          {picks.map(p => (
            <div key={p.id} className="rounded-lg border border-white/15 p-3 bg-white/5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{p.player.full_name}</div>
                <div className="text-xs opacity-80 truncate">{p.player.position}{p.player.team ? ` • ${p.player.team}` : ''}</div>
                <div className="text-xs opacity-70 truncate">Drafted by {p.team}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => removePick(p.id)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}


/* ============================== Best Available ============================ */

function BestAvailable({
  draftedIds,
  preset,
  passTd,
}: {
  draftedIds: Set<string>
  preset: ScoringPreset
  passTd: 4 | 6
}) {
  const limits = { QB: 5, TE: 5, RB: 10, WR: 10 } as const

  return (
    <Card className="bg-white/10 border-white/20 text-white">
      <CardContent className="p-4 space-y-6">
        <div className="text-lg font-semibold">Best Available</div>
        <div className="text-xs opacity-70">First load may take a bit while projections build. Afterwards, it’s instant (cached).</div>

        <TopForPosition pos="QB" title="Quarterbacks" limit={limits.QB} draftedIds={draftedIds} preset={preset} passTd={passTd} />
        <TopForPosition pos="RB" title="Running Backs" limit={limits.RB} draftedIds={draftedIds} preset={preset} passTd={passTd} />
        <TopForPosition pos="WR" title="Wide Receivers" limit={limits.WR} draftedIds={draftedIds} preset={preset} passTd={passTd} />
        <TopForPosition pos="TE" title="Tight Ends" limit={limits.TE} draftedIds={draftedIds} preset={preset} passTd={passTd} />
      </CardContent>
    </Card>
  )
}

function TopForPosition({
  pos, title, limit, draftedIds, preset, passTd,
}: {
  pos: 'QB' | 'RB' | 'WR' | 'TE'
  title: string
  limit: number
  draftedIds: Set<string>
  preset: ScoringPreset
  passTd: 4 | 6
}) {
  const [rows, setRows] = React.useState<ProjectionRow[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let ignore = false

    async function run() {
      setLoading(true); setError(null); setRows(null)
      try {
        const exclude = Array.from(draftedIds).join(',')
        const res = await fetch(`/api/projections?pos=${pos}&limit=${limit}&preset=${preset}&passTd=${passTd}&exclude=${encodeURIComponent(exclude)}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`projections failed ${res.status}`)
        const json = (await res.json()) as { players: ProjectionRow[] }
        const norm = (s?: string) => String(s || '').toUpperCase().trim()
        const filtered = (json.players || []).filter(p => norm(p.position) === pos)
        if (!ignore) setRows(filtered)
      } catch (e: any) {
        if (!ignore) setError(e?.message || 'Failed to load')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    run()
    return () => { ignore = true }
  }, [pos, limit, draftedIds, preset, passTd])

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold uppercase tracking-wide opacity-90">{title}</div>

      {loading && <div className="text-sm opacity-75">Loading best available {title.toLowerCase()}…</div>}
      {error && !loading && <div className="text-sm text-red-300">{error}</div>}
      {!loading && !error && (!rows || rows.length === 0) && (
        <div className="text-sm opacity-75">No eligible players found.</div>
      )}

      {!!rows && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.player_id} className="rounded-lg border border-white/15 p-3 bg-white/5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{r.full_name}</div>
                <div className="text-xs opacity-80 truncate">
                  {r.position}{r.team ? ` • ${r.team}` : ''}
                </div>
              </div>
              <div className="text-right">
                <div className="text-base font-semibold">{r.ppg.toFixed(2)} <span className="text-xs opacity-75">PPG</span></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ================================== Page ================================== */

export default function Page() {
  // settings
  const [preset, setPreset] = useState<ScoringPreset>('PPR')
  const [passTd, setPassTd] = useState<4 | 6>(4)
  const [games, setGames] = useState(17)

// players for compare
const [left, setLeft] = useState<PlayerLite | null>(null)
const [right, setRight] = useState<PlayerLite | null>(null)

const leftBundle = usePlayerBundle(left?.player_id, preset, passTd)
const rightBundle = usePlayerBundle(right?.player_id, preset, passTd)

// PPG from last 50 *played* games (age-adjusted)
const leftPPG = useMemo(
  () =>
    ppgFromLastN(
      leftBundle.weeks || [],
      preset,
      passTd,
      leftBundle.player?.position,
      leftBundle.player?.birth_date
    ),
  [leftBundle.weeks, preset, passTd, leftBundle.player?.position, leftBundle.player?.birth_date]
)

const rightPPG = useMemo(
  () =>
    ppgFromLastN(
      rightBundle.weeks || [],
      preset,
      passTd,
      rightBundle.player?.position,
      rightBundle.player?.birth_date
    ),
  [rightBundle.weeks, preset, passTd, rightBundle.player?.position, rightBundle.player?.birth_date]
)

// season totals
const leftProj = useMemo(() => leftPPG * games, [leftPPG, games])
const rightProj = useMemo(() => rightPPG * games, [rightPPG, games])

const winner = useMemo(() => {
  if (!left || !right) return null
  if (Math.abs(leftProj - rightProj) < 1e-9) return 'Tie'
  return leftProj > rightProj ? left.full_name : right.full_name
}, [left, right, leftProj, rightProj])


// last 50 *played* games -> numbers only
const chartData = useMemo(() => {
  const a = lastNPlayedPoints(leftBundle.weeks || [], 50, preset, passTd);
  const b = lastNPlayedPoints(rightBundle.weeks || [], 50, preset, passTd);

  // reverse so older -> newer on the x-axis (optional)
  const A = a.slice().reverse();
  const B = b.slice().reverse();

  const len = Math.max(A.length, B.length);
  if (len === 0) return [];

  const rows: Array<Record<string, number>> = [];
  for (let i = 0; i < len; i++) {
    const row: Record<string, number> = { game: i + 1 };
    if (A[i] != null) row[left?.full_name || 'Player A'] = Number(A[i]);
    if (B[i] != null) row[right?.full_name || 'Player B'] = Number(B[i]);
    rows.push(row);
  }
  return rows;
}, [left?.full_name, right?.full_name, leftBundle.weeks, rightBundle.weeks, preset, passTd]);


  // draftedIds from DraftOrder (lift state)
  const [draftedIds, setDraftedIds] = useState<Set<string>>(new Set())
  const handleDraftChange = useCallback((picks: DraftPick[]) => {
    setDraftedIds(new Set(picks.map(p => p.player.player_id)))
  }, [])

  return (
    <TooltipProvider>
      {/* Header */}
      <header className="h-14 border-b border-white/20 px-4 flex items-center justify-between bg-black/20 backdrop-blur">
        <div className="flex items-center gap-2">
          <Scale className="w-5 h-5" />
          <h1 className="text-base font-semibold tracking-tight">Fantasy Draft Assistant (2025)</h1>
        </div>
        <div className="text-xs opacity-80">Data via Sleeper • PPR/Half-PPR/Standard</div>
      </header>

      <main className="p-6 max-w-7xl mx-auto space-y-6">
        {/* ======= PRESET BOX ======= */}
        <Card className="bg-white/10 border-white/20 text-white">
          <CardContent className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
              <div>
                <Label className="text-sm font-medium">Preset</Label>
                <Select value={preset} onValueChange={(v) => setPreset(v as ScoringPreset)}>
                  <SelectTrigger className="w-full mt-1"><SelectValue placeholder="Scoring" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STANDARD">Standard</SelectItem>
                    <SelectItem value="HALF_PPR">Half-PPR</SelectItem>
                    <SelectItem value="PPR">PPR</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm font-medium">Pass TD</Label>
                <Select value={String(passTd)} onValueChange={(v) => setPassTd(Number(v) as 4 | 6)}>
                  <SelectTrigger className="w-full mt-1"><SelectValue placeholder="Pass TD" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="4">4 points</SelectItem>
                    <SelectItem value="6">6 points</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm font-medium">Games</Label>
                <Input type="number" min={10} max={17} className="mt-1"
                  value={games}
                  onChange={e => setGames(clamp(Number(e.target.value), 10, 17))}
                />
              </div>
              <div className="flex items-end">
                <Button className="w-full" variant="outline">Apply Settings</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ======= PLAYER PICKERS ======= */}
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="bg-white/10 border-white/20 text-white">
            <CardContent className="p-4">
              <PlayerSearch label="Player A" onPick={setLeft} />
            </CardContent>
          </Card>
          <Card className="bg-white/10 border-white/20 text-white">
            <CardContent className="p-4">
              <PlayerSearch label="Player B" onPick={setRight} />
            </CardContent>
          </Card>
        </div>

        {/* ======= SUMMARY CARDS ======= */}
        <div className="grid md:grid-cols-2 gap-6">
          <Card className="bg-white/10 border-white/20 text-white">
            <CardContent className="p-4 space-y-4">
              {left ? (
                <div className="space-y-2">
                  <div className="text-sm/5 opacity-90">
                    Selected: <b>{left.full_name}</b>{' '}
                    <span className="opacity-80">({left.position}{left.team ? ` • ${left.team}` : ''})</span>
                  </div>
                  <div className="text-3xl font-semibold">
                    {leftBundle.loading ? '…' : leftProj.toFixed(1)} <span className="text-base font-normal opacity-80">proj pts</span>
                  </div>
                  <div className="text-xs opacity-85">≈ {(leftBundle.ppg || 0).toFixed(2)} PPG × {games} (last 50 played • age-adj)</div>
                </div>
              ) : (
                <div className="text-sm opacity-85">Pick <b>Player A</b> above to see projections.</div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-white/10 border-white/20 text-white">
            <CardContent className="p-4 space-y-4">
              {right ? (
                <div className="space-y-2">
                  <div className="text-sm/5 opacity-90">
                    Selected: <b>{right.full_name}</b>{' '}
                    <span className="opacity-80">({right.position}{right.team ? ` • ${right.team}` : ''})</span>
                  </div>
                  <div className="text-3xl font-semibold">
                    {rightBundle.loading ? '…' : rightProj.toFixed(1)} <span className="text-base font-normal opacity-80">proj pts</span>
                  </div>
                  <div className="text-xs opacity-85">≈ {(rightBundle.ppg || 0).toFixed(2)} PPG × {games} (last 50 played • age-adj)</div>
                </div>
              ) : (
                <div className="text-sm opacity-85">Pick <b>Player B</b> above to see projections.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ======= RECOMMENDATION + CHART ======= */}
        {left && right && (
          <Card className="bg-white/10 border-white/20 text-white">
            <CardContent className="p-4 space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <Scale className="w-5 h-5" /> Draft Recommendation
                </div>
                <div className="text-sm opacity-90">
                  Scoring: {PRESET_LABEL[preset]} • Pass TD: {passTd} • Games: {games}
                </div>
              </div>
              <Separator className="bg-white/20" />
              <div className="flex items-center gap-3 text-xl">
                {leftProj === rightProj ? (
                  <span>It’s a <b>coin flip</b> based on your settings.</span>
                ) : (
                  <span>
                    <b>{leftProj > rightProj ? left?.full_name : right?.full_name}</b> looks better on projected season points.
                  </span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-4 h-4 opacity-80" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">
                    Projection = average of last 50 *played* games (equal weight) with a small age adjustment by position.
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* your line/bar chart stays here */}
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                    {/* dashed background grid (remove this line if you don't want a grid) */}
                    <CartesianGrid strokeDasharray="3 6" stroke="#94a3b866" />

                    <XAxis
                      dataKey="game"
                      tick={{ fontSize: 12, fill: '#E8EEF6' }}
                      stroke="#E8EEF6"
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: '#E8EEF6' }}
                      stroke="#E8EEF6"
                      domain={[0, 'auto']}
                    />

                    <Legend wrapperStyle={{ fontSize: 12, color: '#E8EEF6' }} />
                    <RTooltip
                      formatter={(v: unknown) =>
                        typeof v === 'number' ? v.toFixed(2) : String(v)
                      }
                      labelFormatter={(g) => `Game ${g}`}
                    />

                    {/* Player A = teal/aquamarine */}
                    <Line
                      type="monotone"
                      dataKey={left?.full_name || 'Player A'}
                      stroke="#10b981"     // teal
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                    {/* Player B = red */}
                    <Line
                      type="monotone"
                      dataKey={right?.full_name || 'Player B'}
                      stroke="#ef4444"     // red
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

            </CardContent>
          </Card>
        )}

        {/* ======= ROW 5: 3-COLUMN SECTION ======= */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Starters + Bench */}
          <RosterBuilder preset={preset} passTd={passTd} games={games} />

          {/* Middle: Draft Order */}
          <DraftOrder draftedIds={draftedIds} onChange={handleDraftChange} />

          {/* Right: Best Available (auto-populates; excludes drafted) */}
          <BestAvailable draftedIds={draftedIds} preset={preset} passTd={passTd} />
        </div>

        {/* (Optional) About card — leave if you want; Best Available is NOT duplicated anymore */}
        <Card className="bg-white/10 border-white/20 text-white">
          <CardContent className="p-4 text-xs space-y-2">
            <div className="flex items-center gap-2 font-medium text-sm">
              <TrendingUp className="w-4 h-4" /> About the model
            </div>
            <p className="opacity-90">
              Transparent projection: average of last 50 played games (equal weight) with a small age adjustment by position.
              “Best Available” auto-ranks per position and hides players already drafted in Draft Order.
            </p>
          </CardContent>
        </Card>

      </main>
    </TooltipProvider>
  )
}