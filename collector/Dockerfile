FROM node:20-slim
WORKDIR /app
COPY package*.json ./

# ★★★ 以下のコマンドを追加し、クリーンなインストールを保証 ★★★
RUN rm -rf node_modules package-lock.json

RUN npm install
COPY . .
RUN npm run build
CMD ["npm", "start"]