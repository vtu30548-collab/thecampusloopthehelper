FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 DEMO_MODE=true
EXPOSE 3000
CMD ["node", "server.js"]
