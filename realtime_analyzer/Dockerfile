# Stage 1: ビルドステージ
FROM python:3.11-slim as builder

WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---
# Stage 2: 最終ステージ
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libgl1 \
    && rm -rf /var/lib/apt/lists/*

# ★★★ ここを修正しました: site-packagesだけでなく、binも含む/usr/localをコピー ★★★
COPY --from=builder /usr/local /usr/local

COPY ./src .

CMD ["gunicorn", "--workers", "2", "--bind", "0.0.0.0:5002", "main:app"]