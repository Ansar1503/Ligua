FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm install
COPY . .
RUN npm run build -w client

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm install --omit=dev
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./server/public
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "server"]
