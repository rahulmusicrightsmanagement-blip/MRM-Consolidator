# MRM-Consolidator – one image: builds the React app, then serves it and the Django API with gunicorn.

# ---- 1. Build the frontend ----
FROM node:24-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --fetch-retries=5 --fetch-timeout=120000
COPY VERSION /app/VERSION
COPY frontend/ ./
RUN npm run build

# ---- 2. Python runtime ----
FROM python:3.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10 \
    MRM_DEBUG=0 \
    MRM_DATA_DIR=/data \
    MRM_FRONTEND_DIST=/app/frontend/dist

RUN useradd --create-home --uid 1000 mrm
WORKDIR /app/backend

COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/ ./
COPY VERSION /app/VERSION
COPY --from=frontend /app/frontend/dist /app/frontend/dist
COPY docker/entrypoint.sh /entrypoint.sh

# collectstatic only needs throwaway settings at build time (it does not touch the database).
RUN MRM_SECRET_KEY=build-only MRM_DATABASE_URL=postgresql://build@localhost/build python manage.py collectstatic --noinput -v 0 \
    && rm -rf media \
    && mkdir -p /data && chown -R mrm:mrm /data /app

USER mrm
VOLUME ["/data"]
EXPOSE 8010
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/', timeout=4)" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "mrm.wsgi:application", "--config", "/app/backend/gunicorn.conf.py"]
