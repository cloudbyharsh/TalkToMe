import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { getAgentByName } from 'agents'
import { getRequestHeaders } from '@tanstack/react-start/server'
import type {
  ActiveConnectionState,
  AppSession,
  AppState,
  CurrentPlaceState,
  IncomingConnectRequest,
  NearbyPlace,
  NearbyPlacePreviewState,
  PresenceStatus,
  UserAgentState,
  UserProfileState,
} from '../app-types'
import { auth } from './auth'
import { db } from './db'
import type { UserAgent } from './agents/user-agent'
import {
  connectRequest,
  handoffConnection,
  place,
  user,
  userProfile,
} from './db/schema'
import {
  getUserAgentBinding,
} from './env'

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>

type OverpassElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

function mapSession(session: NonNullable<SessionResult>): AppSession {
  return {
    session: {
      expiresAt: session.session.expiresAt,
    },
    user: {
      id: session.user.id,
      name: session.user.name,
      username: session.user.username ?? null,
      displayUsername: session.user.displayUsername ?? null,
    },
  }
}

function mapUserProfile(
  profileRecord: typeof userProfile.$inferSelect,
): UserProfileState {
  return {
    userId: profileRecord.userId,
    moodEmoji: profileRecord.moodEmoji,
    intentText: profileRecord.intentText,
    intentSummary: profileRecord.intentSummary,
    status: profileRecord.status as PresenceStatus,
    currentPlaceId: profileRecord.currentPlaceId,
    isFindable: profileRecord.isFindable,
    locationHint: profileRecord.locationHint,
    pingRequestedAt: profileRecord.pingRequestedAt,
    pingRequestedByUserId: profileRecord.pingRequestedByUserId,
    pingRequestedByUsername: profileRecord.pingRequestedByUsername,
    createdAt: profileRecord.createdAt,
    updatedAt: profileRecord.updatedAt,
  }
}

function mapPlace(
  record: typeof place.$inferSelect,
  readyCount = 0,
): NearbyPlace {
  return {
    placeId: record.placeId,
    name: record.name,
    address: record.address,
    lat: record.lat,
    lng: record.lng,
    readyCount,
  }
}

function getDisplayUsername(record: typeof user.$inferSelect) {
  return record.displayUsername || record.username || record.name
}

async function getPendingIncomingRequests(
  recipientUserId: string,
  placeId: string,
): Promise<IncomingConnectRequest[]> {
  const rows = await db
    .select({
      id: connectRequest.id,
      placeId: connectRequest.placeId,
      introMessage: connectRequest.introMessage,
      createdAt: connectRequest.createdAt,
      requesterUserId: connectRequest.requesterUserId,
      requesterDisplayUsername: user.displayUsername,
      requesterUsername: user.username,
      requesterName: user.name,
      requesterMoodEmoji: userProfile.moodEmoji,
      requesterIntentSummary: userProfile.intentSummary,
    })
    .from(connectRequest)
    .innerJoin(user, eq(user.id, connectRequest.requesterUserId))
    .leftJoin(userProfile, eq(userProfile.userId, connectRequest.requesterUserId))
    .where(
      and(
        eq(connectRequest.recipientUserId, recipientUserId),
        eq(connectRequest.placeId, placeId),
        eq(connectRequest.status, 'pending'),
      ),
    )
    .orderBy(desc(connectRequest.createdAt))
    .limit(10)

  return rows.map((row) => ({
    id: row.id,
    placeId: row.placeId,
    introMessage: row.introMessage,
    createdAt: row.createdAt,
    requester: {
      userId: row.requesterUserId,
      username:
        row.requesterDisplayUsername ||
        row.requesterUsername ||
        row.requesterName,
      moodEmoji: row.requesterMoodEmoji ?? null,
      intentSummary: row.requesterIntentSummary ?? null,
    },
  }))
}

async function getActiveConnectionForUser(
  userId: string,
): Promise<ActiveConnectionState | null> {
  const [connectionRecord] = await db
    .select()
    .from(handoffConnection)
    .where(
      and(
        eq(handoffConnection.status, 'accepted'),
        or(
          eq(handoffConnection.requesterUserId, userId),
          eq(handoffConnection.recipientUserId, userId),
        ),
      ),
    )
    .orderBy(desc(handoffConnection.createdAt))
    .limit(1)

  if (!connectionRecord) {
    return null
  }

  const counterpartUserId =
    connectionRecord.requesterUserId === userId
      ? connectionRecord.recipientUserId
      : connectionRecord.requesterUserId

  const [counterpartUser] = await db
    .select()
    .from(user)
    .where(eq(user.id, counterpartUserId))
    .limit(1)
  const [counterpartProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, counterpartUserId))
    .limit(1)

  if (!counterpartUser || !counterpartProfile) {
    return null
  }

  return {
    id: connectionRecord.id,
    placeId: connectionRecord.placeId,
    createdAt: connectionRecord.createdAt,
    counterpart: {
      userId: counterpartUser.id,
      username: getDisplayUsername(counterpartUser),
      moodEmoji: counterpartProfile.moodEmoji,
      intentSummary: counterpartProfile.intentSummary,
    },
  }
}

