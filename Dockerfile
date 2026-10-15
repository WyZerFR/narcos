# NARCO-WEB : un seul service (client compilé + serveur Colyseus sur le même port).

# ---- build : dépendances complètes, compilation du client ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
# commit fourni par Railway au build : affiché comme version dans les options
ARG RAILWAY_GIT_COMMIT_SHA
ENV NARCO_COMMIT=$RAILWAY_GIT_COMMIT_SHA
RUN npm run build

# ---- runtime : dépendances de production, sources serveur + shared, client compilé ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY shared/ shared/
COPY server/src/ server/src/
COPY server/tsconfig.json server/
COPY tsconfig.base.json ./
COPY --from=build /app/client/dist client/dist
# sauvegardes : monter un volume ici (NARCO_DATA_DIR). Les volumes Railway sont créés par
# root : le processus reste root pour pouvoir y écrire.
ENV NARCO_DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 2567
CMD ["npm", "start"]
