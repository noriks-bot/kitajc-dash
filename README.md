# Noriks Dashboard

Dashboard app za Noriks. Temelj za kitajc.noriks.com in druge instance.

## Zahteve

- Node.js 18+
- npm

## Setup

1. `npm install`
2. Nastavi poverilnice v `server.js`:
   - `YOUR_FACEBOOK_ACCESS_TOKEN` → Facebook access token
   - `YOUR_METAKOCKA_SECRET_KEY` → MetaKocka secret key
   - `YOUR_METAKOCKA_COMPANY_ID` → MetaKocka company ID
3. Nastavi WooCommerce ključe v `fetch-sales.js` za vsako trgovino:
   - `YOUR_WC_CONSUMER_KEY` → WooCommerce consumer key
   - `YOUR_WC_CONSUMER_SECRET` → WooCommerce consumer secret
4. Nastavi začetne podatkovne datoteke (prazne):
   ```
   echo '{}' > sessions.json
   echo '[]' > users.json
   echo '{}' > cache.json
   ```
5. Zaženi: `node server.js`

## Porta

Privzeto: `3000`. Spremenite `const PORT = 3000` v `server.js`.