function mapUserProfileStateFromAgent(
  state: UserAgentState,
  intentText: string | null,
): UserProfileState {
  const now = state.updatedAt ? new Date(state.updatedAt) : new Date()

  return {
    userId: state.userId,
    moodEmoji: state.moodEmoji,
    intentText,
    intentSummary: state.intentSummary,
    status: state.status,
    currentPlaceId: state.currentPlaceId,
    isFindable: state.isFindable,
    locationHint: state.locationHint,
    pingRequestedAt: state.pingRequestedAt,
    pingRequestedByUserId: state.pingRequestedByUserId,
    pingRequestedByUsername: state.pingRequestedByUsername,
    createdAt: now,
    updatedAt: now,
  }
}

export async function getCurrentSession() {
  try {
    return await auth.api.getSession({
      headers: new Headers(getRequestHeaders()),
      asResponse: false,
      query: {
        disableRefresh: true,
      },
    })
  } catch {
    return null
  }
}

export async function requireCurrentSession() {
  const session = await getCurrentSession()

  if (!session) {
    throw new Error('Your session expired. Sign in again and try once more.')
  }

  return session
}

export async function getAppState(): Promise<AppState> {
  const session = await getCurrentSession()

  if (!session) {
    return {
      session: null,
      profile: null,
      currentPlace: null,
      pendingIncomingRequests: [],
      activeConnection: null,
    }
  }

  const [profileRecord] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)

  let currentPlace: CurrentPlaceState | null = null
  let pendingIncomingRequests: IncomingConnectRequest[] = []

  if (profileRecord?.currentPlaceId) {
    const [currentPlaceRecord] = await db
      .select()
      .from(place)
      .where(eq(place.placeId, profileRecord.currentPlaceId))
      .limit(1)

    if (currentPlaceRecord) {
      const [{ readyCount }] = await db
        .select({
          readyCount: sql<number>`count(*)`,
        })
        .from(userProfile)
        .where(
          and(
            eq(userProfile.currentPlaceId, profileRecord.currentPlaceId),
            eq(userProfile.status, 'ready'),
          ),
        )

      currentPlace = {
        place: mapPlace(currentPlaceRecord, readyCount),
        readyCount,
      }

      pendingIncomingRequests = await getPendingIncomingRequests(
        session.user.id,
        profileRecord.currentPlaceId,
      )
    }
  }

  return {
    session: mapSession(session),
    profile: profileRecord ? mapUserProfile(profileRecord) : null,
    currentPlace,
    pendingIncomingRequests,
    activeConnection: await getActiveConnectionForUser(session.user.id),
  }
}

async function getUserAgent(userId: string) {
  return getAgentByName<Cloudflare.Env, UserAgent>(getUserAgentBinding(), userId)
}

export async function saveUserProfile(input: {
  moodEmoji: string
  intentText: string
  currentPlaceId: string
}) {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  const nextState = await agent.setProfile(input)
  const intentText = input.intentText.replace(/\s+/g, ' ').trim() || null

  return mapUserProfileStateFromAgent(nextState, intentText)
}

export async function setReadyState(input: { ready: boolean }) {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  await agent.setReady(input)
}

export async function saveFinderProfile(input: {
  isFindable: boolean
  locationHint: string | null
}) {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  const [existingProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)
  const nextState = await agent.setFinderProfile(input)

  return mapUserProfileStateFromAgent(nextState, existingProfile?.intentText ?? null)
}

export async function pingFindableUser(input: { userId: string }) {
  const session = await requireCurrentSession()
  const targetUserId = input.userId.trim()

  if (!targetUserId) {
    throw new Error('Choose someone in the place first.')
  }

  const targetAgent = await getUserAgent(targetUserId)
  await targetAgent.requestFinderPing({
    requesterUserId: session.user.id,
  })

  return {
    success: true,
  }
}

export async function leaveCurrentPlace() {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  await agent.leavePlace()
}

