/* Firebase settings for the demo website. These values are NOT secret (every Firebase website shows them):
   the protection is the Google sign-in plus the Firestore security rules.
   Where to find them: Firebase console > Project settings (gear) > General > Your apps > the web app > "SDK setup and configuration" > Config. */
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDs9DBSvn06vG9TT9AMNIUmHybC7M10Q9Q',
  authDomain: 'lead-sla-monitor.firebaseapp.com',
  projectId: 'lead-sla-monitor',
  appId: '1:999364364821:web:f87a3d063b9c8351ba1c1c'
};
window.ALLOWED_DOMAIN = 'databeat.io';   // only Google accounts of this company can sign in

window.COPILOT_URL = 'https://script.google.com/a/macros/databeat.io/s/AKfycbzoV0wfGlC2nwMaxtPD9NlvBrCijJo60LVRBLlNqV2u34c2gyyXFzm5Jl23yiy88aOQ/exec';
