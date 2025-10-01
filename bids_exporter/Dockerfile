# Stage 1: Build the virtual environment
FROM python:3.11-slim as builder

# Install poetry
ENV POETRY_HOME="/opt/poetry"
ENV PATH="$POETRY_HOME/bin:$PATH"
RUN apt-get update && apt-get install -y curl
RUN curl -sSL https://install.python-poetry.org | python3 -

WORKDIR /app
COPY pyproject.toml poetry.lock* ./

# Configure poetry to create the virtualenv in the project's root
RUN poetry config virtualenvs.in-project true

# Since there are no dev dependencies defined in pyproject.toml,
# the --without flag is not needed.
RUN poetry install --no-root

# Stage 2: Create the final image
FROM python:3.11-slim as stage-1

ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

WORKDIR /app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
# Copy the virtual environment from the builder stage
COPY --from=builder /app/.venv ./.venv
ENV PATH="/app/.venv/bin:$PATH"

# Copy the application source code
COPY ./src ./src

# Expose the port the app runs on
EXPOSE 8000

# Command to run the application
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]

