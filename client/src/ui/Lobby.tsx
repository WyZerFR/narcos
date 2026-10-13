import { useState } from 'react';
import { gameData, MAX_NAME_LENGTH } from '@narco/shared';
import { connection, type Snapshot } from '../net/connection';
import { getSavedName } from '../net/identity';

const { codeLength } = gameData.config.room;

export function Lobby({ snapshot }: { snapshot: Snapshot }) {
  const [name, setName] = useState(getSavedName);
  const [code, setCode] = useState('');
  const busy = snapshot.status === 'connecting';

  return (
    <div className="lobby">
      <h1 className="logo">
        NARCO<span>-WEB</span>
      </h1>
      <p className="tagline">Trois potes, un quartier, zéro scrupule.</p>

      <label className="field">
        <span>Ton blaze</span>
        <input
          value={name}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          placeholder="Pseudo"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="lobby-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => void connection.create(name)}
        >
          Créer une partie
        </button>

        <form
          className="join-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connection.join(code, name);
          }}
        >
          <input
            className="code-input"
            value={code}
            maxLength={codeLength}
            placeholder={'X'.repeat(codeLength)}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="btn" disabled={busy || code.length !== codeLength}>
            Rejoindre
          </button>
        </form>
      </div>

      {busy && <p className="status">Connexion…</p>}
      {snapshot.error && <p className="error">{snapshot.error}</p>}
    </div>
  );
}
