// ============================================================
// CAJA · vista en el informe (lee desde Firestore)
// ============================================================
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getFirestore, collection, getDocs, doc, getDoc, query, orderBy } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// Reusar la app si ya fue inicializada por integracion-informe.js
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

// Estado
let CAJA_DATA = {
  saldoInicial: 4000000,
  fechaSaldo: null,
  cheques: [],
  cajasDiarias: {}, // { 'YYYY-MM-DD': { ingresoNetoBanco, ventaTotal, ... } }
  patronCaja: {},   // promedio por día de semana
};
let cajaMesActual = new Date();
cajaMesActual.setDate(1);

// ============================================================
// CARGA DE DATOS
// ============================================================
async function cargarTodoCaja() {
  try {
    const [cfgSnap, chSnap, cdSnap] = await Promise.all([
      getDoc(doc(db, 'config', 'banco')),
      getDocs(query(collection(db, 'cheques'), orderBy('fecha', 'asc'))),
      getDocs(query(collection(db, 'cajas_diarias'), orderBy('fecha', 'asc'))),
    ]);

    if (cfgSnap.exists()) {
      const cfg = cfgSnap.data();
      CAJA_DATA.saldoInicial = cfg.saldoActual || 4000000;
      CAJA_DATA.fechaSaldo = cfg.fechaSaldo || null;
    }

    CAJA_DATA.cheques = [];
    chSnap.forEach(d => CAJA_DATA.cheques.push({ _id: d.id, ...d.data() }));

    CAJA_DATA.cajasDiarias = {};
    const cajasArray = [];
    cdSnap.forEach(d => {
      const data = d.data();
      CAJA_DATA.cajasDiarias[data.fecha] = data;
      cajasArray.push(data);
    });

    // Patrón promedio por día de semana basado en los últimos 30 días con datos
    CAJA_DATA.patronCaja = calcularPatronSemanal(cajasArray);

    // Posicionar el calendario en el mes que tenga la fecha de saldo (o hoy)
    const ref = CAJA_DATA.fechaSaldo ? new Date(CAJA_DATA.fechaSaldo + 'T00:00:00') : new Date();
    cajaMesActual = new Date(ref.getFullYear(), ref.getMonth(), 1);

    renderCajaCompleta();
  } catch (e) {
    console.warn('[Cauce caja-vista] No se pudo cargar:', e);
  }
}

function calcularPatronSemanal(cajasArray) {
  const acum = [0,0,0,0,0,0,0];
  const cnt = [0,0,0,0,0,0,0];
  // Usar últimos 30 días
  const recientes = cajasArray.slice(-30);
  for (const c of recientes) {
    const d = new Date(c.fecha + 'T00:00:00');
    const dow = d.getDay();
    const ingreso = (c.calculado && c.calculado.ingresoNetoBanco) || 0;
    if (ingreso > 0) {
      acum[dow] += ingreso;
      cnt[dow] += 1;
    }
  }
  const patron = {};
  for (let i = 0; i < 7; i++) {
    patron[i] = cnt[i] > 0 ? acum[i] / cnt[i] : 0;
  }
  return patron;
}

// ============================================================
// CÁLCULO DE FLUJO Y PROYECCIÓN
// Lógica de rolling: cheques "emitidos" cuya fecha de pago ya pasó
// y todavía no se pagaron/rechazaron, ruedan al próximo día hábil
// (saltea sábado y domingo). A los 30 días sin pagarse → vencido auto.
// ============================================================

function esDiaHabil(d) {
  const dow = d.getDay();
  return dow !== 0 && dow !== 6; // 0=Dom, 6=Sáb
}

function proximoDiaHabil(d) {
  const r = new Date(d);
  do {
    r.setDate(r.getDate() + 1);
  } while (!esDiaHabil(r));
  return r;
}

