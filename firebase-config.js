// Configuración del proyecto Firebase "admin-cauce"
//
// IMPORTANTE: Reemplazá los valores de abajo con los de tu proyecto.
// Los obtenés en: Firebase Console > Configuración del proyecto > Tus apps > Web
//
// La apiKey y demás valores de Firebase web son PÚBLICOS por diseño
// (van en el JS del cliente). La seguridad real la dan las firestore.rules.

export const firebaseConfig = {
  apiKey: "AIzaSyClCJ85EzliyHU7eQ8-NVfcMXBo0tjYcdI",
  authDomain: "admin-cauce.firebaseapp.com",
  projectId: "admin-cauce",
  storageBucket: "admin-cauce.firebasestorage.app",
  messagingSenderId: "147765697767",
  appId: "1:147765697767:web:fff36ac8f3edb4ee999642"
};

// Mail del admin (debe coincidir con la firestore.rules)
export const ADMIN_EMAILS = [
  'francodaviladj@gmail.com'
];
