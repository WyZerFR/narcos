import { characterSelectAvailable, openCharacterSelect } from './characterSelectStore';
import { connection } from '../net/connection';
import { QUALITY_PRESETS, updateSettings, useSettings, type Quality } from './settings';

function canFullscreen(): boolean {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  return Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
}

function toggleFullscreen(): void {
  const doc = document as Document & {
    webkitFullscreenElement?: Element;
    webkitExitFullscreen?: () => void;
  };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (document.fullscreenElement || doc.webkitFullscreenElement) {
    if (document.exitFullscreen) void document.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } else if (el.requestFullscreen) {
    void el.requestFullscreen();
  } else {
    el.webkitRequestFullscreen?.();
  }
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { quality, debug } = useSettings();

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <h2>Options</h2>
        <p className="app-version">Version {__APP_VERSION__}</p>

        <div className="setting">
          <span>Qualité graphique</span>
          <div className="segmented">
            {(Object.keys(QUALITY_PRESETS) as Quality[]).map((q) => (
              <button
                key={q}
                type="button"
                className={q === quality ? 'active' : ''}
                onClick={() => updateSettings({ quality: q })}
              >
                {QUALITY_PRESETS[q].label}
              </button>
            ))}
          </div>
        </div>

        <label className="setting check">
          <span>
            Mode debug
            <small>FPS, draw calls, panneau caméra</small>
          </span>
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => updateSettings({ debug: e.target.checked })}
          />
        </label>

        {characterSelectAvailable && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose();
              openCharacterSelect();
            }}
          >
            Changer de personnage
          </button>
        )}
        {characterSelectAvailable && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose();
              openCharacterSelect('colors');
            }}
          >
            Couleurs du personnage
          </button>
        )}

        {canFullscreen() && (
          <button type="button" className="btn" onClick={toggleFullscreen}>
            Plein écran
          </button>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              onClose();
              void connection.leave();
            }}
          >
            Quitter la partie
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