function diasEntre(desdeISO, hastaISO) {
  const a = new Date(desdeISO + 'T00:00:00');
  const b = new Date(hastaISO + 'T00:00:00');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// Devuelve la fecha "vigente" del cheque para el flujo proyectado:
// - Si pagado/rechazado/vencido → su fecha original (irrelevante para flujo)
// - Si emitido y fecha ya pasó:
//     - Si ya pasaron 30 días desde la fecha original → "vencido" (no cuenta en flujo)
//     - Si no, rueda al próximo día hábil después de hoy
// - Si emitido y fecha futura → su fecha original
function fechaProyectadaCheque(ch, hoyISO) {
  if (ch.estado !== 'emitido') return null;
  const fechaPago = ch.fecha;
  if (!fechaPago) return null;
  // Si ya pasaron más de 30 días desde la fecha de pago → vencido auto
  if (diasEntre(fechaPago, hoyISO) > 30) return null;
  // Si la fecha es hoy o futura, mantener
  if (fechaPago >= hoyISO) return fechaPago;
  // Si la fecha pasó pero está dentro de los 30 días → rueda a próximo día hábil
  let proxima = new Date(hoyISO + 'T00:00:00');
  if (!esDiaHabil(proxima)) proxima = proximoDiaHabil(proxima);
  return ymdISO(proxima);
}

// Verifica si un cheque emitido debería marcarse como vencido (visualmente)
function chequeVencidoAuto(ch, hoyISO) {
  return ch.estado === 'emitido' && diasEntre(ch.fecha, hoyISO) > 30;
}

function calcularFlujoDia(fechaISO, hoyISO) {
  const cajaDia = CAJA_DATA.cajasDiarias[fechaISO];
  let ingreso = 0;
  let ingresoReal = false;

  if (cajaDia && cajaDia.calculado) {
    // Hay caja real cargada → usar el dato real
    ingreso = cajaDia.calculado.ingresoNetoBanco || 0;
    ingresoReal = true;
  } else if (fechaISO > hoyISO) {
    // Día futuro sin caja cargada → usar patrón promedio
    const dow = new Date(fechaISO + 'T00:00:00').getDay();
    ingreso = CAJA_DATA.patronCaja[dow] || 0;
  }
  // Día pasado o de hoy sin caja cargada: ingreso = 0 (no proyectar para atrás)

  let chequesDelDia = [];
  let chequesPagadosDelDia = [];

  if (fechaISO < hoyISO) {
    // DÍAS PASADOS: solo cheques que SE PAGARON ese día (debitaron del banco)
    chequesPagadosDelDia = CAJA_DATA.cheques.filter(ch => {
      if (ch.estado !== 'pagado') return false;
      const f = ch.fechaPagoReal || ch.pagoEnBanco;
      return f === fechaISO;
    });
    chequesDelDia = chequesPagadosDelDia;
  } else {
    // HOY o FUTURO: cheques emitidos pendientes (con rolling)
    chequesDelDia = CAJA_DATA.cheques.filter(ch => {
      const fp = fechaProyectadaCheque(ch, hoyISO);
      return fp === fechaISO;
    });
    // Adicionalmente, si hoy hay cheques pagados HOY, también incluirlos como info
    if (fechaISO === hoyISO) {
      chequesPagadosDelDia = CAJA_DATA.cheques.filter(ch => {
        if (ch.estado !== 'pagado') return false;
        const f = ch.fechaPagoReal || ch.pagoEnBanco;
        return f === hoyISO;
      });
    }
  }

  const egresos = chequesDelDia.reduce((s, ch) => s + (ch.monto || 0), 0);
  return { ingreso, ingresoReal, cheques: chequesDelDia, chequesPagadosDelDia, egresos };
}

function calcularProyeccion(desde, hasta) {
  // Devuelve { fecha: { ingreso, egresos, saldo, ... } }
  // Reglas:
  //  - Antes de la fecha del saldo conocido: NO se proyecta saldo (saldo = null)
  //  - Desde la fecha del saldo conocido en adelante: se acumula
  //  - Para días pasados, solo cuenta lo realmente cargado/pagado
  //  - Para días futuros, se usa el patrón + cheques rolling
  const flujo = {};
  const hoyISO = ymdISO(new Date());
  const fechaSaldoStr = CAJA_DATA.fechaSaldo;
  let saldo = CAJA_DATA.saldoInicial;
  let saldoArrancado = false;

  // Si la ventana 'desde' es anterior a la fechaSaldo, los días previos
  // se renderizan sin saldo (solo info de cheques pagados/cajas reales).
  for (let d = new Date(desde); d <= hasta; d.setDate(d.getDate() + 1)) {
    const fs = ymdISO(d);
    const flu = calcularFlujoDia(fs, hoyISO);

    if (!saldoArrancado && fechaSaldoStr && fs >= fechaSaldoStr) {
      saldoArrancado = true;
      saldo = CAJA_DATA.saldoInicial;
    }

    if (saldoArrancado) {
      saldo += flu.ingreso - flu.egresos;
      flujo[fs] = { ...flu, saldo, fecha: fs };
    } else {
      flujo[fs] = { ...flu, saldo: null, fecha: fs };
    }
  }
  return flujo;
}

function ymdISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ============================================================
// FORMATTERS
// ============================================================
function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  if (n === 0) return '—';
  const abs = Math.abs(n);
  const fmt = '$' + Math.round(abs).toLocaleString('es-AR');
  return n < 0 ? '(' + fmt + ')' : fmt;
}
function fmtMoneyCompact(n) {
  if (!n) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1) + 'M';
  if (abs >= 1000) return sign + '$' + (abs / 1000).toFixed(0) + 'k';
  return sign + '$' + Math.round(abs);
}
function fmtFechaCorta(iso) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)}/${parseInt(m, 10)}`;
}
function diaSemana(iso) {
  return ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][new Date(iso + 'T00:00:00').getDay()];
}

// ============================================================
// RENDER
// ============================================================
function renderCajaCompleta() {
  renderKpis();
  renderCalendario();
  renderCheques();
  renderCajasDiarias();
  poblarMesesFiltro();
  setTimeout(renderGraficos, 200); // dar tiempo al DOM
  // Subtitle
  const sub = document.getElementById('cajaSubtitle');
  if (sub) {
    const fechaTxt = CAJA_DATA.fechaSaldo ? ` al ${fmtFechaCorta(CAJA_DATA.fechaSaldo)}/${CAJA_DATA.fechaSaldo.slice(0,4)}` : '';
    sub.innerHTML = `Saldo bancario: <strong style="color:var(--text);">${fmtMoney(CAJA_DATA.saldoInicial)}</strong>${fechaTxt} · ${CAJA_DATA.cheques.length} cheques registrados · ${Object.keys(CAJA_DATA.cajasDiarias).length} días de caja real`;
  }
}

function renderKpis() {
  const cont = document.getElementById('cajaKpis');
  if (!cont) return;
  const hoy = ymdISO(new Date());
  const en7Dias = new Date(); en7Dias.setDate(en7Dias.getDate() + 7);
  const en30Dias = new Date(); en30Dias.setDate(en30Dias.getDate() + 30);

  let cheq7 = 0, cheq30 = 0, totalPend = 0, cantPend = 0, cantVencidoAuto = 0;
  CAJA_DATA.cheques.forEach(ch => {
    if (ch.estado !== 'emitido') return;
    if (chequeVencidoAuto(ch, hoy)) { cantVencidoAuto++; return; } // no contar vencidos auto en pendiente
    cantPend++;
    totalPend += ch.monto || 0;
    const f = fechaProyectadaCheque(ch, hoy) || ch.fecha;
    if (f >= hoy && f <= ymdISO(en7Dias)) cheq7 += ch.monto || 0;
    if (f >= hoy && f <= ymdISO(en30Dias)) cheq30 += ch.monto || 0;
  });

  // Calcular peor saldo en próximos 60 días
  const fin = new Date(); fin.setDate(fin.getDate() + 60);
  const flujo = calcularProyeccion(new Date(), fin);
  let peor = Infinity, peorFecha = null;
  Object.values(flujo).forEach(f => {
    if (f.saldo < peor) { peor = f.saldo; peorFecha = f.fecha; }
  });
  const peorClass = peor < 0 ? 'red' : peor < 3000000 ? 'amber' : 'green';

  cont.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-accent" style="background:linear-gradient(90deg,var(--green),var(--green2));"></div>
      <div class="kpi-glow" style="background:var(--green);"></div>
      <div class="kpi-label">Saldo actual</div>
      <div class="kpi-value" style="color:var(--green);">${fmtMoney(CAJA_DATA.saldoInicial)}</div>
      <div class="kpi-sub">${CAJA_DATA.fechaSaldo ? 'al ' + fmtFechaCorta(CAJA_DATA.fechaSaldo) : ''}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-accent" style="background:linear-gradient(90deg,var(--amber),var(--amber2));"></div>
      <div class="kpi-glow" style="background:var(--amber);"></div>
      <div class="kpi-label">Cheques 7 días</div>
      <div class="kpi-value" style="color:var(--amber);">${fmtMoney(cheq7)}</div>
      <div class="kpi-sub">próx. 7 días</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-accent" style="background:linear-gradient(90deg,var(--blue),var(--blue2));"></div>
      <div class="kpi-glow" style="background:var(--blue);"></div>
      <div class="kpi-label">Cheques 30 días</div>
      <div class="kpi-value">${fmtMoney(cheq30)}</div>
      <div class="kpi-sub">próx. 30 días</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-accent" style="background:linear-gradient(90deg,var(--text3),var(--text2));"></div>
      <div class="kpi-glow" style="background:var(--text2);"></div>
      <div class="kpi-label">Total pendiente</div>
      <div class="kpi-value">${fmtMoney(totalPend)}</div>
      <div class="kpi-sub">${cantPend} cheques</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-accent" style="background:linear-gradient(90deg,var(--${peorClass}),var(--${peorClass === 'red' ? 'red2' : peorClass === 'amber' ? 'amber2' : 'green2'}));"></div>
      <div class="kpi-glow" style="background:var(--${peorClass});"></div>
      <div class="kpi-label">Peor saldo proyectado</div>
      <div class="kpi-value" style="color:var(--${peorClass});">${fmtMoney(peor)}</div>
      <div class="kpi-sub">${peorFecha ? fmtFechaCorta(peorFecha) : '—'}</div>
    </div>
  `;
}

