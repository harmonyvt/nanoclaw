FROM debian:bookworm-slim

# Install Xvfb, Chromium, x11vnc, noVNC/websockify, fonts
RUN apt-get update && apt-get install -y \
    xvfb \
    chromium \
    x11vnc \
    novnc \
    websockify \
    socat \
    dbus-x11 \
    curl \
    fonts-liberation \
    fonts-noto-color-emoji \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create data directory for persistent chrome profile
RUN mkdir -p /data/chrome-profile

EXPOSE 9222 6080

COPY start.sh /start.sh
COPY rotate-vnc-pw.sh /rotate-vnc-pw.sh
RUN chmod +x /start.sh /rotate-vnc-pw.sh

ENTRYPOINT ["/start.sh"]
