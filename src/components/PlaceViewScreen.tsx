import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAgent } from 'agents/react'
import {
  AlertCircle,
  ArrowLeft,
  BellRing,
  Check,
  LocateFixed,
  MapPin,
  MessageCircle,
  Send,
  Users,
  X,
} from 'lucide-react'
import { authClient } from '../lib/auth-client'
import type {
  ActiveConnectionState,
  ActiveConnectionThread,
  AppSession,
  ConnectRequestMessage,
  CurrentPlaceState,
  IncomingConnectRequest,
  PlaceAgentState,
  UserProfileState,
} from '../lib/app-types'
import type { PlaceAgent } from '../lib/server/agents/place-agent'

const MAX_MESSAGES_PER_USER = 3

type AuthResult = {
  error?: {
    message?: string | null
  } | null
}

type PlaceViewClientLike = {
  signOut: () => Promise<AuthResult>
}

type ConversationNoticeState = {
  title: string
  description: string
}

type MotionAccessState =
  | 'unavailable'
  | 'needs-permission'
  | 'requesting'
  | 'active'
  | 'denied'

type MotionPermissionResponse = 'granted' | 'denied'

type DeviceMotionEventWithPermission = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<MotionPermissionResponse>
}

const FACE_DOWN_HORIZONTAL_THRESHOLD = 4
const FACE_DOWN_Z_THRESHOLD = -7
const FACE_DOWN_HOLD_MS = 1200
const MOTION_ARM_DELAY_MS = 1500

const finderHintOptions = [
  'Front tables',
  'Counter',
  'Window seats',
  'Patio',
  'Back corner',
] as const

function getInitialMotionAccessState(): MotionAccessState {
  if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) {
    return 'unavailable'
  }

  const motionEvent = window.DeviceMotionEvent as
    | DeviceMotionEventWithPermission
    | undefined

  if (!motionEvent) {
    return 'unavailable'
  }

  return typeof motionEvent.requestPermission === 'function'
    ? 'needs-permission'
    : 'active'
}

function isFaceDownReading(
  acceleration: DeviceMotionEvent['accelerationIncludingGravity'] | null,
) {
  if (!acceleration) return false
  const { x, y, z } = acceleration
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    return false
  }
  return (
    Math.abs(x) <= FACE_DOWN_HORIZONTAL_THRESHOLD &&
    Math.abs(y) <= FACE_DOWN_HORIZONTAL_THRESHOLD &&
    z <= FACE_DOWN_Z_THRESHOLD
  )
}

async function playFinderCue() {
  if (typeof window !== 'undefined') {
    const AudioContextCtor =
      window.AudioContext ||
      ('webkitAudioContext' in window
        ? ((window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext ?? null)
        : null)

    if (AudioContextCtor) {
      try {
        const audioContext = new AudioContextCtor()
        const oscillator = audioContext.createOscillator()
        const gain = audioContext.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime)
        oscillator.frequency.exponentialRampToValueAtTime(1320, audioContext.currentTime + 0.18)
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.06, audioContext.currentTime + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.28)
        oscillator.connect(gain)
        gain.connect(audioContext.destination)
        oscillator.start()
        oscillator.stop(audioContext.currentTime + 0.3)
        window.setTimeout(() => void audioContext.close().catch(() => undefined), 450)
      } catch {
        // Ignore blocked audio contexts.
      }
    }
  }

  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate?.([120, 80, 140])
  }
}