function renderCalendario() {
  const cont = document.getElementById('cajaCalendario');
  const monthLbl = document.getElementById('cajaMonthLabel');
  if (!cont) return;
  const year = cajaMesActual.getFullYear();
  const month = cajaMesActual.getMonth();
  if (monthLbl) monthLbl.textContent = cajaMesActual.toLocaleString('es-AR', { month: 'long', year: 'numeric' }).toUpperCase();

  // Calcular flujo del mes mostrado (más algo de buffer)
  const ini = new Date(year, month, 1);
  const findelmes = new Date(year, month + 1, 0);
  const flujo = calcularProyeccion(ini, findelmes);

  cont.innerHTML = '';
  // Headers
  ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].forEach(d => {
    const h = document.createElement('div'); h.className = 'caja-dayheader'; h.textContent = d;
    cont.appendChild(h);
  });
  // Offset (lunes = 0, domingo = 6)
  let offset = ini.getDay() - 1;
  if (offset < 0) offset = 6;
  for (let i = 0; i < offset; i++) {
    const c = document.createElement('div'); c.className = 'caja-cell empty';
    cont.appendChild(c);
  }
  const hoyStr = ymdISO(new Date());
  for (let d = new Date(ini); d <= findelmes; d.setDate(d.getDate() + 1)) {
    const fs = ymdISO(d);
    const data = flujo[fs] || { ingreso: 0, egresos: 0, ingresoReal: false, saldo: null, cheques: [] };
    const cell = document.createElement('div');
    cell.className = 'caja-cell';
    if (fs === hoyStr) cell.classList.add('today');
    else if (fs < hoyStr) cell.classList.add('past');
    cell.onclick = () => abrirModalDia(fs);
    let saldoCls = '';
    if (data.saldo != null) {
      if (data.saldo < 0) saldoCls = 'neg';
      else if (data.saldo < 3000000) saldoCls = 'warn';
      else saldoCls = 'ok';
    }
    let html = `<div class="cdate">${d.getDate()}</div>`;
    const esPasado = fs < hoyStr;
    // Si hay cheques pagados ese día (siempre histórico)
    if (data.chequesPagadosDelDia && data.chequesPagadosDelDia.length > 0) {
      const totalPagado = data.chequesPagadosDelDia.reduce((s, c) => s + (c.monto || 0), 0);
      html += `<div class="crow"><span class="clbl">Pagados</span><span class="cval pagos">${fmtMoneyCompact(totalPagado)}</span></div>`;
    }
    // Cheques egresos (futuro: rolling, pasado: ya están como pagados arriba)
    if (data.egresos > 0 && !esPasado) {
      html += `<div class="crow"><span class="clbl">Cheques</span><span class="cval cheques">${fmtMoneyCompact(data.egresos)}</span></div>`;
    }
    if (data.ingreso > 0) {
      const realBadge = data.ingresoReal ? ' <span class="real-pill">REAL</span>' : '';
      html += `<div class="crow"><span class="clbl">Ingreso</span><span class="cval ingresos">${fmtMoneyCompact(data.ingreso)}${realBadge}</span></div>`;
    }
    if (data.saldo != null) {
      html += `<div class="csaldo ${saldoCls}">Saldo ${fmtMoneyCompact(data.saldo)}</div>`;
    }
    cell.innerHTML = html;
    cont.appendChild(cell);
  }
}

