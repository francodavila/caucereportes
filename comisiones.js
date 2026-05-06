// ============================================================
// CONFIGURACIÓN DE COMISIONES Y RETENCIONES
// ============================================================
// Todos los porcentajes están expresados como NÚMEROS (no decimales).
// Ej: 5.45 significa 5.45%
//
// Si Banco Galicia/Mercado Pago cambia las comisiones, editá este archivo
// y re-deploya. No hay que tocar ningún otro lugar del código.

export const COMISIONES = {
  // Comisión efectiva = comisión base × (1 + IVA 21%)
  debito:       1.45,   // 1.20 + IVA
  credito:      5.45,   // 4.50 + IVA
  qr:           5.45,   // QR Galicia/Modo, tasas de Nave Crédito
  pix:          3.93,   // 3.25 + IVA (Mercado Pago)
  dineroEnCuenta: 0.97, // 0.80 + IVA
  transferencias: 0,    // Sin comisión
  propinas:     5.45,   // Asumimos crédito (la mayoría)
};

// Impuesto a los créditos y débitos bancarios (Ley 25413).
// Se aplica sobre TODO acreditación en cuenta bancaria.
export const IMPUESTO_CREDITO_PCT = 0.6;

// === FUNCIÓN DE CÁLCULO ===
// Recibe un objeto con los cobros del día, devuelve el desglose completo.
export function calcularCajaDiaria(cobros) {
  const c = {
    debito: Number(cobros.debito) || 0,
    credito: Number(cobros.credito) || 0,
    qr: Number(cobros.qr) || 0,
    pix: Number(cobros.pix) || 0,
    dineroEnCuenta: Number(cobros.dineroEnCuenta) || 0,
    transferencias: Number(cobros.transferencias) || 0,
    propinas: Number(cobros.propinas) || 0,
    efectivo: Number(cobros.efectivo) || 0,
    ctaCorriente: Number(cobros.ctaCorriente) || 0,
  };

  // Lo que efectivamente entra al banco hoy
  const ingresoBrutoBanco = c.debito + c.credito + c.qr + c.pix
    + c.dineroEnCuenta + c.transferencias + c.propinas;

  // Comisiones por tipo
  const comisiones = {
    debito: c.debito * COMISIONES.debito / 100,
    credito: c.credito * COMISIONES.credito / 100,
    qr: c.qr * COMISIONES.qr / 100,
    pix: c.pix * COMISIONES.pix / 100,
    dineroEnCuenta: c.dineroEnCuenta * COMISIONES.dineroEnCuenta / 100,
    transferencias: c.transferencias * COMISIONES.transferencias / 100,
    propinas: c.propinas * COMISIONES.propinas / 100,
  };
  const totalComisiones = Object.values(comisiones).reduce((a, b) => a + b, 0);

  // Impuesto al crédito sobre el bruto banco
  const impuestoCredito = ingresoBrutoBanco * IMPUESTO_CREDITO_PCT / 100;

  // Resultado final
  const ingresoNetoBanco = ingresoBrutoBanco - totalComisiones - impuestoCredito;

  // Total operativo del día (para info, incluye lo que NO va al banco)
  const totalOperativo = ingresoBrutoBanco + c.efectivo + c.ctaCorriente;

  return {
    inputs: c,
    ingresoBrutoBanco,
    comisiones,
    totalComisiones,
    impuestoCredito,
    ingresoNetoBanco,
    totalOperativo,
  };
}
