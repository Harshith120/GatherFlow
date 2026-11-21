FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
