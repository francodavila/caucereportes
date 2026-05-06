// ============================================================
// INTEGRACIÓN FIRESTORE EN EL INFORME
// ============================================================
// Este snippet va INCLUIDO al inicio del informe (informe-cauce-2026.html)
// y reemplaza los datos hardcodeados de reportData y rrhhMonthlyData
// por los datos vivos de Firestore (con fallback a los hardcodeados si no hay).
//
// HOW TO USE:
// 1. Subí el archivo `firebase-config.js` junto al informe.
// 2. En el informe, justo ANTES del <script> que define `reportData`,
//    insertá este bloque envuelto en <script type="module">...</script>.
// 3. Después del <script> que define reportData (al final), agregá la línea
//    indicada en INSTRUCCIONES_FINAL al pie de este archivo.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFirestore, collection, getDocs, query, orderBy } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseConfig, ADMIN_EMAILS } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// Exponemos funciones globales para que el HTML del informe pueda llamarlas
window.__cauceAuth = { auth, signInWithPopup, signOut, provider };

// Estado global de datos cargados desde Firestore
window.__cauceData = {
  reportData: null,    // Se llena en cargarTodo()
  rrhhMonthlyData: null,
  // Plataforma de pagos (Bloque 5):
  proveedores: [],
  facturas: [],
  pagos: [],
  ready: false
};

// ============================================================
// FETCH ALL MONTHS FROM FIRESTORE
// ============================================================
async function cargarTodo() {
  try {
    const [ecoSnap, rrhhSnap, provSnap, factSnap, pagSnap] = await Promise.all([
      getDocs(collection(db, 'informes_economicos')),
      getDocs(collection(db, 'informes_rrhh')),
      getDocs(query(collection(db, 'proveedores'), orderBy('nombre'))).catch(() => null),
      getDocs(query(collection(db, 'facturas'), orderBy('fecha', 'desc'))).catch(() => null),
      getDocs(query(collection(db, 'pagos'), orderBy('fecha', 'desc'))).catch(() => null),
    ]);

    const reportData = {};
    ecoSnap.forEach(d => {
      const docData = d.data();
      const monthName = monthIdToKey(d.id); // '2026-04' → 'abril'
      reportData[monthName] = docData.data || {};
    });

    const rrhhData = {};
    rrhhSnap.forEach(d => {
      const docData = d.data();
      const monthName = monthIdToKey(d.id);
      rrhhData[monthName] = rehydrateRrhh(docData.data || {});
    });

    // Plataforma de pagos
    const proveedores = [];
    if (provSnap) provSnap.forEach(d => proveedores.push({ _id: d.id, ...d.data() }));
    const facturas = [];
    if (factSnap) factSnap.forEach(d => facturas.push({ _id: d.id, ...d.data() }));
    const pagos = [];
    if (pagSnap) pagSnap.forEach(d => pagos.push({ _id: d.id, ...d.data() }));

    window.__cauceData.reportData = reportData;
    window.__cauceData.rrhhMonthlyData = rrhhData;
    window.__cauceData.proveedores = proveedores;
    window.__cauceData.facturas = facturas;
    window.__cauceData.pagos = pagos;
    window.__cauceData.ready = true;
    console.log('[Cauce] Datos cargados desde Firestore:', Object.keys(reportData), '· Proveedores:', proveedores.length, '· Compras:', facturas.length, '· Pagos:', pagos.length);
    return { reportData, rrhhMonthlyData: rrhhData };
  } catch (e) {
    console.warn('[Cauce] No se pudo cargar de Firestore, usando datos hardcoded:', e);
    window.__cauceData.ready = true; // Igual marcamos ready para que el informe arranque
    return null;
  }
}

