# syntax=docker/dockerfile:1
# Standalone build: fetches the pinned public Strata source repositories.
FROM alpine:3.21 AS source
RUN apk add --no-cache git ca-certificates
COPY docker/fetch-source.sh /usr/local/bin/fetch-source.sh
RUN chmod +x /usr/local/bin/fetch-source.sh
ARG MONOFS_REPO=https://github.com/radryc/monofs.git
ARG MONOFS_REF=ef7d9f5baded69cad046f8ea9d88f2fcf93bf7ce
ARG KVS_REPO=https://github.com/radryc/kvs.git
ARG KVS_REF=1cf406ad1da680ae06e3db84aa3a5aa3e95585b3
ARG CFG_REPO=https://github.com/radryc/cfg.git
ARG CFG_REF=1772380a1c25a39e0fe06cd0c4265c5b45fb5930
RUN set -eux; \
    fetch-source.sh "$MONOFS_REPO" "$MONOFS_REF" /src/monofs; \
    fetch-source.sh "$KVS_REPO" "$KVS_REF" /src/kvs; \
    fetch-source.sh "$CFG_REPO" "$CFG_REF" /src/cfg

FROM node:22-alpine AS router-ui-builder

WORKDIR /ui

COPY --from=source /src/monofs/internal/router/ui/package.json /src/monofs/internal/router/ui/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --from=source /src/monofs/internal/router/ui/ ./
# The AWS ALB routes /monofs/* to this service without rewriting the path, so
# the SPA (assets + /api/* calls) must be built under the /monofs/ base.
ENV VITE_BASE=/monofs/
RUN npm run build


FROM golang:1.26-alpine AS builder
RUN apk add --no-cache git ca-certificates
WORKDIR /src/monofs
COPY --from=source /src /src
RUN go mod download

COPY --from=router-ui-builder /ui/dist ./internal/router/ui/dist

RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -ldflags "-s -w" \
    -o /bin/monofs-router ./cmd/monofs-router

FROM alpine:3.19

RUN apk add --no-cache ca-certificates curl procps strace iproute2 lsof bind-tools tcpdump netcat-openbsd

COPY --from=builder /bin/monofs-router /usr/local/bin/monofs-router

EXPOSE 9090 8080

ENTRYPOINT ["monofs-router"]
CMD ["--port=9090", "--http-port=8080", "--log-level=warn"]
