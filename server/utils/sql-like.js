// Escapa metacaracteres de LIKE (T-SQL) para que el texto del usuario matchee literal.
// Usar junto con `LIKE ... ESCAPE '\'` en la query. La inyección ya la impide el parámetro
// (@input tipado); esto solo evita que %/_/[ del usuario actúen como wildcards.
export const escapeLike = (s) => s.replace(/[\\%_[]/g, (c) => `\\${c}`);
