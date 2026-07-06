FROM rust:1.88-bookworm AS builder

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/browser-opt /usr/local/bin/browser-opt

ENV BROWSER_OPT_DB=/data/browser-opt.sqlite
EXPOSE 8765

CMD ["browser-opt", "native-host-server", "--listen", "0.0.0.0:8765"]
