import { useState } from 'react';
import {
  CAMERA_LIMITS,
  CUTOUT_LIMITS,
  gameData,
  type CameraConfig,
  type CutoutConfig,
} from '@narco/shared';
import {
  getCameraConfigs,
  getCameraKind,
  resetCamera,
  updateCamera,
  useCamera,
  type CameraKind,
} from '../game/cameraState';
import { resetCutout, updateCutout, useCutout } from '../game/city/cutout';

/** Plage du zoom : large autour de la valeur de config.json. */
const ZOOM_RANGE = { min: gameData.config.camera.zoom / 4, max: gameData.config.camera.zoom * 4 };

const round1 = (v: number) => Math.round(v * 10) / 10;

const camJson = (c: CameraConfig) => ({
  elevation: round1(c.elevation),
  rotation: round1(c.rotation),
  zoom: round1(c.zoom),
  type: c.type,
  fov: round1(c.fov),
});

/** JSON prêt à coller dans config.json (sections camera, cameraInterior et cutout). */
export function cameraJson(cams: Record<CameraKind, CameraConfig>, cut: CutoutConfig): string {
  return JSON.stringify({
    camera: camJson(cams.street),
    cameraInterior: camJson(cams.interior),
    cutout: { enabled: cut.enabled, radius: round1(cut.radius), softness: round1(cut.softness) },
  });
}

/** Presse-papiers : l'API moderne exige HTTPS ; repli `execCommand` pour http://IP-LAN sur iPad. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // on tente le repli
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, unit, disabled, onChange }: SliderProps) {
  return (
    <label className={`cam-slider${disabled ? ' disabled' : ''}`}>
      <span className="cam-slider-head">
        {label}
        <strong>
          {round1(value)}
          {unit}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Panneau temporaire de réglage caméra (uniquement avec ?debug=1). */
export function CameraPanel() {
  const cam = useCamera();
  const cut = useCutout();
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<{ json: string; ok: boolean } | null>(null);
  // `cam` (via useCamera) fait re-rendre le panneau à chaque changement, de zone compris.
  const json = cameraJson(getCameraConfigs(), cut);
  const where = getCameraKind() === 'street' ? 'rue' : 'intérieur';
  const isOrtho = cam.type === 'ortho';
  // Le message « copié » ne vaut que pour les valeurs actuellement affichées.
  const copy = copied?.json === json ? (copied.ok ? 'ok' : 'fail') : 'idle';

  return (
    <div className={`camera-panel${open ? '' : ' collapsed'}`}>
      <button type="button" className="cam-toggle" onClick={() => setOpen((o) => !o)}>
        📷 Caméra ({where}) {open ? '▴' : '▾'}
      </button>

      {open && (
        <div className="cam-body">
          <Slider
            label="Élévation"
            unit="°"
            step={1}
            {...CAMERA_LIMITS.elevation}
            value={cam.elevation}
            onChange={(elevation) => updateCamera({ elevation })}
          />
          <Slider
            label="Rotation"
            unit="°"
            step={1}
            {...CAMERA_LIMITS.rotation}
            value={cam.rotation}
            onChange={(rotation) => updateCamera({ rotation })}
          />
          <Slider
            label="Zoom"
            unit=" m"
            step={0.5}
            {...ZOOM_RANGE}
            value={cam.zoom}
            onChange={(zoom) => updateCamera({ zoom })}
          />

          <button
            type="button"
            className="btn cam-type"
            onClick={() => updateCamera({ type: isOrtho ? 'perspective' : 'ortho' })}
          >
            <span className={isOrtho ? 'on' : ''}>Ortho</span> /{' '}
            <span className={isOrtho ? '' : 'on'}>Perspective</span>
          </button>

          <Slider
            label="FOV"
            unit="°"
            step={1}
            {...CAMERA_LIMITS.fov}
            value={cam.fov}
            disabled={isOrtho}
            onChange={(fov) => updateCamera({ fov })}
          />

          <div className="cam-section">Découpe des bâtiments</div>
          <button
            type="button"
            className="btn cam-type"
            onClick={() => updateCutout({ enabled: !cut.enabled })}
          >
            <span className={cut.enabled ? 'on' : ''}>Activée</span> /{' '}
            <span className={cut.enabled ? '' : 'on'}>Désactivée</span>
          </button>
          <Slider
            label="Rayon"
            unit=" m"
            step={0.1}
            {...CUTOUT_LIMITS.radius}
            value={cut.radius}
            disabled={!cut.enabled}
            onChange={(radius) => updateCutout({ radius })}
          />
          <Slider
            label="Adoucissement"
            unit=" m"
            step={0.1}
            {...CUTOUT_LIMITS.softness}
            value={cut.softness}
            disabled={!cut.enabled}
            onChange={(softness) => updateCutout({ softness })}
          />

          <div className="cam-values">
            élév. {round1(cam.elevation)}° · rot. {round1(cam.rotation)}° · zoom {round1(cam.zoom)}{' '}
            m · {isOrtho ? 'ortho' : 'perspective'} · FOV {round1(cam.fov)}° · découpe{' '}
            {cut.enabled ? `${round1(cut.radius)} m / ${round1(cut.softness)} m` : 'off'}
          </div>

          <div className="cam-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => void copyText(json).then((ok) => setCopied({ json, ok }))}
            >
              Copier les valeurs
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                resetCamera();
                resetCutout();
              }}
            >
              Défaut
            </button>
          </div>
          {copy === 'ok' && <div className="cam-note">Copié ✓ — à coller dans config.json</div>}
          {copy === 'fail' && (
            <textarea
              className="cam-json"
              readOnly
              value={json}
              onFocus={(e) => e.target.select()}
            />
          )}
        </div>
      )}
    </div>
  );
}