export async function sendConnectRequest(input: {
  recipientUserId: string
  introMessage: string
}) {
  const session = await requireCurrentSession()
  const recipientUserId = input.recipientUserId.trim()
  const introMessage = input.introMessage.replace(/\s+/g, ' ').trim() || null

  if (!recipientUserId) {
    throw new Error('Choose someone to connect with.')
  }

  if (recipientUserId === session.user.id) {
    throw new Error('You cannot send a request to yourself.')
  }

  const [viewerProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)

  if (!viewerProfile?.currentPlaceId) {
    throw new Error('Join a place before sending a connect request.')
  }

  if (viewerProfile.status === 'in_conversation') {
    throw new Error('End your current conversation before sending a new request.')
  }

  const [recipientProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, recipientUserId))
    .limit(1)

  if (
    !recipientProfile?.currentPlaceId ||
    recipientProfile.currentPlaceId !== viewerProfile.currentPlaceId
  ) {
    throw new Error('That person is no longer at this place.')
  }

  if (recipientProfile.status !== 'ready') {
    throw new Error('That person is not marked ready right now.')
  }

  // Cancel any existing pending request from this requester to this recipient at this place.
  const now = new Date()
  await db
    .update(connectRequest)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(connectRequest.requesterUserId, session.user.id),
        eq(connectRequest.recipientUserId, recipientUserId),
        eq(connectRequest.placeId, viewerProfile.currentPlaceId),
        eq(connectRequest.status, 'pending'),
      ),
    )

  const requestId = crypto.randomUUID()
  await db.insert(connectRequest).values({
    id: requestId,
    requesterUserId: session.user.id,
    recipientUserId,
    placeId: viewerProfile.currentPlaceId,
    introMessage,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  })

  return { success: true, requestId }
}

export async function respondToConnectRequest(input: {
  requestId: string
  accept: boolean
}) {
  const session = await requireCurrentSession()
  const requestId = input.requestId.trim()

  if (!requestId) {
    throw new Error('No request specified.')
  }

  const [requestRecord] = await db
    .select()
    .from(connectRequest)
    .where(eq(connectRequest.id, requestId))
    .limit(1)

  if (!requestRecord) {
    throw new Error('That request no longer exists.')
  }

  if (requestRecord.recipientUserId !== session.user.id) {
    throw new Error('You cannot respond to this request.')
  }

  if (requestRecord.status !== 'pending') {
    throw new Error('That request is no longer pending.')
  }

  const now = new Date()

  if (!input.accept) {
    await db
      .update(connectRequest)
      .set({ status: 'rejected', updatedAt: now })
      .where(eq(connectRequest.id, requestId))

    return { success: true, accepted: false }
  }

  // Accepting: validate both users are still ready in the same place.
  const [recipientProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)

  const [requesterProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, requestRecord.requesterUserId))
    .limit(1)

  if (
    !recipientProfile?.currentPlaceId ||
    recipientProfile.currentPlaceId !== requestRecord.placeId
  ) {
    throw new Error('You are no longer at the same place.')
  }

  if (recipientProfile.status === 'in_conversation') {
    throw new Error('End your current conversation before accepting a request.')
  }

  if (
    !requesterProfile?.currentPlaceId ||
    requesterProfile.currentPlaceId !== requestRecord.placeId
  ) {
    await db
      .update(connectRequest)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(connectRequest.id, requestId))

    throw new Error('That person has left the place. The request was cancelled.')
  }

  if (requesterProfile.status === 'in_conversation') {
    await db
      .update(connectRequest)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(connectRequest.id, requestId))

    throw new Error('That person is already in a conversation.')
  }

  const existingRecipientConnection = await getActiveConnectionForUser(session.user.id)
  if (existingRecipientConnection) {
    throw new Error('You are already connected with someone.')
  }

  const existingRequesterConnection = await getActiveConnectionForUser(
    requestRecord.requesterUserId,
  )
  if (existingRequesterConnection) {
    throw new Error('That person is already in a conversation.')
  }

  // Mark request accepted and create the active connection.
  await db
    .update(connectRequest)
    .set({ status: 'accepted', updatedAt: now })
    .where(eq(connectRequest.id, requestId))

  // The recipient is the "agent" here — they trigger the connection creation.
  const agent = await getUserAgent(session.user.id)
  const result = await agent.connectWithUser({
    counterpartUserId: requestRecord.requesterUserId,
    placeId: requestRecord.placeId,
  })

  return { success: result.success, accepted: true, connectionId: result.connectionId }
}

export async function endCurrentConnection() {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  const result = await agent.endCurrentConnection()

  return {
    success: result.success,
  }
}

function mapOverpassElement(el: OverpassElement): NearbyPlace | null {
  const tags = el.tags ?? {}
  const name = tags['name']
  if (!name) return null

  const lat = el.lat ?? el.center?.lat
  const lng = el.lon ?? el.center?.lon
  if (typeof lat !== 'number' || typeof lng !== 'number') return null

  const addrParts = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']].filter(Boolean)
  const address = addrParts.length > 0 ? addrParts.join(' ') : name

  return {
    placeId: `osm:${el.type}:${el.id}`,
    name,
    address,
    lat,
    lng,
    readyCount: 0,
  }
}

