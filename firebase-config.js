// Bikkgane Biryani - Global Configuration File
// Load this file before any other scripts in index.html and admin.html

// ─── Firebase Configuration ───
const firebaseConfig = {
  apiKey: "AIzaSyBkJLcaQLIcCHJrKkDGh4nAhuGleyUpuNY",
  authDomain: "food-menu-order-8a735.firebaseapp.com",
  projectId: "food-menu-order-8a735",
  storageBucket: "food-menu-order-8a735.firebasestorage.app",
  messagingSenderId: "281446715322",
  appId: "1:281446715322:web:0979efb6b52df07a975783"
};

// ─── Cloudinary Configuration ───
const CLOUDINARY_CONFIG = {
    cloudName: "dc3o4gtxm",
    apiKey: "527249129648473",
    apiSecret: "7Ed9gPSeSAb0kdaKxtWbWnFip9w",
    uploadPreset: "briyani",
    uploadFolder: "briyani/assets"
};

// ─── Initialize Firebase ───
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();