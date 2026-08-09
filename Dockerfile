# ---------------------------------------------------------------------------
# Worker-image: belplanner + ConversationRelay-websocket.
#
# Dit draait NIET op Netlify (kortlevende functions, geen inkomende websockets),
# maar op Railway of Fly.io in regio Amsterdam of Frankfurt. Zie README.
#
# Netlify bouwt de Next.js-app vanuit de root; deze Dockerfile bouwt de worker.
# Beide lezen dezelfde DATABASE_URL.
# ---------------------------------------------------------------------------

FROM node:22-slim AS build
WORKDIR /app

# Alle deps (incl. dev) om te kunnen compileren met tsc.
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.worker.json ./
COPY src ./src

# Compileert alleen de worker-bestanden naar dist/ (zie tsconfig.worker.json).
RUN npm run worker:build

# ---------------------------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Alleen productie-deps in de uiteindelijke image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

# De websocket voor ConversationRelay. Zet RELAY_WS_URL hiernaartoe.
EXPOSE 8081

# Node draait als PID 1, niet als kind van npm. npm geeft SIGTERM slecht door,
# waardoor de eigen shutdown-handler nooit aan bod kwam en het platform
# uiteindelijk SIGKILL stuurde.
CMD ["node", "dist/worker.js"]
