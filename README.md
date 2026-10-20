# PrivateChat (MVP)
Node + Express + Socket.IO + MongoDB. Username/password auth (bcrypt, JWT in HttpOnly cookie, server-side sessions), 1-to-1 chat, photo/video upload (magic-byte checked, auth-gated), explicit location sharing.

## Run on Windows (PowerShell, inside VS Code)
1. Install Node.js LTS (nodejs.org) and either MongoDB Community (runs as a Windows service on port 27017) or create a free MongoDB Atlas cluster and copy its connection string.
2. In the project folder:
```
npm install
Copy-Item .env.example .env
```
3. Edit `.env`: set `JWT_SECRET` to a long random string (generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`), and `MONGO_URI` (Atlas string if not local).
4. `npm start`, then open http://localhost:3000
5. Register two accounts: one in a normal window, one in a private/incognito window. Search the other user, start a chat, send text, a photo, a video, and a location.

## Realtime events
`message:send` (client→server, with ack), `message:new` (server→both users), `user:online`, `user:offline`, `presence`. Each socket auto-joins a private room `u:<userId>`; the sender ID always comes from the authenticated cookie, never the browser.

## API
POST /api/auth/register|login|logout, GET /api/auth/me; GET /api/users/search?q=, /api/users/:id; POST/GET /api/conversations, GET /api/conversations/:id; GET/POST /api/conversations/:id/messages (`?before=&limit=`); POST /api/conversations/:id/media; GET /api/media/:mediaId (`?download=1`).

## Notes and limitations
- Uploads live in `uploads/` (not publicly served, not backed up). Replace the media section in `backend/server.js` with S3/Cloudinary for production; ephemeral hosting disks lose files.
- Messages are NOT end-to-end encrypted; the server can read them. Use HTTPS in production (`NODE_ENV=production` enables secure cookies; set up a reverse proxy/host TLS).
- Both users must reach the same deployed server to chat across devices. Geolocation works only on localhost or HTTPS.
- Presence is broadcast to all connected users; messages sent while recipient is offline show as sent (✓) and are not retro-marked delivered.
- Troubleshooting: "MongoDB connection failed" → start the MongoDB service or fix `MONGO_URI` (Atlas: allow your IP). Port in use → change `PORT`.
