// D-054 — gate de UI del atajo "Ir a GEC3/GEC32".
//
// El botón solo debe existir para los cargos con `puede_cambiar_unidad` (JdT / Operador Analista).
// El enforcement real vive en el backend (`server/tests/cambiar_unidad.test.js`); esto fija la otra
// mitad del contrato: que la UI no ofrezca lo que el server va a negar, y que no se le escape a
// nadie más. Ambos lados leen el MISMO flag de la sesión, así que no pueden divergir.

import { describe, it, expect } from 'vitest';
import { resolverOtraUnidad } from './unidades';

const PLANTAS = [
  { planta_id: 'GEC3', nombre: 'Gecelca 3' },
  { planta_id: 'GEC32', nombre: 'Gecelca 3.2' },
];

const sesionEn = (planta_id, extra = {}) => ({ planta_id, puede_cambiar_unidad: true, ...extra });

describe('resolverOtraUnidad — quién ve el atajo', () => {
  it('con permiso desde GEC3 → ofrece GEC32 (con su nombre para el aria-label)', () => {
    expect(resolverOtraUnidad(sesionEn('GEC3'), PLANTAS)).toEqual({
      planta_id: 'GEC32', nombre: 'Gecelca 3.2',
    });
  });

  it('con permiso desde GEC32 → ofrece GEC3 (simétrico)', () => {
    expect(resolverOtraUnidad(sesionEn('GEC32'), PLANTAS)).toEqual({
      planta_id: 'GEC3', nombre: 'Gecelca 3',
    });
  });

  it('SIN el permiso → no hay atajo, sin importar la planta', () => {
    expect(resolverOtraUnidad(sesionEn('GEC3', { puede_cambiar_unidad: false }), PLANTAS)).toBeNull();
  });

  it('el permiso ausente NO habilita (un cargo viejo servido sin el flag no gana el botón)', () => {
    expect(resolverOtraUnidad({ planta_id: 'GEC3' }, PLANTAS)).toBeNull();
  });

  it('solo `true` habilita: un 1 de la BD o un string no bastan', () => {
    // Blindaje contra un cambio de serialización (BIT → 1) que "encendería" el botón en silencio.
    expect(resolverOtraUnidad(sesionEn('GEC3', { puede_cambiar_unidad: 1 }), PLANTAS)).toBeNull();
    expect(resolverOtraUnidad(sesionEn('GEC3', { puede_cambiar_unidad: 'true' }), PLANTAS)).toBeNull();
  });

  it('sin sesión → no hay atajo (LoginScreen no muestra navbar)', () => {
    expect(resolverOtraUnidad(null, PLANTAS)).toBeNull();
  });

  it('catálogo aún sin cargar → no hay atajo (no inventa un destino)', () => {
    expect(resolverOtraUnidad(sesionEn('GEC3'), [])).toBeNull();
    expect(resolverOtraUnidad(sesionEn('GEC3'), undefined)).toBeNull();
  });

  it('con 3+ unidades "la otra" es ambigua → se oculta en vez de elegir al azar', () => {
    const tres = [...PLANTAS, { planta_id: 'GEC4', nombre: 'Futura' }];
    expect(resolverOtraUnidad(sesionEn('GEC3'), tres)).toBeNull();
  });

  it('la planta de test no llega al catálogo, pero si llegara sería un destino ambiguo → sin atajo', () => {
    // Defensa en profundidad: /api/catalogos/plantas ya filtra TST (D-030) y el backend la rechaza
    // (validarPlantaOperable). Aun así, la UI tampoco debe ofrecerla nunca como destino.
    const conTst = [...PLANTAS, { planta_id: 'TST', nombre: 'Test Synthetic' }];
    expect(resolverOtraUnidad(sesionEn('GEC3'), conTst)).toBeNull();
  });
});
