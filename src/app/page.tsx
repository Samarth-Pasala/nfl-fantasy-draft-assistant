'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Loader2, Search, Scale, Info, TrendingUp, X } from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  Legend,
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

/** Small, position-specific age multiplier (kept; no half-life). */
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

function usePlayerBundle(id?: string, preset: ScoringPreset = 'PPR', passTd: 4 | 6 = 4) {
  const [player, setPlayer] = useState<PlayerLite | null>(null)
  const [weeks, setWeeks] = useState<WeeklyStat[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    if (!id) { setPlayer(null); setWeeks([]); return }
    setLoading(true)
    setErr(null)
    Promise.all([
      fetch(`/api/players/by-id?id=${encodeURIComponent(id)}`).then(r => r.json()),
      fetch(`/api/stats/${id}?seasons=2020,2021,2022,2023,2024`).then(r => r.json()),
    ])
      .then(([p, s]: [Record<string, unknown>, Record<string, unknown>]) => {
        if (ignore) return
        const pl = (p.player as PlayerLite) ?? null
        const wk = (s.weeks as WeeklyStat[]) ?? []
        setPlayer(pl)
        setWeeks(Array.isArray(wk) ? wk : [])
      })
      .catch(() => { if (!ignore) setErr('Failed to load player data') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [id])

  const ageYears = useMemo(
    () => (player?.birth_date ? Math.floor(yearsSince(player.birth_date) || 0) : undefined),
    [player?.birth_date]
  )

  const ppg = useMemo(
    () => projectPPG_Last50Avg(weeks, preset, passTd, player?.position, ageYears),
    [weeks, preset, passTd, player?.position, ageYears]
  )

  return { player, weeks, ppg, loading, err }
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

const DEFAULT_SLOTS: SlotDef[] = [
  { key: 'QB1',  label: 'QB',   types: ['QB'] },
  { key: 'RB1',  label: 'RB1',  types: ['RB'] },
  { key: 'RB2',  label: 'RB2',  types: ['RB'] },
  { key: 'WR1',  label: 'WR1',  types: ['WR'] },
  { key: 'WR2',  label: 'WR2',  types: ['WR'] },
  { key: 'WR3',  label: 'WR3',  types: ['WR'] },
  { key: 'TE1',  label: 'TE',   types: ['TE'] },

  // Bench 1-6 (any position)
  { key: 'BN1',  label: 'Bench 1', types: ['QB','RB','WR','TE'] },
  { key: 'BN2',  label: 'Bench 2', types: ['QB','RB','WR','TE'] },
  { key: 'BN3',  label: 'Bench 3', types: ['QB','RB','WR','TE'] },
  { key: 'BN4',  label: 'Bench 4', types: ['QB','RB','WR','TE'] },
  { key: 'BN5',  label: 'Bench 5', types: ['QB','RB','WR','TE'] },
  { key: 'BN6',  label: 'Bench 6', types: ['QB','RB','WR','TE'] },
]

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
              if (takenIds.has(p.player_id)) return // prevent duplicates
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
    () => Object.fromEntries(DEFAULT_SLOTS.map(s => [s.key, null]))
  )

  const takenIds = useMemo(() => {
    const s = new Set<string>()
    for (const v of Object.values(slots)) if (v) s.add(v.player_id)
    return s
  }, [slots])

  const total = Object.values(slots).filter(Boolean).length

  const rows = DEFAULT_SLOTS.map(def => {
    const p = slots[def.key]
    return (
      <_RosterRow
        key={def.key}
        def={def}
        player={p}
        setPlayer={(np) => setSlots(prev => ({ ...prev, [def.key]: np }))}
        preset={preset}
        passTd={passTd}
        games={games}
        takenIds={takenIds}
      />
    )
  })

  const projectedTotalPoints = (
    <_SumProjected slots={slots} preset={preset} passTd={passTd} games={games} />
  )

  return (
    <Card className="bg-white/10 border-white/20 text-white">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-lg font-semibold">Roster Builder</div>
          <div className="text-sm opacity-90">Slots filled: {total} / {DEFAULT_SLOTS.length}</div>
        </div>
        <Separator className="bg-white/20" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows}
        </div>
        <Separator className="bg-white/20" />
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="text-sm opacity-85">Bench accepts any position (QB / RB / WR / TE)</div>
          {projectedTotalPoints}
        </div>
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
    <div className="text-right">
      <div className="text-xs opacity-80">Roster projection</div>
      <div className="text-xl font-semibold">{totalSeason.toFixed(1)} <span className="text-sm font-normal opacity-80">pts</span></div>
      <div className="text-xs opacity-75">≈ {totalPPG.toFixed(2)} PPG × {games}</div>
    </div>
  )
}

