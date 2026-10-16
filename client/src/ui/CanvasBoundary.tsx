import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Filet de sécurité autour d'un canvas 3D (aperçu des personnages, scène du jeu) : une exception
 * de rendu affiche un message lisible au lieu d'un canvas vide, et part dans la console.
 */
export class CanvasBoundary extends Component<
  { label: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[narco] ${this.props.label} : erreur de rendu 3D`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="canvas-error" role="alert">
        <strong>{this.props.label} indisponible</strong>
        <span>{this.state.error.message}</span>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Réessayer
        </button>
      </div>
    );
  }
}
