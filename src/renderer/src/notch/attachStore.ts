import { useSyncExternalStore } from 'react'

// Attach-mode store. While ON, the agent session view (IslandPanel) shows a big "Attach this session" checkbox in
// place of the steer bar; checking a session records its id->label here. The Support page reads `selected` to render
// the attachment cards and, on send, fetches each session's FULL jsonl (agentOS.agentTranscript) and uploads it.
// Module-level external store (NO zustand — the mandated stagingStore.ts pattern) so it survives the
// NotchHost/IslandPanel remounts across island open/close. `selected` is REPLACED on every change so getSnapshot
// returns a stable ref between changes (useSyncExternalStore never loops).

let mode = false
let selected: Map<string, string> = new Map() // sessionId -> label (the agent title captured at toggle time)
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function enterAttach(): void {
  if (mode) return
  mode = true
  emit()
}
export function exitAttach(): void {
  if (!mode) return
  mode = false // keep `selected` — the Support page shows them as cards
  emit()
}
export function toggleSession(id: string, label: string): void {
  const next = new Map(selected)
  if (next.has(id)) next.delete(id)
  else next.set(id, label)
  selected = next
  emit()
}
export function removeAttached(id: string): void {
  if (!selected.has(id)) return
  const next = new Map(selected)
  next.delete(id)
  selected = next
  emit()
}
export function clearAttach(): void {
  if (!mode && selected.size === 0) return
  mode = false
  selected = new Map()
  emit()
}

export function useAttachMode(): boolean {
  return useSyncExternalStore(subscribe, () => mode)
}
/** The attached sessions as a STABLE Map ref (id -> label) between changes. */
export function useAttachedSessions(): Map<string, string> {
  return useSyncExternalStore(subscribe, () => selected)
}
export function useIsAttached(id: string): boolean {
  return useSyncExternalStore(subscribe, () => selected.has(id))
}
