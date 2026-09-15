// Copy this file to `config.js` and paste in your own Firebase web config.
//
//   Firebase console -> Project settings -> General -> Your apps
//   -> Web app -> "SDK setup and configuration" -> Config
//
// These values are NOT secrets. A Firebase web config is a public identifier —
// it ships in every browser that loads the page. What protects your data is
// firestore.rules, which is why those rules are tested.
//
// Without this file the page still works: it falls back to pass-the-phone.
window.NUMBER_BOMB_FIREBASE = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
