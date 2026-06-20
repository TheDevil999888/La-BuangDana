# Firebase Setup

## 1. Buat Project Firebase
- Buka [Firebase Console](https://console.firebase.google.com/)
- Klik `Create project`
- Buat nama project, misalnya `dashboard-buang-dana`

## 2. Tambahkan Web App
- Di halaman project, klik ikon `</>` untuk `Web`
- Isi nama app, misalnya `dashboard-buang-dana-web`
- Klik `Register app`

## 3. Salin Firebase Config
- Firebase akan menampilkan config seperti ini:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

- Buka file `firebase-config.js`
- Ubah menjadi seperti ini:

```js
export const firebaseSyncConfig = {
  enabled: true,
  appName: "dashboard-buang-dana",
  firebaseConfig: {
    apiKey: "ISI_DARI_FIREBASE",
    authDomain: "ISI_DARI_FIREBASE",
    projectId: "ISI_DARI_FIREBASE",
    messagingSenderId: "ISI_DARI_FIREBASE",
    appId: "ISI_DARI_FIREBASE",
  },
  firestore: {
    collection: "dashboardStates",
    documentId: "default",
  },
};
```

## 4. Aktifkan Firestore Database
- Di Firebase Console, buka `Firestore Database`
- Klik `Create database`
- Pilih mode `Production` atau `Test`
- Pilih lokasi terdekat

## 5. Firestore Rules Sederhana
- Untuk percobaan awal, pakai rules ini dulu:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /dashboardStates/{document} {
      allow read, write: if true;
    }
  }
}
```

- Setelah berhasil, rules ini sebaiknya diperketat lagi.

## 6. Deploy Ulang
- Setelah `firebase-config.js` diisi, deploy ulang ke Netlify.

## 7. Cara Kerja
- User isi settings lalu klik `Save & Extract`
- Dashboard akan menyimpan state ke Firestore
- Jika background custom diganti, gambar akan dikompres otomatis lalu ikut disimpan ke Firestore
- Tempat lain yang membuka dashboard yang sama akan ikut menerima update realtime

## Catatan
- Background preset bawaan ikut sinkron global
- Background custom upload/paste sekarang ikut sinkron lewat Firestore saja
- Untuk menjaga paket gratis, hindari gambar yang terlalu besar. Sistem sudah otomatis mengecilkan gambar saat upload atau paste.
