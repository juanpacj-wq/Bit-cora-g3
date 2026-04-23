"""
One-shot script: generates personal-2026.json from LISTADO DE PERSONAL 2026.xlsx.

Rules (approved plan):
- nombre_completo stored as "NOMBRE NOMBRE APELLIDO APELLIDO" (nombre-first), uppercase, diacritics preserved.
- username = lowercase ASCII (diacritics stripped, Ñ→N); base = 1st_initial_of_1st_nombre + 1st_apellido_completo.
- Collision (FLOREZ x3): add initial of 2nd nombre between initial of 1st nombre and apellido.
- Manual overrides for inverted-order rows (Excel rows 17, 37) and compound apellido (Excel row 61).
- Cargo mapped to canonical seed names.
- es_jefe_planta = True only for Ernesto (Gerente de Producción, Excel row 3).
- es_jdt_default  = True only for Omar Fedullo (Excel row 6).
"""
import openpyxl, unicodedata, re, json, os, sys
from collections import Counter

XLSX = r'C:/Users/jcespedes/Documents/Code/desarrollo/GC3/PORTAL GENERACIÓN/Bit-cora-g3/LISTADO DE PERSONAL 2026.xlsx'
OUT  = r'C:/Users/jcespedes/Documents/Code/desarrollo/GC3/PORTAL GENERACIÓN/Bit-cora-g3/server/data/personal-2026.json'

CARGO_MAP = {
    'GERENTE DE PRODUCCIÓN':                'Gerente de Producción',
    'INGENIERO JEFE DE TURNO':              'Ingeniero Jefe de Turno',
    'INGENIERO QUÍMICO':                    'Ingeniero Químico',
    'INGENIERO DE OPERACIÓN':               'Ingeniero de Operación',
    'OPERADOR DE PLANTA - CALDERA':         'Operador de Planta - Caldera',
    'OPERADOR DE PLANTA - ANALISTA':        'Operador de Planta - Analista',
    'OPERADOR DE PLANTA - SALA DE MANDO':   'Operador de Planta - Sala de Mando',
    'OPERADOR DE PLANTA- PLANTA DE AGUA':   'Operador de Planta - Planta de Agua',
    'OPERADOR DE PLANTA - TURBOGRUPO':      'Operador de Planta - Turbogrupo',
    'OPERADOR MAQUINARIA PESADA':           'Operador Maquinaria Pesada',
    'OPERADOR DE PLANTA -  CARBÓN Y CALIZA': 'Operador de Planta - Carbón y Caliza',
    'OPERADOR DE PLANTA - CARBÓN Y CALIZA':  'Operador de Planta - Carbón y Caliza',
}

# Manual overrides keyed by PERSON NUMBER (row[0] in Excel, column "No.")
# Covers: compound 2nd nombre ("DE JESUS"), inverted order, compound apellido ("DE LA OSSA", "DE LEON").
MANUAL = {
    6:  {'nombres': ['AMARILDO', 'DE JESUS'],  'apellidos': ['REALES', 'SILVERA']},
    17: {'nombres': ['MARCELINO', 'MANUEL'],   'apellidos': ['VILLADIEGO', 'ARRIETA']},
    37: {'nombres': ['CARLOS', 'ANDRÉS'],      'apellidos': ['GARCÍA', 'MARTÍNEZ']},
    44: {'nombres': ['JONATHAN', 'XAVIER'],    'apellidos': ['PADILLA DE LEON']},
    61: {'nombres': ['ANDRES', 'ALBERTO'],     'apellidos': ['MARTINEZ DE LA OSSA']},
}

def ascii_lower(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')
    return re.sub(r'[^A-Za-z]', '', s).lower()

def parse_person(person_num, raw_name):
    full = re.sub(r'\s+', ' ', (raw_name or '').strip())
    toks = full.split()
    if person_num in MANUAL:
        nombres   = MANUAL[person_num]['nombres']
        apellidos = MANUAL[person_num]['apellidos']
    else:
        # Default: APELLIDO1 APELLIDO2 NOMBRE1 [NOMBRE2]
        if len(toks) == 4:
            apellidos, nombres = toks[:2], toks[2:]
        elif len(toks) == 3:
            apellidos, nombres = toks[:2], toks[2:]
        elif len(toks) >= 5:
            apellidos, nombres = toks[:-2], toks[-2:]
        else:
            apellidos, nombres = ([toks[0]] if toks else ['?']), (toks[1:] or ['?'])
    return nombres, apellidos

def main():
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    ws = wb['Listado de personal']
    rows = list(ws.iter_rows(values_only=True))

    # Person numbers (column "No." in Excel) used for flag assignment.
    OMAR_PNUM, ERNESTO_PNUM = 4, 1   # Omar is person #4, Ernesto is person #1
    people = []
    for row in rows:
        if not row or not row[0] or not isinstance(row[0], int):
            continue
        person_num = row[0]
        full_raw  = (row[1] or '').strip()
        cargo_raw = re.sub(r'\s+', ' ', (row[3] or '').strip())
        cargo = CARGO_MAP.get(cargo_raw) or CARGO_MAP.get(row[3].strip() if row[3] else '')
        if cargo is None:
            cargo = next((v for k, v in CARGO_MAP.items() if k.replace(' ', '') == cargo_raw.replace(' ', '')), None)
        if cargo is None:
            print(f"!!! UNMAPPED CARGO at person {person_num}: {row[3]!r}", file=sys.stderr)
            sys.exit(2)
        nombres, apellidos = parse_person(person_num, full_raw)
        nombre_completo = ' '.join(nombres + apellidos)
        username_base = ascii_lower(nombres[0])[:1] + ascii_lower(apellidos[0])
        people.append({
            'person_num': person_num,
            'nombres': nombres,
            'apellidos': apellidos,
            'nombre_completo': nombre_completo,
            'username_base': username_base,
            'cargo': cargo,
            'es_jefe_planta': person_num == ERNESTO_PNUM,
            'es_jdt_default': person_num == OMAR_PNUM,
        })

    cnt = Counter(p['username_base'] for p in people)
    dupes = {u for u, c in cnt.items() if c > 1}
    for p in people:
        if p['username_base'] in dupes and len(p['nombres']) >= 2:
            p['username'] = (
                ascii_lower(p['nombres'][0])[:1]
                + ascii_lower(p['nombres'][1])[:1]
                + ascii_lower(p['apellidos'][0])
            )
        else:
            p['username'] = p['username_base']

    final = Counter(p['username'] for p in people)
    if any(c > 1 for c in final.values()):
        print("!!! STILL COLLIDING:", {u: c for u, c in final.items() if c > 1}, file=sys.stderr)
        sys.exit(3)

    output = [{
        'nombre_completo': p['nombre_completo'],
        'username': p['username'],
        'cargo': p['cargo'],
        'es_jefe_planta': p['es_jefe_planta'],
        'es_jdt_default': p['es_jdt_default'],
    } for p in people]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Wrote {len(output)} people to {OUT}")
    print(f"Colliding base usernames resolved: {sorted(dupes)}")
    for p in output:
        if 'florez' in p['username']:
            print(f"  FLOREZ: {p['username']:10s}  {p['nombre_completo']}")
    print("\nManual-override persons (6, 17, 37, 44, 61):")
    # output preserves iteration order = person number order starting from 1
    for pnum in (6, 17, 37, 44, 61):
        p = output[pnum - 1]
        print(f"  person {pnum}: {p['username']:10s}  {p['nombre_completo']:45s}  {p['cargo']}")

if __name__ == '__main__':
    main()
