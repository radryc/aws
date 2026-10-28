# syntax=docker/dockerfile:1
# Standalone build: fetches the pinned public Strata source repositories.
FROM alpine:3.21 AS source
RUN apk add --no-cache git ca-certificates
COPY docker/fetch-source.sh /usr/local/bin/fetch-source.sh
RUN chmod +x /usr/local/bin/fetch-source.sh
ARG GUARDIAN_REPO=https://github.com/radryc/guardian.git
ARG GUARDIAN_REF=59c51705a791e9914919957f58a947aac04ff4aa
ARG MONOFS_REPO=https://github.com/radryc/monofs.git
ARG MONOFS_REF=ef7d9f5baded69cad046f8ea9d88f2fcf93bf7ce
ARG KVS_REPO=https://github.com/radryc/kvs.git
ARG KVS_REF=1cf406ad1da680ae06e3db84aa3a5aa3e95585b3
RUN set -eux; \
    fetch-source.sh "$GUARDIAN_REPO" "$GUARDIAN_REF" /src/guardian; \
    fetch-source.sh "$MONOFS_REPO" "$MONOFS_REF" /src/monofs; \
    fetch-source.sh "$KVS_REPO" "$KVS_REF" /src/kvs

FROM golang:1.26-alpine AS builder
RUN apk add --no-cache git ca-certificates
WORKDIR /src/guardian
COPY --from=source /src /src
RUN go mod download

RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -ldflags "-s -w" \
    -o /out/guardiand ./cmd/guardiand

FROM alpine:3.21

RUN apk add --no-cache ca-certificates

COPY --from=builder /out/guardiand /usr/local/bin/guardiand
COPY --from=source /src/guardian/docker/entrypoint.sh /usr/local/bin/guardian-entrypoint
RUN chmod +x /usr/local/bin/guardian-entrypoint

EXPOSE 8090

ENTRYPOINT ["/usr/local/bin/guardian-entrypoint"]
