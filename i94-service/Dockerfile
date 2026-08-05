# Use the official Playwright image — includes Chromium + all system deps + xvfb
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY openaiModels.js ./

ENV NODE_ENV=production
ENV DISPLAY=:99

EXPOSE 3001

# xvfb-run provides a virtual display so headless:false (headed) Chrome works on Railway's Linux servers
# This is critical — CBP's reCAPTCHA Enterprise requires a real-looking headed browser
CMD xvfb-run \
      --server-args="-screen 0 1280x900x24 -ac +extension GLX" \
      node server.js
