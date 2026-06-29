import './island.css'
import { Fragment, useEffect, useRef, useState } from 'react'
import MarkdownMessage from './MarkdownMessage'
import { ChatInput } from './ChatInput'
import { SUPPORT_GRADIENT } from './agentVisuals'
import { useAttachedSessions, enterAttach, removeAttached, clearAttach } from './attachStore'

// "Chat with us" — a real-but-simple support channel that lives INSIDE the island as its own page (sibling to
// Settings). It reuses the agent-chat look (MarkdownMessage bubbles + ChatInput) but talks to the BlitzOS Support
// backend (Blitz/Teenybase on Cloudflare) over plain fetch + polling — NOT the agent runtime. The team answers from
// the /inbox page; replies land here on the next poll. The conversation handle (id + capability secret) persists in
// localStorage so reopening returns to the same thread.
// Build-time configurable (electron.vite.config.ts define): SUPPORT_API_URL at package time injects the deployed
// Cloudflare URL (https://blitzos-support.app.blitz.dev); defaults to localhost for dev.
const SUPPORT_API_BASE = (import.meta.env.VITE_SUPPORT_API as string) || 'http://localhost:8787'
const HANDLE_KEY = 'blitzos.support.handle'
const GREETING =
  'This is the BlitzOS support channel. Send us anything: a bug, an idea, or a question. The team will reply right here.'
// Per-request timeouts so a stalled fetch can't wedge the send queue (a hung doSend blocks every queued send behind it)
// or leak a never-settling poll. Attach is generous since it streams a multi-MB transcript.
const FETCH_TIMEOUT_MS = 30000
const UPLOAD_TIMEOUT_MS = 120000

type Att = { id: string; label: string; bytes: number }
type Msg = { id: string; sender: 'user' | 'agent'; body: string; attachments?: Att[] }
type Handle = { conversationId: string; secret: string }

function readHandle(): Handle | null {
  try {
    const raw = localStorage.getItem(HANDLE_KEY)
    return raw ? (JSON.parse(raw) as Handle) : null
  } catch {
    return null
  }
}
function saveHandle(h: Handle): void {
  try {
    localStorage.setItem(HANDLE_KEY, JSON.stringify(h))
  } catch {
    /* private mode / quota — the thread just won't persist across restarts */
  }
}

