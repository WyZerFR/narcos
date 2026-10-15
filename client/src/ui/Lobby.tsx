import { useEffect, useState } from 'react';
import { gameData, MAX_NAME_LENGTH } from '@narco/shared';
import { connection, fetchServerInfo, type Snapshot } from '../net/connection';
import { getAccessCode, getSavedName, saveAccessCode } from '../net/identity';

const { codeLength } = gameData.config.room;

export function Lobby({ snapshot }: { snapshot: Snapshot }) {
  const [name, setName] = useState(getSavedName);
  const [code, setCode] = useState('');
  const [access, setAccess] = useState(getAccessCode);
  const [accessRequired, setAccessRequired] = useState(false);
  const busy = snapshot.status === 'connecting';
  useEffect(() => {
    let alive = true;
    void fetchServerInfo().then((info) => alive && setAccessRequired(info.accessRequired));
    return () => {
      alive = false;
    };
  }, []);
  // le code est gardé (reconnexions) puis vérifié par le serveur
  const missing = accessRequired && access.trim() === '';

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

      {accessRequired && (
        <label className="field">
          <span>Code d'accès</span>
          <input
            value={access}
            type="password"
            autoComplete="off"
            placeholder="Demande-le à l'hôte"
            onChange={(e) => {
              setAccess(e.target.value);
              saveAccessCode(e.target.value.trim());
            }}
          />
        </label>
      )}

      <div className="lobby-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || missing}
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
          <button
            type="submit"
            className="btn"
            disabled={busy || missing || code.length !== codeLength}
          >
            Rejoindre
          </button>
        </form>
      </div>

      {busy && <p className="status">Connexion…</p>}
      {snapshot.error && <p className="error">{snapshot.error}</p>}
    </div>
  );
}
