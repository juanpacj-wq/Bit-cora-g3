// F21.D: setup mínimo de vitest para helpers de fecha. `environment: 'node'` porque las
// pruebas no tocan DOM — Intl.DateTimeFormat funciona idéntico en Node y jsdom y el primero
// es ~3x más rápido. Si en F22 se agregan tests de componentes con RTL, cambiar a 'jsdom'.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // D-050: JSX runtime automático, igual que @vitejs/plugin-react en la app. Sin esto, esbuild
  // (vitest) compila .jsx al runtime clásico (React.createElement) y todo componente que no haga
  // `import React` explícito revienta con "React is not defined" al importarse desde un test.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.{js,jsx}'],
  },
});
