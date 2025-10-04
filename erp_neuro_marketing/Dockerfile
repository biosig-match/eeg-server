# Python 3.11をベースイメージとして使用
FROM python:3.11-slim

# 作業ディレクトリを設定
WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# 必要なシステムライブラリをインストール (MNEなどが依存)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# プロジェクトのメタデータをコピーして依存関係をインストール
COPY pyproject.toml .
RUN pip install --upgrade pip && pip install --no-cache-dir ".[erp_neuro_marketing]"

# ソースコードをコピー
COPY ./erp_neuro_marketing/src /app/src

# サービスがリッスンするポート
EXPOSE 8001

# アプリケーションの起動コマンド
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]
