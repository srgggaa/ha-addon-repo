ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js 18+ and jq (jq is used by run.sh to read HA's options.json)
RUN apk add --no-cache nodejs npm jq

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json .
RUN npm install --omit=dev

# Copy app source
COPY bot.js session.js store.js vrchat.js data.json ./

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
