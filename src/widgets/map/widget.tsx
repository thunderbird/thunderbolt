/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Skeleton } from '@/components/ui/skeleton'
import type { Map as MaplibreMap, MapLayerMouseEvent, Popup as MaplibrePopup, StyleSpecification } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { featureBounds, featureLabel, parseFeatureCollection } from './geojson'

type MapWidgetProps = {
  /** GeoJSON FeatureCollection as a JSON string (validated by the schema). */
  data: string
  title?: string
}

/**
 * CARTO "Positron" — the same clean light look as raster image tiles, no key.
 */
const cartoPositron: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
}

/**
 * Basemaps to choose from — both no API key. `positron` is OpenFreeMap's clean
 * light *vector* style (sharper at all zooms, restylable); `carto` is the
 * equivalent look as plain raster tiles. Flip `basemap` below to switch.
 *
 * NOTE: heavy production use of either should move to a keyed provider
 * (MapTiler / Stadia) or self-hosted tiles rather than the public endpoints.
 */
const basemaps = {
  positron: 'https://tiles.openfreemap.org/styles/positron',
  carto: cartoPositron,
}

/** Active basemap — start with the OpenFreeMap vector Positron; swap to
 *  `basemaps.carto` to compare the raster version. */
const basemap: string | StyleSpecification = basemaps.positron

/** Layers a click/hover popup can originate from. */
const interactiveLayers = ['points', 'lines', 'polygons-fill'] as const

/** Fallback feature color when a feature carries no simplestyle override. */
const defaultColor = '#3b82f6'

/** Pulsing placeholder shown while MapLibre's chunk + tiles load. Mirrors the
 *  WeatherForecast / LinkPreview skeleton pattern. */
export const MapSkeleton = () => <Skeleton className="absolute inset-0 rounded-none" />

/**
 * Self-contained map skeleton card — the same outer chrome `MapWidget` renders,
 * so the streaming placeholder (shown the moment the `<widget:map>` tag opens,
 * while its GeoJSON payload is still being generated) hands off seamlessly to
 * the real widget once the data arrives. Registered as the widget's `Skeleton`.
 */
export const MapWidgetSkeleton = () => (
  <div className="my-4">
    <div className="relative h-80 w-full overflow-hidden rounded-lg border border-border">
      <MapSkeleton />
    </div>
  </div>
)

/** Friendly message shown when the browser can't give MapLibre a WebGL context. */
const webglUnavailableMessage = 'Maps can’t be displayed here — WebGL is disabled or unavailable in this browser.'

/** Generic message for any other map load failure (style/tiles/network). */
const mapLoadFailedMessage = 'The map couldn’t be loaded.'

/**
 * Cheap synchronous probe: can this browser create a WebGL context at all?
 * MapLibre requires one, and when WebGL is off (Firefox with hardware accel /
 * `resistFingerprinting` disabled, a blocklisted GPU, headless, etc.) it throws
 * a verbose `webglcontextcreationerror`. We detect up front and show a clean
 * message instead of dumping MapLibre's raw error JSON at the user.
 */
