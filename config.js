/* Website settings. Nothing secret goes here (this file is public on GitHub Pages). */
window.APP_CONFIG = {
  API_URL: 'https://YOUR-CLOUD-RUN-ADDRESS.run.app',   // the backend address printed by "gcloud run deploy"
  GOOGLE_CLIENT_ID: 'YOUR-CLIENT-ID.apps.googleusercontent.com',   // Google Cloud > APIs & Services > Credentials > OAuth client ID (Web)
  DEV: false   // true only on your laptop: skips Google sign-in (the backend must then run with DEV_USER)
};
