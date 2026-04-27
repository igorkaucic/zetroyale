# 1. Build the React Frontend
FROM node:18-alpine AS builder
WORKDIR /app
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client/ ./client/
RUN cd client && npm run build

# 2. Build the Node Backend
FROM node:18-alpine
WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm install --production

# Copy backend source code
COPY . .

# Copy the built frontend from the builder stage
# (Vite is configured to output to ../public_v2)
COPY --from=builder /app/public_v2 ./public_v2

# Expose the port used by Digital Ocean / Render
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]