const isWebglAvailable = (): boolean => {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Generic GeoJSON map widget: renders a FeatureCollection (points / lines /
 * polygons) on an interactive map, fits the view to the data, and shows a
 * popup with each feature's neutral display fields (`label` / `description`)
 * on click. Domain-specific properties are never surfaced.
 *
 * MapLibre (a heavy dependency) and its stylesheet are lazy-imported on mount
 * so they stay out of the entry/chat bundle until a map actually renders.
 */
export const MapWidget = ({ data, title }: MapWidgetProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const collection = useMemo(() => parseFeatureCollection(data), [data])

  useEffect(() => {
    const container = containerRef.current
    if (!collection || !container) {
      return
    }
    // Reset to the skeleton (and clear any prior error) whenever the data
    // changes and we re-init the map, so a recovered load doesn't keep showing
    // a stale "Couldn't load the map" message.
    setReady(false)
    setError(null)
    // MapLibre needs WebGL; probe before loading it so a WebGL-disabled browser
    // gets a clean message instead of MapLibre's raw context-creation error.
    if (!isWebglAvailable()) {
      setError(webglUnavailableMessage)
      return
    }
    let map: MaplibreMap | null = null
    let cancelled = false
    // Whether the map reached `load`, so the `error` handler can tell a fatal
    // init/style failure (surface it) from a post-load tile hiccup (ignore it).
    let loaded = false

    // Keep the canvas sized to its container. Without this, MapLibre renders a
    // blank/white map if it initialized before layout settled or while briefly
    // hidden (e.g. switching away and back to a chat) and is never told to
    // resize. The observer fires on the size change and re-renders at size.
    const resizeObserver = new ResizeObserver(() => map?.resize())
    resizeObserver.observe(container)

    const init = async () => {
      const { Map: MapLib, Popup, NavigationControl } = await import('maplibre-gl')
      await import('maplibre-gl/dist/maplibre-gl.css')
      if (cancelled) {
        return
      }
      map = new MapLib({ container, style: basemap })
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right')

      // If the basemap style/tiles fail (network, 404, CORS), `load` may never
      // fire — surface the failure instead of an endless skeleton. Errors after
      // a successful load (e.g. a single tile) are ignored so a working map
      // isn't replaced by an error message.
      map.on('error', (event) => {
        if (cancelled || loaded) {
          return
        }
        // Log the raw MapLibre detail (e.g. the verbose webglcontextcreationerror
        // object) for debugging, but show the user a clean message.
        console.warn('MapLibre failed to load:', event.error)
        setError(mapLoadFailedMessage)
      })

      // The currently-open popup, so clicking marker after marker replaces it
      // instead of stacking popups.
      let activePopup: MaplibrePopup | null = null

      map.on('load', () => {
        // Bail if the effect was torn down before `load` fired — otherwise we'd
        // touch a removed map or set state on a stale instance.
        if (cancelled || !map) {
          return
        }
        loaded = true
        map.addSource('features', { type: 'geojson', data: collection })
        // Per-feature styling follows the simplestyle-spec (marker-color,
        // marker-size, stroke, fill, …) read generically via `['get', …]` with
        // fallbacks to the defaults. These are standard display keys — the
        // widget reads no domain-specific properties.
        map.addLayer({
          id: 'polygons-fill',
          type: 'fill',
          source: 'features',
          filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
          paint: {
            'fill-color': ['coalesce', ['get', 'fill'], defaultColor],
            'fill-opacity': ['coalesce', ['get', 'fill-opacity'], 0.2],
          },
        })
        map.addLayer({
          id: 'lines',
          type: 'line',
          source: 'features',
          filter: ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']]],
          paint: {
            'line-color': ['coalesce', ['get', 'stroke'], defaultColor],
            'line-width': ['coalesce', ['get', 'stroke-width'], 2],
            'line-opacity': ['coalesce', ['get', 'stroke-opacity'], 1],
          },
        })
        map.addLayer({
          id: 'points',
          type: 'circle',
          source: 'features',
          filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
          paint: {
            'circle-radius': ['match', ['get', 'marker-size'], 'small', 4, 'large', 9, 6],
            'circle-color': ['coalesce', ['get', 'marker-color'], defaultColor],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        })

        const bounds = featureBounds(collection)
        if (bounds) {
          map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 })
        }

        const showPopup = (event: MapLayerMouseEvent) => {
          const feature = event.features?.[0]
          if (!feature || !map) {
            return
          }
          const props = feature.properties as Record<string, unknown> | null
          const label = featureLabel(props)
          const description = typeof props?.description === 'string' ? props.description : null
          if (!label && !description) {
            return
          }
          // The card uses our design tokens (the same `--popover` tokens the
          // app's Popover/Card use). Built via textContent — never innerHTML —
          // so untrusted GeoJSON content (from a model/pipeline) can't inject
          // markup.
          const node = document.createElement('div')
          node.className =
            'rounded-lg border border-border bg-popover px-3.5 py-2.5 text-[length:var(--font-size-sm)] text-popover-foreground shadow-md'
          if (label) {
            const labelNode = document.createElement('div')
            labelNode.className = 'font-semibold text-[length:var(--font-size-body)]'
            labelNode.textContent = label
            node.appendChild(labelNode)
          }
          if (description) {
            const descriptionNode = document.createElement('div')
            descriptionNode.className = 'mt-1 text-muted-foreground'
            descriptionNode.textContent = description
            node.appendChild(descriptionNode)
          }

          // Drop MapLibre's default chrome (white box, shadow, tip, and the
          // unstyled close "×") and let our own card be the whole popup. Closes
          // on map click (MapLibre's default closeOnClick).
          // Replace any open popup so clicking marker after marker swaps the
          // card instead of stacking popups (closeOnClick only fires on a
          // bare-map click, not when clicking another feature).
          activePopup?.remove()
          activePopup = new Popup({ closeButton: false, maxWidth: '300px' })
            .setLngLat(event.lngLat)
            .setDOMContent(node)
            .addTo(map)
          const popupEl = activePopup.getElement()
          const content = popupEl?.querySelector<HTMLElement>('.maplibregl-popup-content')
          if (content) {
            content.style.padding = '0'
            content.style.background = 'transparent'
            content.style.boxShadow = 'none'
            content.style.borderRadius = '0'
          }
          popupEl?.querySelector<HTMLElement>('.maplibregl-popup-tip')?.style.setProperty('display', 'none')
        }

        for (const layer of interactiveLayers) {
          map.on('click', layer, showPopup)
          map.on('mouseenter', layer, () => {
            if (map) {
              map.getCanvas().style.cursor = 'pointer'
            }
          })
          map.on('mouseleave', layer, () => {
            if (map) {
              map.getCanvas().style.cursor = ''
            }
          })
        }

        // Style + first layers are in — swap the skeleton for the map.
        if (!cancelled) {
          setReady(true)
        }
      })
    }

    init().catch((err) => {
      if (!cancelled) {
        console.warn('MapLibre failed to load:', err)
        setError(mapLoadFailedMessage)
      }
    })

    return () => {
      cancelled = true
      resizeObserver.disconnect()
      map?.remove()
    }
  }, [collection])

  if (!collection) {
    return null
  }

  return (
    <div className="my-4">
      {title && <div className="mb-1.5 px-1 font-medium text-[length:var(--font-size-sm)]">{title}</div>}
      <div className="relative h-80 w-full overflow-hidden rounded-lg border border-border">
        <div ref={containerRef} className="h-full w-full" />
        {!ready && !error && <MapSkeleton />}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}
