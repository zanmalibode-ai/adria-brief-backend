# Adria Brief Backend

TopSailor Adriatic Morning Brief — Node.js backend

## Endpoints

| Method | URL | Opis |
|--------|-----|------|
| GET | /api/brief | Vrne današnji brief (JSON) |
| POST | /api/send | Pošlje WhatsApp vsem naročnikom |
| GET | /api/subscribers | Seznam naročnikov |
| POST | /api/subscribers | Dodaj naročnika |
| DELETE | /api/subscribers/:id | Briši naročnika |
| GET | /health | Health check |

## Deploy na Railway (3 koraki)

1. **GitHub** — naloži ta projekt na GitHub (novo repo)
   ```
   git init
   git add .
   git commit -m "init"
   git remote add origin https://github.com/TVOJE_IME/adria-brief-backend.git
   git push -u origin main
   ```

2. **Railway** — pojdi na railway.app → New Project → Deploy from GitHub → izberi repo

3. **Environment variables** — v Railway dashboard → Variables → dodaj:
   ```
   ADMIN_KEY=izberi_si_geslo
   TWILIO_ACCOUNT_SID=ACxx...
   TWILIO_AUTH_TOKEN=xx...
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   ```

Railway ti da public URL npr. `adria-brief-backend.up.railway.app`

## Lokalno testiranje

```bash
npm install
cp .env.example .env
# uredi .env z dejanskimi vrednostmi
npm run dev
```

Test brief:
```bash
curl http://localhost:3000/api/brief
```

Test pošiljanja:
```bash
curl -X POST http://localhost:3000/api/send \
  -H "x-admin-key: your-secret-key-here"
```

## Twilio WhatsApp setup

1. Registracija na twilio.com (brezplačno)
2. Console → Messaging → Senders → WhatsApp Senders
3. Za testiranje: Sandbox (takoj dostopen)
4. Za produkcijo: WhatsApp Business Profile approval (~1 teden)