function abrirModalDia(fs) {
  // Buscar o crear modal
  let bg = document.getElementById('cajaModalBg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'cajaModalBg';
    bg.className = 'caja-modal-bg';
    bg.innerHTML = `<div class="caja-modal" id="cajaModalContent"></div>`;
    bg.onclick = (e) => { if (e.target === bg) bg.classList.remove('show'); };
    document.body.appendChild(bg);
  }
  const cont = document.getElementById('cajaModalContent');
  const fechaLong = new Date(fs + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hoyISO = ymdISO(new Date());
  const data = calcularFlujoDia(fs, hoyISO);
  const cajaReal = CAJA_DATA.cajasDiarias[fs];
  const esPasado = fs < hoyISO;
  cont.innerHTML = `
    <h3>${fechaLong}</h3>
    <div class="info-block">
      ${cajaReal && cajaReal.ventaTotal ? `<strong>Venta total:</strong> ${fmtMoney(cajaReal.ventaTotal)}<br>` : ''}
      <strong>Ingreso al banco:</strong> ${fmtMoney(data.ingreso)} ${data.ingresoReal ? '<span style="color:var(--green);">(caja real)</span>' : (esPasado ? '<span style="color:var(--text3);">(sin caja cargada)</span>' : '<span style="color:var(--text3);">(proyectado)</span>')}<br>
      <strong>Egresos:</strong> ${fmtMoney(data.egresos)}<br>
    </div>
    ${data.chequesPagadosDelDia && data.chequesPagadosDelDia.length > 0 ? `
      <h3 style="font-size:1rem;">Cheques pagados ese día (${data.chequesPagadosDelDia.length})</h3>
      <table class="caja-data-table" style="font-size:.7rem;">
        <thead><tr><th>Acreedor</th><th class="num">Monto</th><th>Banco</th></tr></thead>
        <tbody>
          ${data.chequesPagadosDelDia.map(ch => `<tr><td>${ch.destinatario || ''}</td><td class="num">${fmtMoney(ch.monto)}</td><td>${ch.banco || ''}</td></tr>`).join('')}
        </tbody>
      </table>
    ` : ''}
    ${data.cheques.length > 0 && !esPasado ? `
      <h3 style="font-size:1rem;">Cheques pendientes del día (${data.cheques.length})</h3>
      <table class="caja-data-table" style="font-size:.7rem;">
        <thead><tr><th>Acreedor</th><th class="num">Monto</th><th>Banco</th></tr></thead>
        <tbody>
          ${data.cheques.map(ch => `<tr><td>${ch.destinatario || ''}</td><td class="num">${fmtMoney(ch.monto)}</td><td>${ch.banco || ''}</td></tr>`).join('')}
        </tbody>
      </table>
    ` : ''}
    <div class="modal-actions">
      <button class="caja-btn" onclick="document.getElementById('cajaModalBg').classList.remove('show')">Cerrar</button>
    </div>
  `;
  bg.classList.add('show');
}

function renderCheques() {
  const tbody = document.getElementById('cajaChequesBody');
  const sumEl = document.getElementById('cajaChequesSummary');
  if (!tbody) return;
  const hoy = ymdISO(new Date());
  const fname = (document.getElementById('cajaFilterName')?.value || '').toLowerCase();
  const fmes = document.getElementById('cajaFilterMes')?.value || '';
  const festado = document.getElementById('cajaFilterEstado')?.value;
  const filtrados = CAJA_DATA.cheques.filter(ch => {
    const f = ch.fecha;
    if (fmes && !f.startsWith(fmes)) return false;
    // Para filtros de estado: tratamos vencido-auto como "vencido"
    let estadoEfectivo = ch.estado;
    if (chequeVencidoAuto(ch, hoy)) estadoEfectivo = 'vencido';
    if (festado && estadoEfectivo !== festado) return false;
    if (fname && !(ch.destinatario || '').toLowerCase().includes(fname)) return false;
    return true;
  }).sort((a, b) => a.fecha.localeCompare(b.fecha));

  let total = 0;
  tbody.innerHTML = filtrados.map(ch => {
    total += ch.monto || 0;
    let estadoEfectivo = ch.estado;
    if (chequeVencidoAuto(ch, hoy)) estadoEfectivo = 'vencido';
    const estadoLabels = {
      emitido: '<span class="caja-pill pendiente">Emitido</span>',
      pagado: '<span class="caja-pill pagado">Pagado</span>',
      rechazado: '<span class="caja-pill rechazado">Rechazado</span>',
      vencido: '<span class="caja-pill postergado">Vencido</span>',
    };
    const fp = fechaProyectadaCheque(ch, hoy);
    const fechaMostrar = fp && fp !== ch.fecha ? `${fmtFechaCorta(ch.fecha)} → <strong>${fmtFechaCorta(fp)}</strong>` : fmtFechaCorta(ch.fecha);
    const notas = ch.notas || '';
    const notaPagado = ch.fechaPagoReal ? ` · Pagado ${fmtFechaCorta(ch.fechaPagoReal)}` : '';
    return `<tr>
      <td>${fechaMostrar}</td>
      <td>${diaSemana(ch.fecha)}</td>
      <td>${ch.destinatario || ''}</td>
      <td class="num">${fmtMoney(ch.monto)}</td>
      <td>${ch.banco || ''}</td>
      <td>${estadoLabels[estadoEfectivo] || ''}</td>
      <td>${notas}${notaPagado}</td>
    </tr>`;
  }).join('');
  if (sumEl) sumEl.textContent = `${filtrados.length} cheques · ${fmtMoney(total)}`;
}

function renderCajasDiarias() {
  const tbody = document.getElementById('cajaCajasBody');
  if (!tbody) return;
  const dias = Object.values(CAJA_DATA.cajasDiarias).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 30);
  tbody.innerHTML = dias.map(c => {
    const calc = c.calculado || {};
    return `<tr>
      <td>${fmtFechaCorta(c.fecha)}</td>
      <td>${diaSemana(c.fecha)}</td>
      <td class="num">${fmtMoney(c.ventaTotal || 0)}</td>
      <td class="num">${fmtMoney(calc.ingresoBrutoBanco || 0)}</td>
      <td class="num" style="color:var(--red);">${fmtMoney(-(calc.totalComisiones || 0))}</td>
      <td class="num" style="color:var(--red);">${fmtMoney(-(calc.impuestoCredito || 0))}</td>
      <td class="num" style="color:var(--green);font-weight:700;">${fmtMoney(calc.ingresoNetoBanco || 0)}</td>
      <td class="num">${fmtMoney(c.efectivo || 0)}</td>
    </tr>`;
  }).join('');
}

