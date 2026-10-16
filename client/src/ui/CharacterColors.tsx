import { useState } from 'react';
import {
  ClientMsg,
  gameData,
  randomAppearance,
  slotsOf,
  type Appearance,
  type AppearanceSetMessage,
  type CharacterChooseMessage,
} from '@narco/shared';
import type { GameRoom } from '../net/connection';
import { useCharacterAsset } from '../game/characters/characterAssets';
import { PreviewCanvas } from './CharacterSelect';
import { closeCharacterSelect } from './characterSelectStore';

/**
 * Personnalisation : aperçu 3D et une rangée de pastilles par slot du modèle (teintes de
 * palettes.json). Rien n'est envoyé avant « Valider » ; le serveur revalide tout.
 */
export function CharacterColors({
  room,
  code,
  characterId,
  initial,
  onBack,
}: {
  room: GameRoom;
  code: string | null;
  characterId: string;
  initial: Appearance;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<Appearance>(initial);
  const asset = useCharacterAsset(characterId);
  const character = gameData.characters.get(characterId);
  const slots = slotsOf(gameData, characterId);
  const validate = () => {
    if (room.connection.isOpen) {
      room.send(ClientMsg.CharacterChoose, { characterId } satisfies CharacterChooseMessage);
      room.send(ClientMsg.AppearanceSet, { appearance: draft } satisfies AppearanceSetMessage);
    }
    closeCharacterSelect(code ?? undefined);
  };
  return (
    <div className="character-select">
      <h2>{character?.name ?? 'Personnage'} : couleurs</h2>
      <div className="character-colors">
        <div className="character-stage selected">
          <PreviewCanvas
            asset={typeof asset === 'object' ? asset : null}
            appearance={draft}
            failed={asset === 'error'}
          />
          {asset === 'loading' && <span className="character-status">Chargement…</span>}
        </div>
        <div className="swatch-rows">
          {slots.length === 0 && <p>Ce personnage n’a pas de couleurs à changer.</p>}
          {slots.map((slot) => (
            <div key={slot.id} className="swatch-row">
              <span className="swatch-label">{slot.name}</span>
              {slot.swatches.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`swatch${draft[slot.id] === s.id ? ' selected' : ''}`}
                  style={{ background: s.color }}
                  aria-label={`${slot.name} : ${s.name}`}
                  aria-pressed={draft[slot.id] === s.id}
                  onClick={() => setDraft({ ...draft, [slot.id]: s.id })}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="character-actions">
        <button
          type="button"
          className="btn"
          onClick={() => setDraft(randomAppearance(gameData, characterId))}
        >
          Aléatoire
        </button>
        <button type="button" className="btn" onClick={() => setDraft({})}>
          Réinitialiser
        </button>
        <button type="button" className="btn primary" onClick={validate}>
          Valider
        </button>
        <button type="button" className="btn" onClick={onBack}>
          Retour
        </button>
      </div>
    </div>
  );
}