export async function searchNearbyPlacesForLocation(input: {
  latitude: number
  longitude: number
}) {
  await requireCurrentSession()

  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    throw new Error('A valid location is required.')
  }

  const query = `[out:json][timeout:10];(node["name"](around:120,${input.latitude},${input.longitude});way["name"](around:120,${input.latitude},${input.longitude}););out center 8;`

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'TalkToMe/1.0',
    },
    body: `data=${encodeURIComponent(query)}`,
  })

  if (!response.ok) {
    throw new Error('Unable to load nearby places right now.')
  }

  const payload = (await response.json()) as {
    elements?: OverpassElement[]
  }

  const places = (payload.elements ?? [])
    .map(mapOverpassElement)
    .filter((value): value is NearbyPlace => value !== null)

  if (places.length > 0) {
    const now = new Date()

    await db
      .insert(place)
      .values(
        places.map((nearbyPlace) => ({
          placeId: nearbyPlace.placeId,
          name: nearbyPlace.name,
          address: nearbyPlace.address,
          lat: nearbyPlace.lat,
          lng: nearbyPlace.lng,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
  }

  if (places.length === 0) {
    return places
  }

  const readyCountRows = await db
    .select({
      placeId: userProfile.currentPlaceId,
      readyCount: sql<number>`count(*)`,
    })
    .from(userProfile)
    .where(
      and(
        inArray(
          userProfile.currentPlaceId,
          places.map((nearbyPlace) => nearbyPlace.placeId),
        ),
        eq(userProfile.status, 'ready'),
      ),
    )
    .groupBy(userProfile.currentPlaceId)

  const readyCountByPlaceId = new Map(
    readyCountRows
      .filter(
        (
          row,
        ): row is {
          placeId: string
          readyCount: number
        } => Boolean(row.placeId),
      )
      .map((row) => [row.placeId, row.readyCount]),
  )

  return places.map((nearbyPlace) => ({
    ...nearbyPlace,
    readyCount: readyCountByPlaceId.get(nearbyPlace.placeId) ?? 0,
  }))
}

export async function getNearbyPlacePreview(input: { placeId: string }) {
  await requireCurrentSession()

  const placeId = input.placeId.trim()

  if (!placeId) {
    throw new Error('Choose a place first.')
  }

  const [placeRecord] = await db
    .select()
    .from(place)
    .where(eq(place.placeId, placeId))
    .limit(1)

  if (!placeRecord) {
    throw new Error('That place is no longer available.')
  }

  const presentStatuses = ['present', 'ready', 'in_conversation'] as const
  const [{ readyCount, checkedInCount }] = await db
    .select({
      readyCount: sql<number>`count(case when ${userProfile.status} = 'ready' then 1 end)`,
      checkedInCount: sql<number>`count(*)`,
    })
    .from(userProfile)
    .where(
      and(
        eq(userProfile.currentPlaceId, placeId),
        inArray(userProfile.status, presentStatuses),
      ),
    )

  const readyParticipantRecords = await db
    .select({
      userId: user.id,
      username: user.displayUsername,
      fallbackUsername: user.username,
      fallbackName: user.name,
      moodEmoji: userProfile.moodEmoji,
      intentSummary: userProfile.intentSummary,
      status: userProfile.status,
      isFindable: userProfile.isFindable,
      locationHint: userProfile.locationHint,
      pingRequestedAt: userProfile.pingRequestedAt,
      pingRequestedByUserId: userProfile.pingRequestedByUserId,
      pingRequestedByUsername: userProfile.pingRequestedByUsername,
    })
    .from(userProfile)
    .innerJoin(user, eq(user.id, userProfile.userId))
    .where(
      and(
        eq(userProfile.currentPlaceId, placeId),
        eq(userProfile.status, 'ready'),
      ),
    )
    .orderBy(desc(userProfile.updatedAt))
    .limit(8)

  const [{ activeConversationCount }] = await db
    .select({
      activeConversationCount: sql<number>`count(*)`,
    })
    .from(handoffConnection)
    .where(
      and(
        eq(handoffConnection.placeId, placeId),
        eq(handoffConnection.status, 'accepted'),
      ),
    )

  return {
    placeId,
    readyCount,
    checkedInCount,
    activeConversationCount,
      readyParticipants: readyParticipantRecords.map((record) => ({
        userId: record.userId,
        username:
          record.username || record.fallbackUsername || record.fallbackName,
        moodEmoji: record.moodEmoji,
        intentSummary: record.intentSummary,
        status: record.status as NearbyPlacePreviewState['readyParticipants'][number]['status'],
        isFindable: record.isFindable ?? false,
        locationHint: record.locationHint ?? null,
        pingRequestedAt: record.pingRequestedAt,
        pingRequestedByUserId: record.pingRequestedByUserId ?? null,
        pingRequestedByUsername: record.pingRequestedByUsername ?? null,
      })),  } satisfies NearbyPlacePreviewState
}