function monthIdToKey(yyyymm) {
  const meses = ['','enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const m = parseInt(yyyymm.split('-')[1], 10);
  return meses[m] || yyyymm;
}

// === Reconstruir formato original ===
// El informe original espera rrhhMonthlyData[mes].employees como array de arrays:
//   [['BELARDINELLI','Emiliano Y.','ALTA AFIP','Chef',4500000,0,0,0], ...]
// Pero en Firestore guardamos como array de objetos:
//   [{apellido,nombre,sit,cargo,base,fer,total,neto}, ...]
// Así que al leer convertimos de vuelta.
const RRHH_EMP_FIELDS = ['apellido','nombre','sit','cargo','base','fer','total','neto'];

function rehydrateRrhh(monthData) {
  if (!monthData || !Array.isArray(monthData.employees)) return monthData;
  monthData.employees = monthData.employees.map(emp => {
    if (Array.isArray(emp)) return emp; // ya es array
    return RRHH_EMP_FIELDS.map(f => emp[f]);
  });
  return monthData;
}

// ============================================================
// AUTH FLOW
// ============================================================
window.__cauceAuth.iniciarLogin = async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    console.error('[Cauce] Error de login:', e);
    alert('No pudimos iniciar sesión: ' + (e.message || e.code));
  }
};

window.__cauceAuth.cerrarSesion = () => signOut(auth);

// Estado del usuario
let unsubAuth = onAuthStateChanged(auth, (user) => {
  window.__cauceAuth.currentUser = user || null;
  window.__cauceAuth.isAdmin = !!(user && ADMIN_EMAILS.includes(user.email));
  // Disparamos un evento para que el informe pueda reaccionar
  window.dispatchEvent(new CustomEvent('cauce-auth-change', { detail: { user } }));
});

// ============================================================
// MERGE EN reportData / rrhhMonthlyData GLOBALES
// ============================================================
// Después de que el informe haya definido sus reportData/rrhhMonthlyData
// hardcodeados, llamamos a esto para fusionar los datos de Firestore encima.
window.__cauceMerge = function () {
  const fb = window.__cauceData;
  if (!fb || !fb.ready) return;
  if (typeof reportData !== 'undefined' && fb.reportData) {
    Object.keys(fb.reportData).forEach(m => {
      if (Object.keys(fb.reportData[m] || {}).length > 0) {
        // eslint-disable-next-line no-undef
        reportData[m] = fb.reportData[m];
      }
    });
  }
  if (typeof rrhhMonthlyData !== 'undefined' && fb.rrhhMonthlyData) {
    Object.keys(fb.rrhhMonthlyData).forEach(m => {
      if (Object.keys(fb.rrhhMonthlyData[m] || {}).length > 0) {
        // eslint-disable-next-line no-undef
        rrhhMonthlyData[m] = fb.rrhhMonthlyData[m];
      }
    });
  }
  console.log('[Cauce] Datos de Firestore fusionados con hardcoded.');
};

// Iniciamos la carga inmediatamente; cuando termine, el informe puede mergear
window.__cauceCarga = cargarTodo();

/* ============================================================
 * INSTRUCCIONES_FINAL — qué tocar en el informe HTML existente
 * ============================================================
 *
 * 1. AL INICIO del <body> (justo después de la apertura), agregar:
 *
 *    <script type="module" src="./integracion-informe.js"></script>
 *
 * 2. AL FINAL del informe, justo después de la línea que cierra
 *    `const reportData = { ... };` y `const rrhhMonthlyData = { ... };`,
 *    agregar:
 *
 *    <script>
 *    (async () => {
 *      // Esperamos a que Firestore termine de cargar
 *      await window.__cauceCarga;
 *      window.__cauceMerge();
 *      // Si el informe ya renderizó, forzar refresh de la vista activa
 *      if (typeof switchTab === 'function') switchTab('resumen');
 *    })();
 *    </script>
 *
 * 3. REEMPLAZAR el lockScreen actual (password gate) por el flow de Google:
 *    - Ocultar el div #lockScreen.
 *    - En su lugar, mostrar #lockScreen solo si no hay usuario logueado.
 *    - Botón "Continuar con Google" llama a window.__cauceAuth.iniciarLogin().
 *    - El listener `cauce-auth-change` muestra/oculta el contenido según
 *      si hay usuario o no.
 *
 *    Snippet sugerido (reemplaza la lógica de checkPwd actual):
 *
 *    window.addEventListener('cauce-auth-change', (e) => {
 *      const user = e.detail.user;
 *      if (user) {
 *        document.getElementById('lockScreen').style.display = 'none';
 *        document.getElementById('mainContent').style.display = 'block';
 *      } else {
 *        document.getElementById('lockScreen').style.display = 'flex';
 *        document.getElementById('mainContent').style.display = 'none';
 *      }
 *    });
 *
 * ============================================================
 */