function poblarMesesFiltro() {
  const sel = document.getElementById('cajaFilterMes');
  if (!sel) return;
  const meses = new Set();
  CAJA_DATA.cheques.forEach(ch => meses.add(fechaEfectivaCheque(ch).slice(0, 7)));
  const sorted = [...meses].sort();
  const meses_es = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  sel.innerHTML = '<option value="">Todos los meses</option>' +
    sorted.map(m => {
      const [y, mm] = m.split('-');
      return `<option value="${m}">${meses_es[parseInt(mm,10)-1]} ${y}</option>`;
    }).join('');
}

// ============================================================
// GRÁFICOS (Chart.js global ya disponible en el informe)
// ============================================================
const _charts = {}; // referencias para destruir antes de re-render

function renderGraficos() {
  if (typeof Chart === 'undefined') return; // Chart.js no cargado
  renderChartIngresos();
  renderChartEgresos();
  renderChartEstados();
  renderChartChequesMes();
}

function renderChartIngresos() {
  const c = document.getElementById('chartIngresos');
  if (!c) return;
  if (_charts.ingresos) _charts.ingresos.destroy();
  // Últimos 30 días con caja cargada
  const dias = Object.values(CAJA_DATA.cajasDiarias)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(-30);
  const labels = dias.map(d => fmtFechaCorta(d.fecha));
  const data = dias.map(d => (d.calculado && d.calculado.ingresoNetoBanco) || 0);
  _charts.ingresos = new Chart(c, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Neto banco', data, backgroundColor: 'rgba(52,211,153,.5)', borderColor: '#34d399', borderWidth: 1, borderRadius: 4 }] },
    options: chartOptsBar('$')
  });
}

