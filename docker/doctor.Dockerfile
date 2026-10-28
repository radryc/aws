# syntax=docker/dockerfile:1
# Standalone build: fetches the pinned public Strata source repositories.
FROM alpine:3.21 AS source
RUN apk add --no-cache git ca-certificates
COPY docker/fetch-source.sh /usr/local/bin/fetch-source.sh
RUN chmod +x /usr/local/bin/fetch-source.sh
ARG DOCTOR_REPO=https://github.com/radryc/doctor.git
ARG DOCTOR_REF=1e1294e4dc9c432fb99a523ae3ad019c24eb78da
ARG MONOFS_REPO=https://github.com/radryc/monofs.git
ARG MONOFS_REF=ef7d9f5baded69cad046f8ea9d88f2fcf93bf7ce
RUN set -eux; \
    fetch-source.sh "$DOCTOR_REPO" "$DOCTOR_REF" /src/doctor; \
    fetch-source.sh "$MONOFS_REPO" "$MONOFS_REF" /src/monofs

FROM golang:1.26-alpine AS builder
ARG DOCTOR_SERVICE=doctor-ingest
RUN apk add --no-cache git ca-certificates
WORKDIR /src/doctor
COPY --from=source /src /src
RUN go mod download

RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -ldflags "-s -w" \
    -o /out/doctor ./cmd/${DOCTOR_SERVICE}

FROM gcr.io/distroless/base-debian12

COPY --from=builder /out/doctor /doctor
ENTRYPOINT ["/doctor"]
