FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

# Instala Chromium e todas as dependências de sistema
RUN npx playwright install chromium --with-deps

COPY server.js preload-model.mjs ./

# Baixa o modelo SigLIP (scan de cartas) no build — cache fica na imagem
RUN node preload-model.mjs

EXPOSE 3000

CMD ["node", "server.js"]