function renderChartEgresos() {
  const c = document.getElementById('chartEgresos');
  if (!c) return;
  if (_charts.egresos) _charts.egresos.destroy();
  // Próximos 30 días: cheques emitidos pendientes agrupados por fecha proyectada
  const hoy = ymdISO(new Date());
  const fin = new Date(); fin.setDate(fin.getDate() + 30);
  const finStr = ymdISO(fin);
  const porFecha = {};
  CAJA_DATA.cheques.forEach(ch => {
    if (ch.estado !== 'emitido') return;
    const fp = fechaProyectadaCheque(ch, hoy);
    if (!fp || fp < hoy || fp > finStr) return;
    porFecha[fp] = (porFecha[fp] || 0) + (ch.monto || 0);
  });
  const sorted = Object.entries(porFecha).sort((a, b) => a[0].localeCompare(b[0]));
  const labels = sorted.map(([f]) => fmtFechaCorta(f));
  const data = sorted.map(([, v]) => v);
  _charts.egresos = new Chart(c, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Cheques', data, backgroundColor: 'rgba(248,113,113,.5)', borderColor: '#f87171', borderWidth: 1, borderRadius: 4 }] },
    options: chartOptsBar('$')
  });
}

function renderChartEstados() {
  const c = document.getElementById('chartEstados');
  if (!c) return;
  if (_charts.estados) _charts.estados.destroy();
  const hoy = ymdISO(new Date());
  const counts = { emitido: 0, pagado: 0, rechazado: 0, vencido: 0 };
  const monto = { emitido: 0, pagado: 0, rechazado: 0, vencido: 0 };
  CAJA_DATA.cheques.forEach(ch => {
    let est = ch.estado;
    if (chequeVencidoAuto(ch, hoy)) est = 'vencido';
    if (counts[est] != null) {
      counts[est]++;
      monto[est] += ch.monto || 0;
    }
  });
  _charts.estados = new Chart(c, {
    type: 'doughnut',
    data: {
      labels: [`Emitidos (${counts.emitido})`, `Pagados (${counts.pagado})`, `Rechazados (${counts.rechazado})`, `Vencidos (${counts.vencido})`],
      datasets: [{
        data: [monto.emitido, monto.pagado, monto.rechazado, monto.vencido],
        backgroundColor: ['rgba(255,255,255,.15)', 'rgba(52,211,153,.6)', 'rgba(248,113,113,.6)', 'rgba(251,191,36,.6)'],
        borderColor: '#0e1018',
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: $${ctx.parsed.toLocaleString('es-AR')}` } }
      }
    }
  });
}

function renderChartChequesMes() {
  const c = document.getElementById('chartChequesMes');
  if (!c) return;
  if (_charts.chequesMes) _charts.chequesMes.destroy();
  const hoy = ymdISO(new Date());
  const porMes = {};
  CAJA_DATA.cheques.forEach(ch => {
    if (ch.estado !== 'emitido') return;
    if (chequeVencidoAuto(ch, hoy)) return;
    const ym = (ch.fecha || '').slice(0, 7);
    if (!ym) return;
    porMes[ym] = (porMes[ym] || 0) + (ch.monto || 0);
  });
  const sorted = Object.entries(porMes).sort((a, b) => a[0].localeCompare(b[0]));
  const meses_es = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const labels = sorted.map(([m]) => {
    const [y, mm] = m.split('-');
    return `${meses_es[parseInt(mm,10)-1]} ${y.slice(2)}`;
  });
  const data = sorted.map(([, v]) => v);
  _charts.chequesMes = new Chart(c, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Pendientes', data, backgroundColor: 'rgba(96,165,250,.5)', borderColor: '#60a5fa', borderWidth: 1, borderRadius: 4 }] },
    options: chartOptsBar('$')
  });
}

function chartOptsBar(prefix) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: { label: (ctx) => `${prefix}${ctx.parsed.y.toLocaleString('es-AR')}` }
      }
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#5a6070', font: { size: 10 }, maxRotation: 45, minRotation: 45 } },
      y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#5a6070', callback: (v) => prefix + (v / 1e6).toFixed(0) + 'M' } }
    }
  };
}

// ============================================================
// HANDLERS GLOBALES
// ============================================================
window.cajaSwitchTab = function(name, ev) {
  if (ev) ev.preventDefault();
  document.querySelectorAll('.caja-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.caja-tab-content').forEach(c => c.classList.remove('active'));
  if (ev && ev.currentTarget) ev.currentTarget.classList.add('active');
  const tab = document.getElementById('cajaTab-' + name);
  if (tab) tab.classList.add('active');
};

window.cajaCambiarMes = function(delta) {
  cajaMesActual = new Date(cajaMesActual.getFullYear(), cajaMesActual.getMonth() + delta, 1);
  renderCalendario();
};
window.cajaIrHoy = function() {
  const hoy = new Date();
  cajaMesActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  renderCalendario();
};
window.cajaRenderCheques = renderCheques;

// ============================================================
// INICIALIZACIÓN
// ============================================================
// Esperar a que el usuario esté autenticado para cargar
window.addEventListener('cauce-auth-change', (e) => {
  if (e.detail.user) {
    cargarTodoCaja();
  }
});

// Si ya hay usuario al cargar el script, arrancar
setTimeout(() => {
  if (window.__cauceAuth && window.__cauceAuth.currentUser) {
    cargarTodoCaja();
  }
}, 800);
