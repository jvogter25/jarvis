FROM node:20-slim

WORKDIR /app

# Copy package files explicitly — fails fast if package-lock.json is missing
COPY package.json package-lock.json ./

RUN npm ci

COPY . .

CMD ["npm", "start"]