export function PlaceViewScreen({
  session,
  profile,
  currentPlace,
  activeConnection,
  activeConnectionThread,
  pendingIncomingRequests,
  refreshSession,
  setReady,
  saveFinderProfile,
  leavePlace,
  pingParticipant,
  sendConnectRequest,
  addRequestMessage,
  respondToRequest,
  endConversation,
  client = authClient,
}: {
  session: AppSession
  profile: UserProfileState
  currentPlace: CurrentPlaceState
  activeConnection: ActiveConnectionState | null
  activeConnectionThread: ActiveConnectionThread | null
  pendingIncomingRequests: IncomingConnectRequest[]
  refreshSession: () => Promise<void>
  setReady: (input: { data: { ready: boolean } }) => Promise<void>
  saveFinderProfile: (input: {
    data: { isFindable: boolean; locationHint: string | null }
  }) => Promise<UserProfileState>
  leavePlace: () => Promise<void>
  pingParticipant: (input: { data: { userId: string } }) => Promise<unknown>
  sendConnectRequest: (input: {
    data: { recipientUserId: string; introMessage: string }
  }) => Promise<unknown>
  addRequestMessage: (input: {
    data: { requestId: string; body: string }
  }) => Promise<unknown>
  respondToRequest: (input: {
    data: { requestId: string; accept: boolean }
  }) => Promise<unknown>
  endConversation: () => Promise<unknown>
  client?: PlaceViewClientLike
}) {
  const [pendingAction, setPendingAction] = useState<
    | 'ready'
    | 'finder'
    | 'leave'
    | 'sign-out'
    | 'connect'
    | 'respond'
    | 'end-connection'
    | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [finderNotice, setFinderNotice] = useState<ConversationNoticeState | null>(null)
  const [livePlaceState, setLivePlaceState] = useState<PlaceAgentState | null>(null)
  const [conversationNotice, setConversationNotice] = useState<ConversationNoticeState | null>(null)
  const [conversationNow, setConversationNow] = useState(() => Date.now())
  const [pendingPingUserId, setPendingPingUserId] = useState<string | null>(null)
  const [selectedFinderHint, setSelectedFinderHint] = useState(
    profile.locationHint ?? finderHintOptions[0],
  )
  const [motionAccessState, setMotionAccessState] = useState<MotionAccessState>(
    () => getInitialMotionAccessState(),
  )
  const [motionNotice, setMotionNotice] = useState<string | null>(null)

  // Connect request send state
  const [connectModalTarget, setConnectModalTarget] = useState<{
    userId: string
    username: string
    moodEmoji: string | null
    intentSummary: string | null
  } | null>(null)
  const [introMessage, setIntroMessage] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Incoming request reply state (keyed by requestId)
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [pendingReplyRequestId, setPendingReplyRequestId] = useState<string | null>(null)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)

  // Active connection (post-acceptance) chat state
  const [activeConnectionDraft, setActiveConnectionDraft] = useState('')
  const [isSendingActiveMessage, setIsSendingActiveMessage] = useState(false)
  const [activeMessageError, setActiveMessageError] = useState<string | null>(null)

  const readyRequestInFlightRef = useRef(false)
  const motionArmedRef = useRef(false)
  const motionIgnoreUntilRef = useRef(0)
  const faceDownSinceRef = useRef<number | null>(null)
  const previousConnectionRef = useRef<ActiveConnectionState | null>(activeConnection)
  const previousPingRef = useRef<string | null>(profile.pingRequestedAt?.toString() ?? null)

  const placeAgent = useAgent<PlaceAgent, PlaceAgentState>({
    agent: 'place-agent',
    name: currentPlace.place.placeId,
    onStateUpdate: (nextState) => {
      setLivePlaceState(nextState)
    },
  })
  void placeAgent

  const username =
    session.user.displayUsername || session.user.username || session.user.name
  const liveParticipant =
    livePlaceState?.participants?.find((p) => p.userId === session.user.id) ?? null
  const liveConnection =
    livePlaceState?.connections?.find(
      (c) =>
        c.requesterUserId === session.user.id ||
        c.recipientUserId === session.user.id,
    ) ?? null
  const counterpartParticipant =
    liveConnection && livePlaceState
      ? livePlaceState.participants.find(
          (p) =>
            p.userId !== session.user.id &&
            (p.userId === liveConnection.requesterUserId ||
              p.userId === liveConnection.recipientUserId),
        ) ?? null
      : null
  // Trust the DB-backed profile status when it says in_conversation — the
  // PlaceAgent WebSocket can lag a few hundred ms after acceptance, causing the
  // old "ready" value to briefly win. The DB is authoritative.
  const liveStatus =
    profile.status === 'in_conversation'
      ? 'in_conversation'
      : (liveParticipant?.status ?? profile.status)
  const isFindable = liveParticipant?.isFindable ?? profile.isFindable
  const locationHint = liveParticipant?.locationHint ?? profile.locationHint
  const activePingRequestedAt =
    liveParticipant?.pingRequestedAt ?? profile.pingRequestedAt
  const activePingRequestedByUsername =
    liveParticipant?.pingRequestedByUsername ?? profile.pingRequestedByUsername
  const resolvedActiveConnection =
    liveParticipant && livePlaceState
      ? liveConnection && counterpartParticipant
        ? {
            id: liveConnection.id,
            placeId: currentPlace.place.placeId,
            createdAt: liveConnection.createdAt,
            counterpart: {
              userId: counterpartParticipant.userId,
              username: counterpartParticipant.username,
              moodEmoji: counterpartParticipant.moodEmoji,
              intentSummary: counterpartParticipant.intentSummary,
            },
          }
        : null
      : activeConnection
  const isReady = liveStatus === 'ready'
  const isInConversation = liveStatus === 'in_conversation'
  const liveParticipants =
    livePlaceState?.placeId === currentPlace.place.placeId
      ? livePlaceState.participants
      : []
  const readyParticipants = [...liveParticipants]
    .filter((p) => p.status === 'ready')
    .sort((a, b) => {
      if (a.userId === session.user.id) return -1
      if (b.userId === session.user.id) return 1
      return a.username.localeCompare(b.username)
    })
  const checkedInCount =
    livePlaceState?.placeId === currentPlace.place.placeId
      ? livePlaceState.checkedInCount
      : Math.max(currentPlace.readyCount, readyParticipants.length)
  const conversationElapsed =
    resolvedActiveConnection !== null
      ? formatConversationElapsed(resolvedActiveConnection.createdAt, conversationNow)
      : null

  useEffect(() => {
    setLivePlaceState(null)
  }, [currentPlace.place.placeId])

  useEffect(() => {
    setMotionAccessState(getInitialMotionAccessState())
  }, [])

  useEffect(() => {
    if (resolvedActiveConnection) {
      previousConnectionRef.current = resolvedActiveConnection
      setConversationNotice(null)
      return
    }
    const previousConnection = previousConnectionRef.current
    if (!previousConnection) return
    previousConnectionRef.current = null
    setConversationNotice({
      title: 'Conversation ended',
      description:
        liveStatus === 'ready'
          ? `You and ${previousConnection.counterpart.username} are back in the ready pool.`
          : `You and ${previousConnection.counterpart.username} are no longer connected. Set yourself ready again whenever you want.`,
    })
  }, [liveStatus, resolvedActiveConnection])

  useEffect(() => {
    if (!conversationNotice) return
    const id = window.setTimeout(() => setConversationNotice(null), 5000)
    return () => window.clearTimeout(id)
  }, [conversationNotice])

  useEffect(() => {
    if (!finderNotice) return
    const id = window.setTimeout(() => setFinderNotice(null), 5000)
    return () => window.clearTimeout(id)
  }, [finderNotice])

  useEffect(() => {
    if (!motionNotice) return
    const id = window.setTimeout(() => setMotionNotice(null), 4000)
    return () => window.clearTimeout(id)
  }, [motionNotice])

  useEffect(() => {
    if (!resolvedActiveConnection) return
    setConversationNow(Date.now())
    const id = window.setInterval(() => setConversationNow(Date.now()), 30000)
    return () => window.clearInterval(id)
  }, [resolvedActiveConnection?.id])

  useEffect(() => {
    if (locationHint) setSelectedFinderHint(locationHint)
  }, [locationHint])

  // Auto-poll for session updates at all times:
  // - While ready/present: keeps incoming request cards and thread messages live.
  // - While in_conversation: keeps the active-connection chat thread live so
  //   both users see each other's new messages without a manual refresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshSession()
    }, isInConversation ? 5000 : 6000)
    return () => window.clearInterval(id)
  }, [isInConversation])

  useEffect(() => {
    const nextPingValue = activePingRequestedAt?.toString() ?? null
    if (!nextPingValue || previousPingRef.current === nextPingValue) return
    previousPingRef.current = nextPingValue
    const pingTimestamp = new Date(nextPingValue).getTime()
    if (!Number.isFinite(pingTimestamp) || Date.now() - pingTimestamp > 15000) return
    setFinderNotice({
      title: 'Someone is trying to find you',
      description: activePingRequestedByUsername
        ? `${activePingRequestedByUsername} is looking for you. Head over when you're ready.`
        : 'Someone nearby is looking for you.',
    })
    void playFinderCue()
  }, [activePingRequestedAt, activePingRequestedByUsername])

  const updateReadyState = async (
    nextReady: boolean,
    source: 'manual' | 'face-down' = 'manual',
  ) => {
    if (readyRequestInFlightRef.current || nextReady === isReady) return
    readyRequestInFlightRef.current = true
    setPendingAction('ready')
    setError(null)
    try {
      await setReady({ data: { ready: nextReady } })
      await refreshSession()
      if (source === 'face-down') {
        setMotionNotice('Phone turned face-down. You are no longer marked ready.')
      }
    } catch (nextError) {
      setMotionNotice(null)
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to change your status right now.',
      )
    } finally {
      readyRequestInFlightRef.current = false
      motionArmedRef.current = false
      motionIgnoreUntilRef.current = nextReady ? Date.now() + MOTION_ARM_DELAY_MS : 0
      faceDownSinceRef.current = null
      setPendingAction(null)
    }
  }

  const handleDeviceMotion = useEffectEvent((event: DeviceMotionEvent) => {
    if (!isReady || isInConversation || readyRequestInFlightRef.current) {
      motionArmedRef.current = false
      faceDownSinceRef.current = null
      return
    }
    const now = Date.now()
    const isFaceDown = isFaceDownReading(event.accelerationIncludingGravity)
    if (now < motionIgnoreUntilRef.current) {
      faceDownSinceRef.current = null
      return
    }
    if (!motionArmedRef.current) {
      if (!isFaceDown) motionArmedRef.current = true
      faceDownSinceRef.current = null
      return
    }
    if (!isFaceDown) {
      faceDownSinceRef.current = null
      return
    }
    if (faceDownSinceRef.current === null) {
      faceDownSinceRef.current = now
      return
    }
    if (now - faceDownSinceRef.current < FACE_DOWN_HOLD_MS) return
    faceDownSinceRef.current = null
    void updateReadyState(false, 'face-down')
  })

  useEffect(() => {
    if (!isReady || isInConversation || motionAccessState !== 'active' || typeof window === 'undefined') {
      motionArmedRef.current = false
      motionIgnoreUntilRef.current = 0
      faceDownSinceRef.current = null
      return
    }
    motionArmedRef.current = false
    motionIgnoreUntilRef.current = Date.now() + MOTION_ARM_DELAY_MS
    faceDownSinceRef.current = null
    window.addEventListener('devicemotion', handleDeviceMotion)
    return () => window.removeEventListener('devicemotion', handleDeviceMotion)
  }, [isReady, isInConversation, motionAccessState])

  const handleReadyToggle = async () => {
    await updateReadyState(!isReady)
  }

  const handleLeavePlace = async () => {
    setPendingAction('leave')
    setError(null)
    try {
      await leavePlace()
      await refreshSession()
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : 'Unable to switch places right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  const saveFinderState = async (nextIsFindable: boolean, nextLocationHint: string) => {
    setPendingAction('finder')
    setError(null)
    try {
      await saveFinderProfile({ data: { isFindable: nextIsFindable, locationHint: nextLocationHint } })
      await refreshSession()
      setFinderNotice({
        title: nextIsFindable ? 'Finder mode is on' : 'Finder mode is off',
        description: nextIsFindable
          ? `People nearby can look for you around ${nextLocationHint}.`
          : 'You are no longer sharing a spot in this place.',
      })
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to update your finder settings right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  const handleFinderToggle = async () => {
    await saveFinderState(!isFindable, selectedFinderHint)
  }

  const handleSelectFinderHint = async (nextHint: string) => {
    setSelectedFinderHint(nextHint)
    if (!isFindable) return
    await saveFinderState(true, nextHint)
  }

  const handleSignOut = async () => {
    setPendingAction('sign-out')
    setError(null)
    const result = await client.signOut()
    if (result.error) {
      setError(result.error.message || 'Unable to sign out right now.')
      setPendingAction(null)
      return
    }
    await refreshSession()
    setPendingAction(null)
  }

  const handleEndConnection = async () => {
    setPendingAction('end-connection')
    setError(null)
    try {
      await endConversation()
      await refreshSession()
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to end that connection right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  const handlePingParticipant = async (
    participant: PlaceAgentState['participants'][number],
  ) => {
    setPendingPingUserId(participant.userId)
    setError(null)
    try {
      await pingParticipant({ data: { userId: participant.userId } })
      setFinderNotice({
        title: 'Ping sent',
        description: `A quick cue was sent to ${participant.username} near ${participant.locationHint || 'their shared spot'}.`,
      })
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : 'Unable to send that ping right now.',
      )
    } finally {
      setPendingPingUserId(null)
    }
  }

  const handleEnableMotionAccess = async () => {
    if (typeof window === 'undefined') return
    const motionEvent = window.DeviceMotionEvent as DeviceMotionEventWithPermission | undefined
    if (!motionEvent) {
      setMotionAccessState('unavailable')
      return
    }
    if (!motionEvent.requestPermission) {
      setMotionAccessState('active')
      motionArmedRef.current = false
      motionIgnoreUntilRef.current = Date.now() + MOTION_ARM_DELAY_MS
      return
    }
    setMotionAccessState('requesting')
    try {
      const permission = await motionEvent.requestPermission()
      if (permission === 'granted') {
        setMotionAccessState('active')
        motionArmedRef.current = false
        motionIgnoreUntilRef.current = Date.now() + MOTION_ARM_DELAY_MS
        setMotionNotice('Flip your phone face-down to leave the ready pool.')
        return
      }
      setMotionAccessState('denied')
    } catch {
      setMotionAccessState('denied')
    }
  }

  // Active connection (post-acceptance) chat handler
  const handleSendActiveConnectionMessage = async () => {
    if (!activeConnectionThread) return
    const body = activeConnectionDraft.trim()
    if (!body) return
    setIsSendingActiveMessage(true)
    setActiveMessageError(null)
    try {
      await addRequestMessage({ data: { requestId: activeConnectionThread.requestId, body } })
      setActiveConnectionDraft('')
      await refreshSession()
    } catch (nextError) {
      setActiveMessageError(
        nextError instanceof Error ? nextError.message : 'Unable to send that message right now.',
      )
    } finally {
      setIsSendingActiveMessage(false)
    }
  }

  // Connect request send handlers
  const handleOpenConnectModal = (participant: PlaceAgentState['participants'][number]) => {
    setConnectModalTarget({
      userId: participant.userId,
      username: participant.username,
      moodEmoji: participant.moodEmoji,
      intentSummary: participant.intentSummary,
    })
    setIntroMessage('')
    setConnectError(null)
  }

  const handleCloseConnectModal = () => {
    setConnectModalTarget(null)
    setIntroMessage('')
    setConnectError(null)
  }

  const handleSendConnectRequest = async () => {
    if (!connectModalTarget) return
    setPendingAction('connect')
    setConnectError(null)
    try {
      await sendConnectRequest({
        data: {
          recipientUserId: connectModalTarget.userId,
          introMessage,
        },
      })
      handleCloseConnectModal()
      await refreshSession()
    } catch (nextError) {
      setConnectError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to send that request right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  // Incoming request reply handlers
  const handleSendReply = async (requestId: string) => {
    const body = (replyDrafts[requestId] ?? '').trim()
    if (!body) return
    setPendingReplyRequestId(requestId)
    setReplyError(null)
    try {
      await addRequestMessage({ data: { requestId, body } })
      setReplyDrafts((prev) => ({ ...prev, [requestId]: '' }))
      await refreshSession()
    } catch (nextError) {
      setReplyError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to send that message right now.',
      )
    } finally {
      setPendingReplyRequestId(null)
    }
  }

  const handleRespondToRequest = async (requestId: string, accept: boolean) => {
    setRespondingRequestId(requestId)
    setPendingAction('respond')
    setError(null)
    try {
      await respondToRequest({ data: { requestId, accept } })
      if (accept) {
        setConversationNotice({
          title: "You're talking now.",
          description: 'Meet in person when ready.',
        })
      }
      // refreshSession re-fetches getAppState which now includes activeConnectionThread,
      // so the chat panel appears immediately with the full pre-acceptance thread.
      await refreshSession()
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to respond to that request right now.',
      )
    } finally {
      setRespondingRequestId(null)
      setPendingAction(null)
    }
  }

  return (
    <main className="min-h-screen bg-[var(--rt-bg)] pb-24">
      <div className="mx-auto flex w-full max-w-xl flex-col">

        {/* ── Top header ── */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-[var(--rt-border)] bg-[var(--rt-bg)]/90 px-4 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={handleLeavePlace}
            disabled={pendingAction === 'leave'}
            className="flex items-center gap-2 rounded-full p-1.5 text-[var(--rt-ink-soft)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.95] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--rt-ink)] disabled:opacity-50"
            aria-label="Back to places"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="text-center">
            <p className="text-sm font-black tracking-[-0.03em] text-[var(--rt-ink)]">
              {currentPlace.place.name}
            </p>
            <p className="text-xs text-[var(--rt-ink-faint)]">{currentPlace.place.address}</p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={pendingAction === 'sign-out'}
            className="rounded-full border border-[var(--rt-border)] bg-[var(--rt-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--rt-ink-soft)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--rt-ink)] disabled:opacity-60"
          >
            {pendingAction === 'sign-out' ? '...' : 'Sign out'}
          </button>
        </header>

        <div className="flex flex-col gap-4 px-4 pt-4">
        {/* ── Status toggles — 2-col grid ── */}
        <section className="grid grid-cols-2 gap-3">
          {/* Ready toggle */}
          <div className={`rounded-2xl border p-4 transition-[border-color,background-color] duration-200 ${isReady ? 'border-[var(--rt-accent)] bg-[var(--rt-accent-soft)]' : 'border-[var(--rt-border)] bg-[var(--rt-surface)]'}`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-faint)]">Status</p>
            <p className={`mt-1 text-sm font-bold ${isReady ? 'text-[var(--rt-accent)]' : 'text-[var(--rt-ink)]'}`}>
              {isInConversation ? 'Talking' : isReady ? 'Ready to Talk' : 'Not Ready'}
            </p>
            <label className="mt-3 flex cursor-pointer items-center">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={isInConversation ? true : isReady}
                  disabled={isInConversation || pendingAction === 'ready'}
                  onChange={() => void handleReadyToggle()}
                />
                <div className={`h-6 w-11 rounded-full transition-colors duration-200 ${(isReady || isInConversation) ? 'bg-[var(--rt-accent)]' : 'bg-[var(--rt-border)]'}`} />
                <div className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${(isReady || isInConversation) ? 'translate-x-5' : 'translate-x-0'}`} />
              </div>
            </label>
          </div>

          {/* Finder toggle */}
          <div className={`rounded-2xl border p-4 transition-[border-color,background-color] duration-200 ${isFindable ? 'border-[var(--rt-accent)] bg-[var(--rt-accent-soft)]' : 'border-[var(--rt-border)] bg-[var(--rt-surface)]'}`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-faint)]">Visibility</p>
            <p className={`mt-1 text-sm font-bold ${isFindable ? 'text-[var(--rt-accent)]' : 'text-[var(--rt-ink)]'}`}>
              {isFindable ? 'Findable' : 'Finder Mode'}
            </p>
            <label className="mt-3 flex cursor-pointer items-center">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={isFindable}
                  disabled={!isReady || isInConversation || pendingAction === 'finder'}
                  onChange={() => void handleFinderToggle()}
                />
                <div className={`h-6 w-11 rounded-full transition-colors duration-200 ${isFindable ? 'bg-[var(--rt-accent)]' : 'bg-[var(--rt-border)]'}`} />
                <div className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${isFindable ? 'translate-x-5' : 'translate-x-0'}`} />
              </div>
            </label>
          </div>
        </section>

        {/* ── Conversation notice ── */}
        {conversationNotice ? (
          <div className="rt-conversation-notice flex items-start gap-3 rounded-2xl border p-4">
            <Check className="mt-0.5 h-4 w-4 shrink-0 opacity-90" />
            <div>
              <p className="text-sm font-semibold">{conversationNotice.title}</p>
              <p className="mt-0.5 text-sm leading-5 opacity-90">{conversationNotice.description}</p>
            </div>
          </div>
        ) : null}

        {/* ── Finder hint chips ── */}
        {isReady && !isInConversation ? (
          <div className="rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface)] p-4">
            <div className="flex items-center gap-2">
              <LocateFixed className="h-4 w-4 text-[var(--rt-accent)]" />
              <p className="text-sm font-semibold text-[var(--rt-ink)]">Where are you sitting?</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {finderHintOptions.map((hint) => {
                const isSelected = selectedFinderHint === hint
                return (
                  <button
                    key={hint}
                    type="button"
                    onClick={() => void handleSelectFinderHint(hint)}
                    disabled={pendingAction === 'finder'}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.96] ${
                      isSelected
                        ? 'bg-[var(--rt-accent)] text-white'
                        : 'border border-[var(--rt-border)] bg-white text-[var(--rt-ink-soft)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)]'
                    } disabled:opacity-60`}
                  >
                    {hint}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* ── Incoming connect requests ── */}
        {pendingIncomingRequests.length > 0 ? (
          <div className="rt-notice rounded-2xl border border-[var(--rt-accent)] bg-[var(--rt-accent-soft)] p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl border border-[var(--rt-accent)] bg-white p-2 text-[var(--rt-accent)]">
                <MessageCircle className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--rt-ink)]">
                  {pendingIncomingRequests.length === 1 ? '1 request to talk' : `${pendingIncomingRequests.length} requests to talk`}
                </p>
                <p className="text-xs text-[var(--rt-ink-soft)]">Accept or decline below</p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {pendingIncomingRequests.map((req) => (
                <IncomingRequestCard
                  key={req.id}
                  request={req}
                  currentUserId={session.user.id}
                  isResponding={respondingRequestId === req.id}
                  isSendingReply={pendingReplyRequestId === req.id}
                  replyDraft={replyDrafts[req.id] ?? ''}
                  replyError={replyError}
                  onReplyDraftChange={(val) => setReplyDrafts((prev) => ({ ...prev, [req.id]: val }))}
                  onSendReply={() => void handleSendReply(req.id)}
                  onAccept={() => void handleRespondToRequest(req.id, true)}
                  onReject={() => void handleRespondToRequest(req.id, false)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* ── Active conversation panel ── */}

          {/* Incoming connect requests */}
          {pendingIncomingRequests.length > 0 ? (
            <div className="rt-notice mt-6 rounded-[2rem] border border-[var(--rt-accent)] bg-[var(--rt-accent-soft)] p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl border border-[var(--rt-accent)] bg-white p-3 text-[var(--rt-accent)]">
                  <MessageCircle className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--rt-ink)]">
                    {pendingIncomingRequests.length === 1
                      ? '1 request to talk'
                      : `${pendingIncomingRequests.length} requests to talk`}
                  </p>
                  <p className="text-sm leading-6 text-[var(--rt-ink-soft)]">
                    Someone nearby wants to meet you. Accept or decline below.
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-4">
                {pendingIncomingRequests.map((req) => (
                  <IncomingRequestCard
                    key={req.id}
                    request={req}
                    currentUserId={session.user.id}
                    isResponding={respondingRequestId === req.id}
                    isSendingReply={pendingReplyRequestId === req.id}
                    replyDraft={replyDrafts[req.id] ?? ''}
                    replyError={replyError}
                    onReplyDraftChange={(val) =>
                      setReplyDrafts((prev) => ({ ...prev, [req.id]: val }))
                    }
                    onSendReply={() => void handleSendReply(req.id)}
                    onAccept={() => void handleRespondToRequest(req.id, true)}
                    onReject={() => void handleRespondToRequest(req.id, false)}
                  />
                ))}
              </div>
            </div>
          ) : null}

        {/* ── Happening Now — presence list ── */}
        <section className="rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface)] p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-black tracking-[-0.03em] text-[var(--rt-ink)]">Happening Now</h2>
            <span className="rounded-full bg-[var(--rt-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--rt-accent)]">
              {checkedInCount} Active
            </span>
          </div>

          {readyParticipants.length > 0 ? (
            <div className="mt-3 space-y-3">
              {readyParticipants.map((participant, index) => (
                <PresencePersonCard
                  key={participant.userId}
                  participant={participant}
                  isCurrentUser={participant.userId === session.user.id}
                  isInConversation={isInConversation}
                  staggerIndex={index}
                  onConnect={
                    participant.userId === session.user.id || isInConversation
                      ? null
                      : () => handleOpenConnectModal(participant)
                  }
                  onPing={
                    participant.userId === session.user.id || !participant.isFindable
                      ? null
                      : () => void handlePingParticipant(participant)
                  }
                  isPinging={pendingPingUserId === participant.userId}
                />
              ))}
            </div>
          ) : (
            <div className="rt-card-stagger mt-3 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-8 text-center">
              <Users className="h-5 w-5 text-[var(--rt-border-strong)]" />
              <p className="text-sm font-medium text-[var(--rt-ink-soft)]">No one is ready here yet.</p>
              <p className="text-xs text-[var(--rt-ink-faint)]">Toggle Ready above to be the first.</p>
            </div>
          )}
        </section>

        {/* ── Active conversation ── */}
        {resolvedActiveConnection ? (
          <div className="rt-connection-accepted rounded-2xl border border-[var(--rt-accent)] bg-[var(--rt-accent-soft)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[var(--rt-accent)]">
                <MessageCircle className="h-4 w-4" />
                <p className="text-xs font-semibold uppercase tracking-[0.14em]">You are talking now</p>
              </div>
              {conversationElapsed ? (
                <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold text-[var(--rt-accent)]">
                  {conversationElapsed}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-lg font-black tracking-[-0.03em] text-[var(--rt-ink)]">
              {resolvedActiveConnection.counterpart.username}
            </p>
            <p className="mt-0.5 text-sm text-[var(--rt-ink-soft)]">
              {resolvedActiveConnection.counterpart.moodEmoji}{' '}
              {resolvedActiveConnection.counterpart.intentSummary}
            </p>

            {/* Live chat thread */}
            <div className="mt-3 rounded-xl border border-[var(--rt-border)] bg-white p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-faint)]">Chat</p>
              {activeConnectionThread ? (
                <>
                  {activeConnectionThread.introMessage ? (
                    <div className="mb-2 flex justify-start">
                      <div className="max-w-[85%] rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-3 py-2 text-sm text-[var(--rt-ink)]">
                        {activeConnectionThread.introMessage}
                      </div>
                    </div>
                  ) : null}
                  {activeConnectionThread.messages.map((msg) => (
                    <div key={msg.id} className={`mb-2 flex ${msg.senderUserId === session.user.id ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${msg.senderUserId === session.user.id ? 'bg-[var(--rt-accent)] text-white' : 'border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] text-[var(--rt-ink)]'}`}>
                        {msg.body}
                      </div>
                    </div>
                  ))}
                  {activeConnectionThread.myMessageCount < MAX_MESSAGES_PER_USER ? (
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={activeConnectionDraft}
                        onChange={(e) => setActiveConnectionDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && activeConnectionDraft.trim()) { e.preventDefault(); void handleSendActiveConnectionMessage() } }}
                        maxLength={240}
                        placeholder="Message…"
                        disabled={isSendingActiveMessage}
                        className="flex-1 rounded-xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-3 py-2 text-sm text-[var(--rt-ink)] outline-none transition-[border-color,box-shadow] duration-150 ease-out focus:border-[var(--rt-accent)] focus:ring-2 focus:ring-[var(--rt-accent-soft)] disabled:opacity-60"
                      />
                      <button type="button" onClick={() => void handleSendActiveConnectionMessage()} disabled={isSendingActiveMessage || !activeConnectionDraft.trim()} className="inline-flex items-center justify-center rounded-xl bg-[var(--rt-accent)] px-3 py-2 text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:opacity-60" aria-label="Send">
                        <Send className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-[var(--rt-ink-faint)]">Message limit reached for this thread.</p>
                  )}
                  {activeMessageError ? <p className="mt-1 text-xs text-rose-600">{activeMessageError}</p> : null}
                </>
              ) : (
                <p className="text-sm text-[var(--rt-ink-soft)]">No messages yet.</p>
              )}
            </div>

            <button type="button" onClick={handleEndConnection} disabled={pendingAction === 'end-connection'} className="mt-3 inline-flex w-full items-center justify-center rounded-xl bg-[var(--rt-accent)] px-4 py-2.5 text-sm font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:opacity-70">
              {pendingAction === 'end-connection' ? 'Ending...' : 'I am free again'}
            </button>
          </div>
        ) : null}

        {/* ── Finder notice ── */}
        {finderNotice ? (
          <div className="rt-notice rounded-2xl border border-[var(--rt-border-strong)] bg-[var(--rt-accent-soft)] p-4 text-[var(--rt-ink)]">
            <p className="text-sm font-semibold">{finderNotice.title}</p>
            <p className="mt-1 text-sm">{finderNotice.description}</p>
          </div>
        ) : null}

        {/* ── Motion shortcut ── */}
        {!isInConversation && motionAccessState !== 'active' && motionAccessState !== 'unavailable' ? (
          <div className="rounded-2xl border border-dashed border-[var(--rt-border)] bg-[var(--rt-surface)] p-4">
            <p className="text-sm font-semibold text-[var(--rt-ink)]">Phone flip shortcut</p>
            <p className="mt-1 text-sm text-[var(--rt-ink-soft)]">Allow motion access so flipping your phone face-down quietly takes you out of the ready pool.</p>
            {motionAccessState !== 'requesting' ? (
              <button type="button" onClick={() => void handleEnableMotionAccess()} className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--rt-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97]">
                {motionAccessState === 'denied' ? 'Try again' : 'Enable shortcut'}
              </button>
            ) : null}
          </div>
        ) : null}
        {motionNotice ? <p className="text-sm font-medium text-[var(--rt-accent)]">{motionNotice}</p> : null}

        {/* ── Error banner ── */}
        {error ? (
          <div className="rt-notice flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : null}

        {/* Spacer for bottom nav */}
        <div className="h-4" />
        </div>{/* end inner flex col */}
      </div>{/* end main */}

      {/* ── Bottom navigation ── */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--rt-border)] bg-[var(--rt-bg)]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-xl items-center justify-around px-2 py-2">
          <NavTab icon={<MapPin className="h-5 w-5" />} label="Places" active />
          <NavTab icon={<MessageCircle className="h-5 w-5" />} label="Requests" badge={pendingIncomingRequests.length} />
          <NavTab icon={<Users className="h-5 w-5" />} label="People" />
        </div>
      </nav>

      {/* Request to talk modal */}
      {connectModalTarget ? (
        <div className="rt-modal-backdrop fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <div className="rt-modal-sheet w-full max-w-xl rounded-t-[2rem] border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] p-6 shadow-[0_24px_80px_rgba(17,52,44,0.22)] sm:rounded-[2rem] sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.24em] text-[var(--rt-accent)]">
                  Request to talk
                </p>
                <h3 className="mt-2 text-2xl font-bold text-[var(--rt-ink)]">
                  Send a short note
                </h3>
              </div>
              <button
                type="button"
                onClick={handleCloseConnectModal}
                className="rounded-full border border-[var(--rt-border)] p-2 text-[var(--rt-ink-soft)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.9] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--rt-ink)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-accent-soft)] p-4">
              <p className="text-sm font-semibold text-[var(--rt-ink)]">
                {connectModalTarget.username}
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
                {connectModalTarget.moodEmoji} {connectModalTarget.intentSummary || 'Open to a nearby conversation.'}
              </p>
            </div>

            <div className="mt-5">
              <label>
                <span className="mb-2 block text-sm font-semibold text-[var(--rt-ink)]">
                  Your message <span className="font-normal text-[var(--rt-ink-soft)]">(optional)</span>
                </span>
                <p className="mb-3 text-sm leading-6 text-[var(--rt-ink-soft)]">
                  Keep it genuine. {connectModalTarget.username} will use this to decide whether to meet you.
                </p>
                <textarea
                  value={introMessage}
                  onChange={(e) => setIntroMessage(e.target.value)}
                  rows={3}
                  maxLength={240}
                  placeholder={`Hi, I noticed you're open to a conversation. I'd love to chat about...`}
                  className="w-full rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-3 text-base text-[var(--rt-ink)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[color:rgba(69,104,90,0.55)] focus:border-[var(--rt-accent-strong)] focus:ring-2 focus:ring-[var(--rt-accent-soft-strong)]"
                />
                <p className="mt-1 text-right text-xs text-[var(--rt-ink-soft)]">
                  {introMessage.length}/240
                </p>
              </label>
            </div>

            {connectError ? (
              <div className="rt-notice mt-4 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {connectError}
              </div>
            ) : null}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => void handleSendConnectRequest()}
                disabled={pendingAction === 'connect'}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--rt-accent)] px-5 py-3 font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                <Send className="h-4 w-4" />
                {pendingAction === 'connect' ? 'Sending...' : 'Request to talk'}
              </button>
              <button
                type="button"
                onClick={handleCloseConnectModal}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--rt-border)] bg-white px-5 py-3 font-semibold text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function MessageBubble({
  message,
  isSelf,
}: {
  message: ConnectRequestMessage
  isSelf: boolean
}) {
  return (
    <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 ${
          isSelf
            ? 'bg-[var(--rt-accent)] text-white'
            : 'border border-[var(--rt-border)] bg-white text-[var(--rt-ink)]'
        }`}
      >
        {message.body}
      </div>
    </div>
  )
}

function IncomingRequestCard({
  request,
  currentUserId,
  isResponding,
  isSendingReply,
  replyDraft,
  replyError,
  onReplyDraftChange,
  onSendReply,
  onAccept,
  onReject,
}: {
  request: IncomingConnectRequest
  currentUserId: string
  isResponding: boolean
  isSendingReply: boolean
  replyDraft: string
  replyError: string | null
  onReplyDraftChange: (val: string) => void
  onSendReply: () => void
  onAccept: () => void
  onReject: () => void
}) {
  const recipientMessageCount = request.recipientMessageCount
  const canReply = recipientMessageCount < MAX_MESSAGES_PER_USER

  return (
    <div className="rounded-3xl border border-[var(--rt-border)] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-[var(--rt-ink)]">
            {request.requester.username}
          </p>
          <p className="mt-1 text-sm leading-6 text-[var(--rt-ink-soft)]">
            {request.requester.moodEmoji} {request.requester.intentSummary || 'Open to a nearby conversation.'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-[var(--rt-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--rt-accent)]">
          Request to talk
        </span>
      </div>

      {/* Intro message */}
      {request.introMessage ? (
        <div className="mt-3 rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-3">
          <p className="text-sm leading-6 text-[var(--rt-ink)]">
            "{request.introMessage}"
          </p>
        </div>
      ) : null}

      {/* Thread messages */}
      {request.messages.length > 0 ? (
        <div className="mt-3 space-y-2">
          {request.messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isSelf={msg.senderUserId === currentUserId}
            />
          ))}
        </div>
      ) : null}

      {/* Message counter */}
      <p className="mt-3 text-xs text-[var(--rt-ink-soft)]">
        {canReply
          ? `${recipientMessageCount} of ${MAX_MESSAGES_PER_USER} messages used`
          : `You've reached the ${MAX_MESSAGES_PER_USER}-message limit for this request.`}
      </p>

      {/* Reply box */}
      {canReply ? (
        <div className="mt-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={replyDraft}
              onChange={(e) => onReplyDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && replyDraft.trim()) {
                  e.preventDefault()
                  onSendReply()
                }
              }}
              maxLength={240}
              placeholder="Send a message…"
              disabled={isSendingReply}
              className="flex-1 rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-3 py-2 text-sm text-[var(--rt-ink)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[color:rgba(69,104,90,0.55)] focus:border-[var(--rt-accent-strong)] focus:ring-2 focus:ring-[var(--rt-accent-soft-strong)] disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={onSendReply}
              disabled={isSendingReply || !replyDraft.trim()}
              className="inline-flex items-center justify-center rounded-2xl bg-[var(--rt-accent)] px-3 py-2 text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          {replyError ? (
            <p className="mt-2 text-xs text-rose-600">{replyError}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onAccept}
          disabled={isResponding}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--rt-accent)] px-4 py-2.5 text-sm font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          <Check className="h-4 w-4" />
          {isResponding ? 'Accepting...' : 'Accept and start talking'}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={isResponding}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--rt-border)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          <X className="h-4 w-4" />
          Decline
        </button>
      </div>
    </div>
  )
}

function PresencePersonCard({
  participant,
  isCurrentUser,
  isInConversation,
  staggerIndex = 0,
  onConnect,
  onPing,
  isPinging,
}: {
  participant: PlaceAgentState['participants'][number]
  isCurrentUser: boolean
  isInConversation: boolean
  staggerIndex?: number
  onConnect: (() => void) | null
  onPing: (() => void) | null
  isPinging: boolean
}) {
  return (
    <div
      className="rt-card-stagger rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface)] p-4 shadow-sm backdrop-blur-sm"
      style={{ animationDelay: `${staggerIndex * 50}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Avatar circle */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--rt-accent-soft)] text-lg">
          {participant.moodEmoji || '👤'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-bold text-[var(--rt-ink)]">{participant.username}</p>
            {isCurrentUser ? (
              <span className="shrink-0 rounded-full bg-[var(--rt-accent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">You</span>
            ) : null}
          </div>
          {participant.intentSummary ? (
            <p className="mt-0.5 text-sm leading-5 text-[var(--rt-ink-soft)]">"{participant.intentSummary}"</p>
          ) : null}
          {participant.isFindable && participant.locationHint ? (
            <p className="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--rt-accent)]">
              <LocateFixed className="h-3 w-3" />
              {participant.locationHint}
            </p>
          ) : null}
          {/* Interest tags */}
          {participant.tags && participant.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {participant.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-2 py-0.5 text-[10px] font-semibold text-[var(--rt-ink-soft)]"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${participant.isFindable ? 'bg-[var(--rt-accent)] text-white' : 'bg-[var(--rt-accent-soft)] text-[var(--rt-accent)]'}`}>
            {participant.isFindable ? 'Findable' : 'Ready'}
          </span>
          {onConnect ? (
            <button type="button" onClick={onConnect} className="inline-flex items-center gap-1 rounded-full bg-[var(--rt-accent)] px-3 py-1.5 text-xs font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)]">
              <Send className="h-3 w-3" />
              Talk
            </button>
          ) : null}
          {onPing ? (
            <button type="button" onClick={onPing} disabled={isPinging} className="inline-flex items-center gap-1 rounded-full border border-[var(--rt-border)] bg-white px-2.5 py-1.5 text-xs font-semibold text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:opacity-60">
              <BellRing className={`h-3 w-3${isPinging ? ' rt-bell-ring' : ''}`} />
              {isPinging ? '...' : 'Ping'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function NavTab({
  icon,
  label,
  active = false,
  badge = 0,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  badge?: number
}) {
  return (
    <button
      type="button"
      className={`relative flex flex-col items-center gap-0.5 px-5 py-2 transition-[color,opacity,transform] duration-150 ease-out active:scale-[0.95] ${active ? 'text-[var(--rt-accent)]' : 'text-[var(--rt-ink-faint)]'}`}
    >
      <div className="relative">
        {icon}
        {badge > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--rt-accent)] text-[9px] font-bold text-white">
            {badge}
          </span>
        ) : null}
      </div>
      <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${active ? 'text-[var(--rt-accent)]' : 'text-[var(--rt-ink-faint)]'}`}>{label}</span>
    </button>
  )
}

function formatConversationElapsed(createdAt: string | Date, now: number) {
  const startedAt = new Date(createdAt).getTime()
  if (!Number.isFinite(startedAt)) return null
  const elapsedMinutes = Math.max(0, Math.floor((now - startedAt) / 60000))
  if (elapsedMinutes < 1) return 'Started now'
  if (elapsedMinutes === 1) return '1 min in'
  return `${elapsedMinutes} min in`
}
