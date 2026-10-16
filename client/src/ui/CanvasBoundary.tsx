import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
  /** Composant fautif (première ligne de la pile des composants), si React la fournit. */
  component: string | null;
  /** Remontage des enfants à chaque « Réessayer » (clé) ; jamais de relance automatique. */
  attempt: number;
}

/** Nom du premier composant de la pile React (« at BlobShadows (…) » ou « in BlobShadows »). */
export function faultyComponent(stack: string | null | undefined): string | null {
  const m = /(?:at|in) ([A-Z][\w$.]*)/.exec(stack ?? '');
  return m?.[1] ?? null;
}

/**
 * Filet de sécurité autour d'un canvas 3D (aperçu des personnages, scène du jeu) : une exception
 * de rendu affiche un message lisible au lieu d'un canvas vide, et part dans la console avec la
 * pile des composants. En développement, message complet (non minifié) et composant fautif.
 * « Réessayer » remonte les enfants une fois, sur action du joueur seulement.
 */
export class CanvasBoundary extends Component<{ label: string; children: ReactNode }, State> {
  override state: State = { error: null, component: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const component = faultyComponent(info.componentStack);
    if (component !== this.state.component) this.setState({ component });
    console.error(
      `[narco] ${this.props.label} : erreur de rendu 3D${component ? ` dans <${component}>` : ''}`,
      error,
      info.componentStack,
    );
  }

  private retry = () =>
    this.setState((s) => ({ error: null, component: null, attempt: s.attempt + 1 }));

  override render() {
    const { error, component, attempt } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <div className="canvas-error" role="alert">
        <strong>{this.props.label} indisponible</strong>
        {import.meta.env.DEV && component && <span>Composant : {component}</span>}
        <span>{error.message}</span>
        <button type="button" className="btn" onClick={this.retry}>
          Réessayer
        </button>
      </div>
    );
  }
}
