import 'leaflet/dist/leaflet.css'
import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { LoaderCircle, MapPinned } from 'lucide-react'
import type { NearbyPlace } from '../lib/app-types'

export function NearbyPlacesMap({
  places,
  selectedPlaceId,
  locationCoords,
  onSelectPlace,
}: {
  places: NearbyPlace[]
  selectedPlaceId: string | null
  locationCoords: {
    latitude: number
    longitude: number
  } | null
  onSelectPlace: (placeId: string) => void
}) {
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const locationMarkerRef = useRef<L.Marker | null>(null)
  const [loadingState, setLoadingState] = useState<'loading' | 'ready'>('loading')

  useEffect(() => {
    if (places.length === 0 || !mapElementRef.current) {
      return
    }

    if (!mapRef.current) {
      mapRef.current = L.map(mapElementRef.current, {
        zoomControl: true,
        attributionControl: true,
      })

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(mapRef.current)

      markerLayerRef.current = L.layerGroup().addTo(mapRef.current)
    }

    markerLayerRef.current?.clearLayers()

    if (locationMarkerRef.current) {
      locationMarkerRef.current.remove()
      locationMarkerRef.current = null
    }

    const bounds = L.latLngBounds([])

    for (const p of places) {
      const isSelected = p.placeId === selectedPlaceId
      const icon = buildPlaceIcon({ isSelected, readyCount: p.readyCount })
      const marker = L.marker([p.lat, p.lng], { icon, title: p.name })
      marker.on('click', () => onSelectPlace(p.placeId))
      markerLayerRef.current?.addLayer(marker)
      bounds.extend([p.lat, p.lng])
    }

    if (locationCoords) {
      const locIcon = buildLocationIcon()
      locationMarkerRef.current = L.marker(
        [locationCoords.latitude, locationCoords.longitude],
        { icon: locIcon, title: 'Your location' },
      ).addTo(mapRef.current)
      bounds.extend([locationCoords.latitude, locationCoords.longitude])
    }

    if (locationCoords) {
      mapRef.current.setView([locationCoords.latitude, locationCoords.longitude], 17)
    } else if (bounds.isValid()) {
      mapRef.current.fitBounds(bounds, { padding: [56, 56] })
    }

    setLoadingState('ready')

    return () => {
      markerLayerRef.current?.clearLayers()
      if (locationMarkerRef.current) {
        locationMarkerRef.current.remove()
        locationMarkerRef.current = null
      }
    }
  }, [locationCoords, onSelectPlace, places, selectedPlaceId])

  useEffect(() => {
    return () => {
      mapRef.current?.remove()
      mapRef.current = null
      markerLayerRef.current = null
    }
  }, [])

  return (
    <div className="mt-4 overflow-hidden rounded-[2rem] border border-[var(--rt-border)] bg-[radial-gradient(circle_at_top_left,_rgba(18,63,53,0.14),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(11,93,73,0.14),_transparent_34%),linear-gradient(180deg,rgba(248,252,248,1),rgba(234,245,236,0.98))] p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--rt-ink)]">Nearby map</p>
          <p className="mt-1 text-sm leading-6 text-[var(--rt-ink-soft)]">
            Tap a place pin to preview it.
          </p>
        </div>
        <div className="rounded-full bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--rt-accent)]">
          Live nearby
        </div>
      </div>

      <div className="relative mt-4 overflow-hidden rounded-[1.75rem] border border-white/80 bg-[#dcebdc] shadow-inner">
        <div ref={mapElementRef} className="aspect-[4/3] w-full" />

        {loadingState === 'loading' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/75 text-[var(--rt-ink-soft)] backdrop-blur-sm">
            <LoaderCircle className="h-6 w-6 animate-spin" />
            <p className="text-sm font-medium">Loading nearby map...</p>
          </div>
        ) : null}

        {places.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/70 text-[var(--rt-ink-soft)] backdrop-blur-sm">
            <MapPinned className="h-7 w-7" />
            <p className="text-sm font-medium">Preparing nearby places map...</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function buildPlaceIcon({
  isSelected,
  readyCount,
}: {
  isSelected: boolean
  readyCount: number
}) {
  const bg = isSelected ? '#123f35' : readyCount > 0 ? '#0b5d49' : '#6e8f80'
  const html = `<div style="background:${bg};border:2px solid white;border-radius:9999px;min-width:2.75rem;min-height:2.75rem;display:flex;align-items:center;justify-content:center;font-size:0.875rem;font-weight:700;color:white;box-shadow:0 4px 6px -1px rgba(0,0,0,.25),0 2px 4px -1px rgba(0,0,0,.1)">${readyCount}</div>`
  return L.divIcon({
    html,
    className: '',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  })
}

function buildLocationIcon() {
  const html = `<div style="width:1.25rem;height:1.25rem;border-radius:9999px;border:3px solid white;background:#1b8d6d;box-shadow:0 4px 6px -1px rgba(0,0,0,.25)"></div>`
  return L.divIcon({
    html,
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  })
}
