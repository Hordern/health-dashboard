# One image for both Railway services: the web app (npm start) and the daily
# cron job (npm run daily). Python is only here for the Garmin client.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PYTHON=/opt/venv/bin/python

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

CMD ["npm", "start"]
