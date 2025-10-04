FROM python:3.11-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential libgl1 && \
    rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /workspace
COPY pyproject.toml ./
RUN pip install --upgrade pip \
    && pip install --no-cache-dir ".[realtime_analyzer]"

FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends libgl1 && \
    rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app
COPY --from=builder $VIRTUAL_ENV $VIRTUAL_ENV

COPY realtime_analyzer/src ./src

CMD ["gunicorn", "--workers", "2", "--bind", "0.0.0.0:5002", "src.main:app"]
