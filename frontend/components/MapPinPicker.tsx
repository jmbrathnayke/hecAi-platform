"use client";
// Manual location fallback (FR-1.6) when GPS is unavailable. A draggable / click-to-move
// marker on a Leaflet map; emits the chosen {lat, lng} on confirm.
// NOTE: must be loaded via `dynamic(() => import(...), { ssr: false })` — Leaflet touches
// `window` and cannot render during SSR.
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useState } from "react";
import { MapContainer, Marker, TileLayer, useMapEvents } from "react-leaflet";

export interface LatLng {
  lat: number;
  lng: number;
}

interface MapPinPickerProps {
  initial: LatLng;
  confirmLabel: string;
  onConfirm: (coords: LatLng) => void;
}

// CSS-only marker (no image asset → no bundler/offline icon breakage).
const pinIcon = L.divIcon({
  className: "",
  html: '<div style="font-size:28px;line-height:1">📍</div>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
});

function ClickToPlace({ onMove }: { onMove: (c: LatLng) => void }) {
  useMapEvents({
    click(e) {
      onMove({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

export default function MapPinPicker({ initial, confirmLabel, onConfirm }: MapPinPickerProps) {
  const [pos, setPos] = useState<LatLng>(initial);

  return (
    <div className="flex flex-col gap-design-3">
      <div className="h-64 w-full overflow-hidden rounded-md border border-border-default">
        <MapContainer
          center={[pos.lat, pos.lng]}
          zoom={8}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickToPlace onMove={setPos} />
          <Marker
            position={[pos.lat, pos.lng]}
            icon={pinIcon}
            draggable
            eventHandlers={{
              dragend: (e) => {
                const ll = (e.target as L.Marker).getLatLng();
                setPos({ lat: ll.lat, lng: ll.lng });
              },
            }}
          />
        </MapContainer>
      </div>
      <p className="text-center text-caption text-ink-secondary">
        {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
      </p>
      <button
        type="button"
        onClick={() => onConfirm(pos)}
        className="flex min-h-touch-target items-center justify-center rounded-md bg-forest px-design-5 text-label font-semibold text-ink-on-dark transition-opacity hover:opacity-90"
      >
        {confirmLabel}
      </button>
    </div>
  );
}
