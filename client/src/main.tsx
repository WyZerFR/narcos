import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// iOS Safari ignore `user-scalable=no` : on bloque aussi les gestes de zoom.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

// Service worker : contexte sécurisé obligatoire (HTTPS ou localhost). Pas en dev HTTP pour
// éviter de servir des modules Vite périmés.
if (
  'serviceWorker' in navigator &&
  window.isSecureContext &&
  (import.meta.env.PROD || import.meta.env.MODE === 'https')
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[pwa] SW refusé', err));
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
