FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

# Instala Chromium e todas as dependências de sistema
RUN npx playwright install chromium --with-deps

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