export function IslandSupport({ menuBarH, onClose }: { menuBarH: number; onClose: () => void }): JSX.Element {
  const top = Math.max(28, menuBarH) + 8
  const [messages, setMessages] = useState<Msg[]>([]) // server truth — replaced wholesale by poll()
  // Optimistic user messages awaiting server confirmation. They live in a SEPARATE layer poll() never overwrites, so a
  // just-sent message can't be wiped by an in-flight poll or D1 read-replica lag; each is reconciled out only once a
  // poll returns its exact server id (set in send()). This is what makes a sent message appear instantly and stay.
  const [pending, setPending] = useState<Array<Msg & { serverId?: string; failed?: boolean }>>([])
  const seqRef = useRef(0) // monotonic local-id source for optimistic messages
  const [error, setError] = useState('')
  const handleRef = useRef<Handle | null>(readHandle())
  const subjectRef = useRef<string>('')
  const feedRef = useRef<HTMLDivElement>(null)
  const attached = useAttachedSessions() // id -> label of sessions queued to send
  const attachedRef = useRef(attached)
  attachedRef.current = attached
  const queueRef = useRef<Promise<void>>(Promise.resolve()) // serializes network sends so rapid messages queue in order, never silently dropped
  const uploadedRef = useRef<Map<string, string>>(new Map()) // sessionId -> attachmentId, so a 404-retry reuses an upload instead of re-POSTing
  const pollSeqRef = useRef(0) // ++ at each poll START; a poll applies its result only if it's still the newest started
  const appliedSeqRef = useRef(0) // highest poll seq whose result was applied — discards stale out-of-order responses
  const poll404Ref = useRef(0) // consecutive 404s for the CURRENT handle; only drop the handle after a couple in a row

  // Best-effort local identity so the team's inbox shows WHO is writing (not a security boundary).
  useEffect(() => {
    const w = window as unknown as { agentOS?: { whoami?: () => Promise<{ user?: string; host?: string }> } }
    w.agentOS
      ?.whoami?.()
      .then((r) => {
        const user = (r?.user || '').trim()
        const host = (r?.host || '').trim()
        subjectRef.current = user ? (host ? `${user} (${host})` : user) : ''
      })
      .catch(() => {})
  }, [])

  const scrollDown = (): void => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Drop a now-invalid conversation handle (points at a deleted conversation, or one created against a DIFFERENT
  // backend on a previous run) so the next send creates a fresh one instead of looping 404s.
  const dropHandle = (): void => {
    handleRef.current = null
    uploadedRef.current.clear()
    poll404Ref.current = 0 // a fresh handle starts with a clean 404 streak
    try {
      localStorage.removeItem(HANDLE_KEY)
    } catch {
      /* ignore */
    }
  }

  const poll = async (): Promise<void> => {
    const h = handleRef.current
    if (!h) return
    const myseq = ++pollSeqRef.current
    try {
      // secret rides a header, never the URL/query, so it can't land in access logs
      const url = `${SUPPORT_API_BASE}/chat/poll?conversationId=${encodeURIComponent(h.conversationId)}`
      const r = await fetch(url, { headers: { 'X-Conv-Secret': h.secret }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!r.ok) {
        // Only a 404 for the handle THIS poll used counts, and only after a couple in a row. A 404 for a handle that
        // doSend has already replaced (the user sent mid-poll) must not wipe the new one; and a single transient 404
        // (e.g. read-replica lag right after the conversation was created) must not orphan an established thread.
        if (r.status === 404 && handleRef.current === h) {
          poll404Ref.current += 1
          if (poll404Ref.current >= 2) dropHandle()
        }
        return
      }
      poll404Ref.current = 0
      const j = (await r.json()) as { messages?: Array<{ id: string; sender: string; body: string; attachments?: Att[] }> }
      if (Array.isArray(j.messages)) {
        if (myseq < appliedSeqRef.current) return // a newer poll already painted; don't clobber fresh truth with a stale response
        appliedSeqRef.current = myseq
        const server: Msg[] = j.messages.map((m) => ({ id: m.id, sender: m.sender === 'agent' ? 'agent' : 'user', body: m.body, attachments: m.attachments || [] }))
        setMessages(server)
        // Drop any optimistic message the server now reflects (matched by its EXACT id), so it stops double-rendering.
        // Pendings still in flight (no serverId yet) or ones the server hasn't caught up to are kept — stay visible.
        const ids = new Set(server.map((m) => m.id))
        setPending((prev) => (prev.length ? prev.filter((p) => !(p.serverId && ids.has(p.serverId))) : prev))
      }
    } catch {
      /* offline / timeout — keep showing the last known messages */
    }
  }

  // Poll while the page is open. ALWAYS arm the interval — poll() self-guards on a missing handle (no-op until the
  // first send() creates one), so a fresh install starts fetching the moment that handle exists, instead of never
  // polling. (NotchHost unmounts on island-close, so this interval stops when the island closes — no background polling.)
  useEffect(() => {
    void poll()
    const t = window.setInterval(() => void poll(), 3000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    scrollDown()
  }, [messages.length, pending.length])

  // Fire-and-forget enqueue. The SYNCHRONOUS part runs the instant the user hits send: echo the message optimistically
  // (with its attachment cards) and CLEAR the composer immediately, so a multi-MB transcript upload never leaves a
  // "ghost" attachment lingering. The network send is chained onto a queue so rapid messages go in order and are NEVER
  // dropped (the old in-flight guard silently swallowed anything typed while a big upload was still running).
  const send = (text: string): void => {
    const atts = [...attachedRef.current] // [id, label][] snapshot of queued sessions
    if (!text.trim() && atts.length === 0) return // nothing to send (e.g. a double-click after the input cleared)
    setError('')
    const localId = `local-${seqRef.current++}`
    const optAtts: Att[] = atts.map(([sid, label]) => ({ id: `opt-${sid}`, label, bytes: 0 }))
    setPending((prev) => [...prev, { id: localId, sender: 'user', body: text, attachments: optAtts }])
    clearAttach() // free the composer NOW — the cards ride the optimistic bubble; no lingering ghost attachment
    queueRef.current = queueRef.current.catch(() => {}).then(() => doSend(text, atts, localId))
  }

  // The network half of a send, run one-at-a-time off the queue. Uploads each attached transcript, posts the message,
  // self-heals a stale handle (404 -> recreate + retry once), then reconciles the optimistic copy by server id.
  const doSend = async (text: string, atts: Array<[string, string]>, localId: string): Promise<void> => {
    // One send attempt against the current (or a freshly created) conversation. Returns the /chat/send response and
    // the labels that couldn't be attached. Factored out so a stale handle (404) can recreate + retry exactly once.
    const attempt = async (): Promise<{ res: Response; skipped: string[] }> => {
      let h = handleRef.current
      if (!h) {
        const sr = await fetch(`${SUPPORT_API_BASE}/chat/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: subjectRef.current }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        })
        const sj = (await sr.json()) as { conversationId?: string; secret?: string }
        if (!sr.ok || !sj.conversationId || !sj.secret) throw new Error('start failed')
        h = { conversationId: sj.conversationId, secret: sj.secret }
        handleRef.current = h
        saveHandle(h)
      }
      // Upload each attached session's FULL transcript (gzipped, fetched from main) before sending the message.
      // Skipped sessions (no transcript yet, or too large to upload) are collected and surfaced AFTER the send so
      // the message still goes through. A transcript already uploaded on a prior attempt is reused by id.
      const attachmentIds: string[] = []
      const skipped: string[] = []
      if (atts.length) {
        const w = window as unknown as { agentOS?: { agentTranscript?: (id: string) => Promise<{ gzipB64: string; bytes: number; tooLarge?: boolean } | null> } }
        for (const [id, label] of atts) {
          const prior = uploadedRef.current.get(id)
          if (prior) {
            attachmentIds.push(prior) // already uploaded this session in an earlier attempt — don't re-POST the bytes
            continue
          }
          try {
            const t = await w.agentOS?.agentTranscript?.(id)
            if (!t || t.tooLarge || !t.gzipB64) {
              skipped.push(t?.tooLarge ? `${label} (too large)` : label) // codex / no-turn-yet, or over the upload cap
              continue
            }
            const ar = await fetch(`${SUPPORT_API_BASE}/chat/attach`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conversationId: h.conversationId, secret: h.secret, label, gzipB64: t.gzipB64, bytes: t.bytes }),
              signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
            })
            const aj = (await ar.json()) as { attachmentId?: string }
            if (ar.ok && aj.attachmentId) {
              attachmentIds.push(aj.attachmentId)
              uploadedRef.current.set(id, aj.attachmentId) // remember it so a retry doesn't re-upload
            } else {
              skipped.push(label)
            }
          } catch {
            skipped.push(label) // this one failed; the rest still go
          }
        }
      }
      const res = await fetch(`${SUPPORT_API_BASE}/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: h.conversationId, secret: h.secret, body: text, attachmentIds }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      return { res, skipped }
    }

    try {
      let { res, skipped } = await attempt()
      if (res.status === 404) {
        // The handle was stale (deleted conversation, or a different backend than last run) — recreate + retry once.
        dropHandle()
        ;({ res, skipped } = await attempt())
      }
      if (!res.ok) throw new Error('send failed')
      // Stamp the server id onto the optimistic message so the next poll reconciles it out exactly (no content guessing).
      const sj = (await res.json().catch(() => ({}))) as { messageId?: string }
      if (sj.messageId) {
        setPending((prev) => prev.map((p) => (p.id === localId ? { ...p, serverId: sj.messageId } : p)))
      } else {
        // 2xx but no id to reconcile by (malformed body / older backend): drop the optimistic copy so it can't linger
        // as a permanent duplicate of the row the next poll will render from server truth.
        setPending((prev) => prev.filter((p) => p.id !== localId))
      }
      uploadedRef.current.clear() // these attachments rode the message — a fresh attach starts clean
      if (skipped.length) setError('Not attached (no transcript yet or too large): ' + skipped.join(', '))
      await poll()
    } catch {
      // The send didn't land. KEEP the optimistic bubble but mark it failed, so the user's text isn't silently lost
      // (ChatInput already cleared the composer, so removing it would erase the message). The bubble shows "Not sent";
      // re-sending the text starts a fresh attempt. A failed copy carries no serverId, so poll() never reconciles it.
      setPending((prev) => prev.map((p) => (p.id === localId ? { ...p, failed: true } : p)))
      setError('Could not reach support. Check your connection and try again.')
    }
  }

  // Server truth + still-pending optimistic messages, in order (pending are always the newest, appended last).
  const view = pending.length ? [...messages, ...pending] : messages
  return (
    <div className="nh-island isl-support" style={{ paddingTop: top }}>
      <div className="isl-support-head">
        <span className="isl-chip-album" style={{ background: SUPPORT_GRADIENT }} aria-hidden />
        <span className="isl-support-titles">
          <span className="isl-support-title">BlitzOS Support</span>
          <span className="isl-support-sub">We usually reply within a few hours</span>
        </span>
        <button type="button" className="isl-settings-close" onClick={onClose} title="Close" aria-label="Close support">
          <svg viewBox="0 0 24 24" aria-hidden focusable="false">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
      <div className="isl-feed" ref={feedRef}>
        {view.length === 0 ? (
          <div className="isl-support-greeting">{GREETING}</div>
        ) : (
          view.map((m, i) => (
            <Fragment key={m.id || i}>
              {m.attachments && m.attachments.length > 0 && (
                <div className={`isl-support-msg-cards ${m.sender === 'user' ? 'out' : 'in'}`}>
                  {m.attachments.map((a) => (
                    <div className="isl-support-msg-card" key={a.id} title={a.label}>
                      <span className="isl-support-card-icon" aria-hidden>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                          <path d="M6 3.5h7l5 5v12H6z" />
                          <path d="M13 3.5v5h5" />
                        </svg>
                      </span>
                      <span className="isl-support-card-label">{a.label}</span>
                    </div>
                  ))}
                </div>
              )}
              <MarkdownMessage role={m.sender === 'user' ? 'user' : 'agent'} text={m.body} showDivider={m.sender === 'agent' && i > 0} />
              {(m as { failed?: boolean }).failed && <div className="isl-support-failed">Not sent. Check your connection and resend.</div>}
            </Fragment>
          ))
        )}
      </div>
      {error ? <div className="isl-support-error">{error}</div> : null}
      <div className="isl-support-foot">
        {attached.size > 0 && (
          <>
            <div className="isl-support-consent">Sharing a session sends its full transcript, which may include file contents and secrets.</div>
            <div className="isl-support-cards">
            {[...attached].map(([id, label]) => (
              <div className="isl-support-card" key={id} title={label}>
                <span className="isl-support-card-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                    <path d="M6 3.5h7l5 5v12H6z" />
                    <path d="M13 3.5v5h5" />
                  </svg>
                </span>
                <span className="isl-support-card-label">{label}</span>
                <button type="button" className="isl-support-card-x" onClick={() => removeAttached(id)} aria-label="Remove attachment" title="Remove">
                  ×
                </button>
              </div>
            ))}
            </div>
          </>
        )}
        <div className="isl-composer">
          <button
            type="button"
            className="isl-support-attach"
            title="Attach a chat session"
            aria-label="Attach a chat session"
            onClick={() => {
              enterAttach()
              onClose() // onClose drops to the agent session view, where attach mode shows the checkboxes
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
              <path d="M21 11.3l-8.7 8.7a5 5 0 0 1-7.1-7.1l8.7-8.7a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.6 1.6 0 0 1-2.3-2.3l7.8-7.8" />
            </svg>
            <span className="isl-support-attach-label">attach chat</span>
          </button>
          <ChatInput
            className="isl-bar"
            placeholder={attached.size > 0 ? 'Add a note, then send to attach' : 'Message BlitzOS Support'}
            draftKey="support"
            sendLabel="↑"
            onSend={(t) => void send(t)}
            autoFocus
          />
        </div>
      </div>
    </div>
  )
}

export default IslandSupport
