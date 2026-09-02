// GUARD ESTÁTICO — las salidas que pueden perder el borrador de la configuración anual pasan
// TODAS por la misma puerta, y el componente está cableado a la que la alimenta.
//
// Por qué un guard y no un test de comportamiento: lo que hay que fijar es el **cableado** del
// componente raíz, y montar `BitacorasGecelca3` exige auth, catálogos, WS y media docena de hooks
// con red. El GATE-O5 encontró dos agujeros que ningún test de los que había podía ver, y los dos
// son de cableado:
//
//   · **CR5-1** — L14 guardó `handleIrAUnidad` (el ATAJO del navbar, D-054) creyendo que era
//     "Cambiar de unidad". El ítem del menú que se llama así es `handleCambiarUnidad`, y estaba sin
//     guarda. Peor: el atajo solo existe con `cargo.puede_cambiar_unidad = 1`, y los dos cargos que
//     pueden configurar la rotación lo tienen en 0 (`db.js`), así que para ellos la guarda del
//     cambio de unidad era código inalcanzable y la salida real estaba abierta.
//   · **CR5-9** — `onDirtyChange={setRotacionDirty}` es el ÚNICO punto donde se encuentran las dos
//     mitades del arreglo, y borrarlo dejaba la suite entera en verde.
//
// Es el mismo patrón que `guard_marcador_reflejo.test.js` en el backend: cuando N puntos tienen que
// cambiar juntos y nada en el lenguaje los ata, se atan con un guard.
//
// GOTCHA (D-055, y acá muerde igual): el stripper de comentarios parte con `/\r?\n/`. Con
// `.split('\n')` queda un `\r` al final de cada línea y, como el `.` de una regex JS **no matchea
// `\r`**, `//.*$` no engancha nunca y el strip queda INERTE — el guard pasaría leyendo los
// comentarios como si fueran código, que es justo lo que no puede hacer: este archivo nombra
// `salirDeRotacion` en su prosa a cada rato.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../BitacorasGecelca3.jsx', import.meta.url));

function sinComentarios(src) {
  const sinBloques = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return sinBloques.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

const CODIGO = sinComentarios(readFileSync(RAIZ, 'utf8'));

// El cuerpo de un handler: desde su declaración hasta la siguiente `const` del componente. No es
// una ventana de N caracteres —la del guard de D-055 se quedó corta con un batch largo— sino un
// límite que el propio código define.
function cuerpoDe(nombre) {
  const inicio = CODIGO.indexOf(`const ${nombre} = `);
  expect(inicio, `no existe el handler ${nombre} en BitacorasGecelca3.jsx`).toBeGreaterThan(-1);
  const resto = CODIGO.slice(inicio + 10);
  const fin = resto.indexOf('\n  const ');
  return fin === -1 ? resto : resto.slice(0, fin);
}

describe('guard · toda salida que desmonta la configuración anual pasa por la guarda (CR5-1)', () => {
  // Las cuatro que cambian `vista` y la del menú que mata la sesión de app. Si mañana alguien
  // agrega una entrada nueva al `HeaderMenu`, la forma de enterarse es agregarla acá y ver el rojo.
  const SALIDAS = [
    'handleIrARotacion',        // menú → Rotación de turnos
    'handleIrACumplimiento',    // menú → Cumplimiento de rotación
    'handleToggleVista',        // menú → "Ver bitácoras" / "Ver históricos"
    'handleCambiarUnidad',      // menú → "Cambiar de unidad" (clearSesion → LoginScreen)
  ];

  for (const nombre of SALIDAS) {
    it(`${nombre} consulta la guarda antes de navegar`, () => {
      expect(cuerpoDe(nombre)).toContain('salirDeRotacion(');
    });
  }

  // El atajo del navbar (D-054) no navega: BLOQUEA, porque el cambio en caliente no desmonta nada.
  // Por eso usa la regla directamente en vez de la puerta, y aun así tiene que consultarla.
  it('handleIrAUnidad consulta la regla, aunque bloquee en vez de confirmar', () => {
    const cuerpo = cuerpoDe('handleIrAUnidad');
    expect(cuerpo).toContain('planearSalidaDeRotacion(');
    expect(cuerpo).toContain("destino: 'unidad'");
  });

  // La declaración tiene que ir ANTES del primer consumidor: las deps de un `useCallback` se
  // evalúan en cada render, así que referenciar una `const` de más abajo revienta por TDZ.
  it('la guarda se declara antes de su primer consumidor', () => {
    expect(CODIGO.indexOf('const salirDeRotacion = '))
      .toBeLessThan(CODIGO.indexOf('const handleCambiarUnidad = '));
  });
});

describe('guard · el componente está cableado a la guarda (CR5-9)', () => {
  // Sin esta línea la guarda nunca se entera de nada y la suite sigue en verde de punta a punta:
  // los casos del componente prueban que reporta, y los de la regla que decide, pero nadie prueba
  // que el reporte llegue a la decisión.
  it('ConfiguracionRotacion recibe onDirtyChange', () => {
    expect(CODIGO).toMatch(/<ConfiguracionRotacion[\s\S]*?onDirtyChange=\{setRotacionDirty\}/);
  });

  it('y el flag que alimenta es el que la guarda consulta', () => {
    expect(cuerpoDe('salirDeRotacion')).toContain('hayBorrador: rotacionDirty');
  });
});

// Meta-test del propio guard: si el stripper queda inerte, todo lo de arriba pasa leyendo prosa.
describe('guard · el stripper de comentarios funciona (gotcha de D-055)', () => {
  it('quita comentarios de línea aunque el archivo venga con CRLF', () => {
    expect(sinComentarios('const a = 1; // salirDeRotacion(\r\nconst b = 2;\r\n'))
      .not.toContain('salirDeRotacion(');
  });

  it('quita bloques /* */ multilínea', () => {
    expect(sinComentarios('/* salirDeRotacion(\n   sigue */ const a = 1;'))
      .not.toContain('salirDeRotacion(');
  });
});