/* ================================== Page ================================== */

export default function Page() {
  // state
  const [preset, setPreset] = useState<ScoringPreset>('PPR')
  const [passTd, setPassTd] = useState<4 | 6>(4)
  const [games, setGames] = useState(17)
  const [left, setLeft] = useState<PlayerLite | null>(null)
  const [right, setRight] = useState<PlayerLite | null>(null)

  const leftBundle = usePlayerBundle(left?.player_id, preset, passTd)
  const rightBundle = usePlayerBundle(right?.player_id, preset, passTd)

  const leftProj = useMemo(() => (leftBundle.ppg || 0) * games, [leftBundle.ppg, games])
  const rightProj = useMemo(() => (rightBundle.ppg || 0) * games, [rightBundle.ppg, games])

  const winner = useMemo(() => {
    if (!left || !right) return null
    if (leftProj === rightProj) return 'Tie'
    return leftProj > rightProj ? left.full_name : right.full_name
  }, [left, right, leftProj, rightProj])

  // Build chart data from the last 50 played games (oldest → newest)
  const chartData = useMemo(() => {
    const a = lastNPlayedPoints(leftBundle.weeks ?? [], 50, preset, passTd)
    const b = lastNPlayedPoints(rightBundle.weeks ?? [], 50, preset, passTd)
    const len = Math.max(a.length, b.length)
    const rows = []
    for (let i = 0; i < len; i++) {
      rows.push({
        game: i + 1,
        [left?.full_name || 'Player A']: a[i] ?? null,
        [right?.full_name || 'Player B']: b[i] ?? null,
      })
    }
    return rows
  }, [left?.full_name, right?.full_name, leftBundle.weeks, rightBundle.weeks, preset, passTd])

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
        {/* ======= ROW 1: PRESET BOX ======= */}
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

        {/* ======= ROW 2: PLAYER PICKER BOXES ======= */}
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

        {/* ======= ROW 3: SUMMARY CARDS ======= */}
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

        {/* ======= ROW 4: RECOMMENDATION + LINE CHART ======= */}
        {(left && right) && (
          <Card className="bg-white/10 border-white/20 text-white">
            <CardContent className="p-4 space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <Scale className="w-5 h-5" /> Draft Recommendation
                </div>
                <div className="text-sm opacity-90">
                  Scoring: {PRESET_LABEL[preset]} • Pass TD: {passTd} • Games: {games} • Basis: last 50 played games (age-adj)
                </div>
              </div>
              <Separator className="bg-white/20" />
              <div className="flex items-center gap-3 text-xl">
                {leftProj === rightProj
                  ? <span>It’s a <b>coin flip</b> based on your settings.</span>
                  : <span><b>{winner ?? ''}</b> looks better on projected season points.</span>}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-4 h-4 opacity-80" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">
                    Projection = simple average of last 50 played games using your scoring, adjusted slightly for age by position.
                    Chart shows those game-by-game points (older → newer).
                  </TooltipContent>
                </Tooltip>
              </div>

              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="game" tick={{ fontSize: 12, fill: '#E8EEF6' }} stroke="#E8EEF6" />
                    <YAxis tick={{ fontSize: 12, fill: '#E8EEF6' }} stroke="#E8EEF6" />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#E8EEF6' }} />
                    <RTooltip formatter={(v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v))} />

                    <Line
                      type="monotone"
                      dataKey={left?.full_name || 'Player A'}
                      dot={false}
                      strokeWidth={2}
                      stroke="#20C997"
                      connectNulls
                    />

                    <Line
                      type="monotone"
                      dataKey={right?.full_name || 'Player B'}
                      dot={false}
                      strokeWidth={2}
                      stroke="#D50A0A"
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

            </CardContent>
          </Card>
        )}

        {/* ======= ROW 5: ROSTER BUILDER ======= */}
        <RosterBuilder preset={preset} passTd={passTd} games={games} />

        <Card className="bg-white/10 border-white/20 text-white">
          <CardContent className="p-4 text-xs space-y-2">
            <div className="flex items-center gap-2 font-medium text-sm"><TrendingUp className="w-4 h-4" /> About the model</div>
            <p className="opacity-90">
              Transparent projection: average of last 50 played games (equal weight) with a small age adjustment by position.
            </p>
          </CardContent>
        </Card>
      </main>
    </TooltipProvider>
  )
}