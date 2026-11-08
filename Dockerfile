# MintWiki — single binary + one data directory.
# Build:  docker build -t mintwiki .
# Run:    docker compose up -d   (see docker-compose.yml)
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Pure-Go dependencies only (modernc SQLite), so the binary is static.
RUN CGO_ENABLED=0 go build -trimpath -o /out/mintwiki ./cmd/mintwiki

FROM debian:bookworm-slim
RUN useradd --system --home-dir /data mintwiki
COPY --from=build /out/mintwiki /usr/local/bin/mintwiki
COPY deploy/seed /seed
VOLUME /data
EXPOSE 8090
USER mintwiki
# Seed on every start: it is idempotent and only fills an empty wiki.
ENTRYPOINT ["sh", "-c", "mintwiki init --data /data && mintwiki seed --data /data --dir /seed && exec mintwiki serve --data /data --addr :8090"]
