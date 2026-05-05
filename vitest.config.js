// F21.D: setup mínimo de vitest para helpers de fecha. `environment: 'node'` porque las
// pruebas no tocan DOM — Intl.DateTimeFormat funciona idéntico en Node y jsdom y el primero
// es ~3x más rápido. Si en F22 se agregan tests de componentes con RTL, cambiar a 'jsdom'.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.{js,jsx}'],
  },
});
